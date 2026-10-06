'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {retryable, eligible, stateResult, claim} = require('./rewards-state.cjs');
const createDiagnostics = require('./rewards-diagnostics.cjs');
test('TOTP failures remain diagnosable privately and never retry after an earlier network error', () => {
  const diagnostic={stage:null,loginState:null,errors:[]};
  const diagnose=createDiagnostics(diagnostic);
  diagnose('[WARN] MOBILE [LOGIN] net::ERR_EMPTY_RESPONSE');
  diagnose('[ERROR] MOBILE [LOGIN-TOTP] TOTP verification was rejected');
  const result=stateResult({status:'failed',errorCode:'FLOW_FAILED',diagnostic});
  assert.equal(result.retryable,false);
  assert.equal(result.diagnostic.stage,'LOGIN-TOTP');
  assert.ok(result.diagnostic.errors.includes('TOTP_REJECTED'));
});
test('retry only technical failures, never success or unverified completion', () => {
  assert.equal(retryable({status:'failed',errorCode:'NETWORK_TIMEOUT'}),true);
  assert.equal(retryable({status:'failed',errorCode:'ACCOUNT_TIMEOUT'}),true);
  assert.equal(retryable({status:'completed',errorCode:'NETWORK_TIMEOUT'}),false);
  assert.equal(retryable({status:'failed',errorCode:'FLOW_FAILED'}),false);
  assert.equal(retryable({status:'failed',errorCode:'SETUP_FAILED'}),false);
});
test('authentication and lock errors override transient errors', () => {
  for(const label of ['AUTH_REQUIRED','BOT_WARNING','ACCOUNT_LOCKED','MICROSOFT_LOGIN_ERROR']) {
    assert.equal(retryable({status:'failed',errorCode:'ACCOUNT_TIMEOUT',diagnostic:{errors:[label]}}),false);
  }
});
test('classified browser network errors qualify', () => {
  assert.equal(retryable({status:'failed',errorCode:'FLOW_FAILED',diagnostic:{errors:['ERR_PROXY_CONNECTION_FAILED']}}),true);
});
test('same-day account matching and one retry reservation', () => {
  const s={schema:1,date:'2026-09-26',accountId:2,morning:{status:'failed',retryable:true}};
  assert.equal(eligible(s,'2026-09-26',2),true);
  assert.equal(eligible(s,'2026-09-27',2),false);
  assert.equal(eligible(s,'2026-09-26',1),false);
  assert.equal(eligible({...s,retry:{status:'running'}},'2026-09-26',2),false);
  assert.equal(eligible(null,'2026-09-26',2),false);
});
test('stored result excludes balances, email, TOTP and raw diagnostics', () => {
  const s=stateResult({status:'failed',errorCode:'NETWORK_TIMEOUT',email:'private',totp:'private',pointsEarned:99,diagnostic:{raw:'private'}});
  assert.deepEqual(s,{status:'failed',retryable:true,errorCode:'NETWORK_TIMEOUT'});
});
test('private diagnostics retain recognized labels but drop every raw field', () => {
  const s=stateResult({status:'failed',errorCode:'FLOW_FAILED',diagnostic:{
    stage:'LOGIN',loginState:'ERROR_ALERT',email:'do-not-store@example.test',
    raw:'secret text',url:'https://example.test/?token=secret',
    errors:['MICROSOFT_LOGIN_UNKNOWN_ERROR','secret text','MICROSOFT_LOGIN_UNKNOWN_ERROR']
  }});
  assert.deepEqual(s.diagnostic,{stage:'LOGIN',loginState:'ERROR_ALERT',errors:['MICROSOFT_LOGIN_UNKNOWN_ERROR']});
  assert.equal(s.retryable,false);
  assert.ok(!JSON.stringify(s).includes('secret'));
});
test('unknown diagnostic values are omitted without widening retry eligibility', () => {
  const s=stateResult({status:'failed',errorCode:'FLOW_FAILED',diagnostic:{
    stage:'private account',loginState:'private token',errors:['unknown error']
  }});
  assert.equal(s.diagnostic,undefined);
  assert.equal(s.retryable,false);
  const technical=stateResult({status:'failed',errorCode:'FLOW_FAILED',diagnostic:{
    stage:'SEARCH-BING',errors:['ERR_PROXY_CONNECTION_FAILED']
  }});
  assert.equal(technical.retryable,true);
  assert.deepEqual(technical.diagnostic.errors,['ERR_PROXY_CONNECTION_FAILED']);
});
test('claim is persisted before authorization and cannot be claimed twice', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-06T08:00:00Z'));
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'state-test-'));
  const prev={...process.env}, oldFetch=global.fetch;
  const date=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
  let state={schema:1,date,accountId:2,morning:{status:'failed',retryable:true}}, puts=0;
  try {
    Object.assign(process.env,{RUN_DATE:date,ACCOUNT_SLOT:'2',RUN_MODE:'retry',REWARDS_STATE_TOKEN:'synthetic',REWARDS_PRIVATE_REPO:'example/private-state',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:path.join(tmp,'out')});
    global.fetch=async (url,options) => {
      let body;
      if(options.method==='PUT') { state=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64')); puts++; body={}; }
      else if(url.endsWith('/example/private-state')) body={private:true};
      else if(url.includes('/branches/')) body={name:'rewards-state'};
      else body={sha:'old',content:Buffer.from(JSON.stringify(state)).toString('base64')};
      return {ok:true,status:200,json:async()=>body};
    };
    await claim();
    assert.equal(puts,1);
    assert.equal(state.retry.status,'running');
    assert.ok(fs.readFileSync(process.env.GITHUB_OUTPUT,'utf8').includes('run=true'));
    fs.writeFileSync(process.env.GITHUB_OUTPUT,'');
    await claim();
    assert.equal(puts,1);
    assert.equal(fs.readFileSync(process.env.GITHUB_OUTPUT,'utf8'),'run=false\n');
  } finally { global.fetch=oldFetch; for(const k of Object.keys(process.env)) if(!(k in prev))delete process.env[k]; Object.assign(process.env,prev);fs.rmSync(tmp,{recursive:true,force:true}); }
});
test('post-fix check-in allowance requires verified authentication and remains bounded', async (t) => {
 t.mock.method(Date,'now',()=>Date.parse('2026-10-06T09:00:00Z'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-state-')),previous={...process.env},oldFetch=global.fetch;
 let state={schema:1,date:'2026-10-06',accountId:1,'app-test':{status:'failed',checkInVerified:false,history:[{},{}]},'app-auth-probe':{authVerified:false}},puts=0;
 try{
  Object.assign(process.env,{RUN_DATE:state.date,ACCOUNT_SLOT:'1',RUN_MODE:'app-test',REWARDS_STATE_TOKEN:'fixture',REWARDS_PRIVATE_REPO:'example/private-state',GITHUB_RUN_ID:'2',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:path.join(dir,'out')});
  global.fetch=async(url,options={})=>{
   let body;
   if(options.method==='PUT'){state=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));puts++;body={};}
   else if(url.endsWith('/example/private-state'))body={private:true};
   else if(url.includes('/branches/'))body={name:'rewards-state'};
   else body={sha:'fixture',content:Buffer.from(JSON.stringify(state)).toString('base64')};
   return {ok:true,status:200,json:async()=>body};
  };
  await claim();assert.equal(puts,0);
  state['app-auth-probe'].history=[{authVerified:true}];await claim();assert.equal(puts,1);assert.equal(state['app-test'].history.length,3);
  state['app-test'].status='failed';await claim();assert.equal(puts,2);assert.equal(state['app-test'].history.length,4);
  state['app-test'].status='failed';await claim();assert.equal(puts,3);assert.equal(state['app-test'].history.length,5);
  state['app-test'].status='failed';await claim();assert.equal(puts,4);assert.equal(state['app-test'].history.length,6);
  state['app-test'].status='failed';await claim();assert.equal(puts,5);assert.equal(state['app-test'].history.length,7);
  state['app-test'].status='failed';await claim();assert.equal(puts,6);assert.equal(state['app-test'].history.length,8);
  state['app-test'].status='failed';await claim();assert.equal(puts,6);
  state['app-test'].errorCode='SETUP_FAILED';await claim();assert.equal(puts,7);assert.equal(state['app-test'].history.length,9);
  state['app-test'].status='failed';state['app-test'].errorCode='SETUP_FAILED';await claim();assert.equal(puts,7);
 }finally{global.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);fs.rmSync(dir,{recursive:true,force:true});}
});

test('one controlled transport probe remains available after a failed check-in, with a fixed daily cap', async (t) => {
 t.mock.method(Date,'now',()=>Date.parse('2026-10-06T09:00:00Z'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'probe-state-')),previous={...process.env},oldFetch=global.fetch;
 let state={schema:1,date:'2026-10-06',accountId:1,'app-test':{status:'failed',checkInVerified:false},'app-auth-probe':{status:'completed',authVerified:true,history:[{},{},{},{}]}},puts=0;
 try{
  Object.assign(process.env,{RUN_DATE:state.date,ACCOUNT_SLOT:'1',RUN_MODE:'app-auth-probe',REWARDS_STATE_TOKEN:'fixture',REWARDS_PRIVATE_REPO:'example/private-state',GITHUB_RUN_ID:'2',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:path.join(dir,'out')});
  global.fetch=async(url,options={})=>{
   let body;
   if(options.method==='PUT'){state=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));puts++;body={};}
   else if(url.endsWith('/example/private-state'))body={private:true};
   else if(url.includes('/branches/'))body={name:'rewards-state'};
   else body={sha:'fixture',content:Buffer.from(JSON.stringify(state)).toString('base64')};
   return {ok:true,status:200,json:async()=>body};
  };
  await claim();assert.equal(puts,1);assert.equal(state['app-auth-probe'].history.length,5);
  state['app-auth-probe'].status='failed';await claim();assert.equal(puts,1);
  state['app-auth-probe'].history=[];state['app-test'].checkInVerified=true;await claim();assert.equal(puts,1);
 }finally{global.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);fs.rmSync(dir,{recursive:true,force:true});}
});

test('private reports stay scoped to this run and never contain identity', async () => {
  const prev = {...process.env}, oldFetch = global.fetch;
  const {savePrivateReport, readPrivateReports} = require('./rewards-state.cjs');
  const files = new Map(), routes = [];
  try {
    Object.assign(process.env, {REWARDS_PRIVATE_REPO:'example/private-state', REWARDS_STATE_TOKEN:'synthetic',
      RUN_DATE:'2026-10-06', GITHUB_RUN_ID:'123', GITHUB_RUN_ATTEMPT:'2', ACCOUNT_SLOT:'1'});
    global.fetch = async (url, options = {}) => {
      routes.push(url);
      if (url.endsWith('/example/private-state')) return {ok:true,status:200,json:async()=>({private:true})};
      if (url.includes('/branches/')) return {ok:true,status:200,json:async()=>({name:'rewards-state'})};
      const route = url.split('?')[0];
      if (options.method === 'PUT') {
        const payload = JSON.parse(options.body);
        files.set(route,{sha:'test',content:payload.content});
        return {ok:true,status:200,json:async()=>({})};
      }
      return {ok:files.has(route),status:files.has(route)?200:404,json:async()=>files.get(route)};
    };
    await savePrivateReport({accountId:1,date:'2026-10-06',status:'completed',pointsEarned:0,
      initialBalance:100,finalBalance:100,email:'private@example.test',token:'do-not-store'});
    const stored = JSON.parse(Buffer.from([...files.values()][0].content,'base64').toString());
    assert.equal(stored.pointsEarned,0);
    assert.equal(stored.email,undefined);
    assert.equal(stored.token,undefined);
    const reports = await readPrivateReports({account_1:{result:'success'},account_2:{result:'success'}});
    assert.equal(JSON.parse(reports.account_1.outputs.result).finalBalance,100);
    assert.equal(reports.account_2.outputs.result,'');
    assert.ok(routes.filter(x=>x.includes('/reports/')).every(x=>x.includes('/run-123-attempt-2/')));
    process.env.GITHUB_RUN_ATTEMPT='3';
    assert.equal((await readPrivateReports({})).account_1.outputs.result,'');
    await assert.rejects(savePrivateReport({...stored,accountId:2}), /Invalid private report/);
    global.fetch=async()=>({ok:true,status:200,json:async()=>({private:false})});
    await assert.rejects(savePrivateReport(stored),/must be private/);
    delete process.env.REWARDS_STATE_TOKEN;
    await assert.rejects(readPrivateReports({}),/requires state credentials/);
  } finally {
    global.fetch=oldFetch;
    for(const k of Object.keys(process.env)) if(!(k in prev)) delete process.env[k];
    Object.assign(process.env,prev);
  }
});

test('user-authorized reading continuation is bounded and requires an explicit rejected POST',async(t)=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-07T00:10:00+07:00'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'read-state-')),prev={...process.env},oldFetch=global.fetch;
 let state={schema:1,date:'2026-10-07',accountId:1,'app-read-test':{status:'needs_action',errorCode:'HTTP_401'}},puts=0;
 try{
 Object.assign(process.env,{RUN_DATE:state.date,ACCOUNT_SLOT:'1',RUN_MODE:'app-read-test',REWARDS_STATE_TOKEN:'fixture',REWARDS_PRIVATE_REPO:'example/private-state',GITHUB_RUN_ID:'2',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:path.join(dir,'out')});
 global.fetch=async(url,options={})=>{let body;if(options.method==='PUT'){state=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));puts++;body={};}else if(url.includes('/reports/'))body={sha:'fixture',content:Buffer.from(JSON.stringify({date:state.date,accountId:1,pointsEarned:0,initialBalance:100,finalBalance:100})).toString('base64')};else if(url.endsWith('/example/private-state'))body={private:true};else if(url.includes('/branches/'))body={name:'rewards-state'};else body={sha:'fixture',content:Buffer.from(JSON.stringify(state)).toString('base64')};return {ok:true,status:200,json:async()=>body};};
 await claim();assert.equal(puts,1);assert.equal(state['app-read-test'].history.length,1);
 await claim();assert.equal(puts,1);
 state['app-read-test'].status='needs_action';state['app-read-test'].errorCode='HTTP_401';await claim();assert.equal(puts,2);
 state['app-read-test'].status='needs_action';state['app-read-test'].errorCode='HTTP_401';await claim();assert.equal(puts,3);
 state['app-read-test'].status='needs_action';state['app-read-test'].errorCode='HTTP_401';await claim();assert.equal(puts,4);
 state['app-read-test'].status='needs_action';state['app-read-test'].errorCode='HTTP_401';await claim();assert.equal(puts,4);
 state['app-read-test']={status:'completed',errorCode:null};await claim();assert.equal(puts,4);
 state['app-read-test']={status:'failed',errorCode:'NETWORK_TIMEOUT'};await claim();assert.equal(puts,4);
 }finally{global.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in prev))delete process.env[k];Object.assign(process.env,prev);fs.rmSync(dir,{recursive:true,force:true});}
});

test('reading budget subtracts only verified private receipts and stops at the daily target',async(t)=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-07T00:10:00+07:00'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reading-budget-')),prev={...process.env},oldFetch=global.fetch;
 let state={schema:1,date:'2026-10-07',accountId:1,'app-read-test':{status:'failed',errorCode:'HTTP_401',runId:'101',runAttempt:'1',history:[{runId:'100',runAttempt:'1'}]}},puts=0;
 const receipts={'100':{date:state.date,accountId:1,pointsEarned:3,initialBalance:100,finalBalance:103},'101':{date:state.date,accountId:1,pointsEarned:3,initialBalance:103,finalBalance:106}};
 try{
 Object.assign(process.env,{RUN_DATE:state.date,ACCOUNT_SLOT:'1',RUN_MODE:'app-read-test',RUNNER_TEMP:dir,REWARDS_STATE_TOKEN:'fixture',REWARDS_PRIVATE_REPO:'example/private-state',GITHUB_RUN_ID:'102',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:path.join(dir,'out')});
 global.fetch=async(url,options={})=>{let body;if(options.method==='PUT'){state=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));puts++;body={};}else if(url.includes('/reports/')){const id=/run-(\d+)-attempt/.exec(url)[1];body={sha:'fixture',content:Buffer.from(JSON.stringify(receipts[id])).toString('base64')};}else if(url.endsWith('/example/private-state'))body={private:true};else if(url.includes('/branches/'))body={name:'rewards-state'};else body={sha:'fixture',content:Buffer.from(JSON.stringify(state)).toString('base64')};return {ok:true,status:200,json:async()=>body};};
 await claim();assert.equal(puts,1);assert.equal(state['app-read-test'].readingPointsBudget,24);
 const budget=JSON.parse(fs.readFileSync(path.join(dir,'rewards-private/reading-budget.json')));
 assert.equal(budget.points,24);assert.equal(budget.accountId,1);
 const env=require('./rewards-runner.cjs').childEnvironment({...process.env,ACCOUNT_EMAIL:'fixture@example.invalid'},1);
 assert.equal(env.REWARDS_READING_POINTS_BUDGET,'24');
 }finally{global.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in prev))delete process.env[k];Object.assign(process.env,prev);fs.rmSync(dir,{recursive:true,force:true});}
});

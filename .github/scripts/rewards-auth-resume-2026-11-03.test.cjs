'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const resume = require('./rewards-auth-resume-2026-11-03.cjs'), api = require('./rewards-state.cjs');
const at = time => Date.parse(resume.DATE+'T'+time+'+07:00');
const now = at('12:00:00');
const scope = {RUN_DATE:resume.DATE,RUN_MODE:'retry',ACCOUNT_SLOT:'2',AUTH_RESUME_APPROVED:resume.APPROVAL,GITHUB_RUN_ID:'999',GITHUB_RUN_ATTEMPT:'1'};
const counts = {completed:0,incomplete:0,unavailable:0,notApplicable:0};
const saved = {schema:1,date:resume.DATE,accountId:2,searchReview:{mobile:{points:0,target:60,verified:true},desktop:{points:0,target:90,verified:true}},morning:{runId:resume.PRIOR_RUN,runAttempt:'1',status:'failed',errorCode:'AUTH_REQUIRED',diagnostic:{stage:'LOGIN'},finishedAt:resume.DATE+'T01:00:00+07:00'}};
function event(run,title,message,data,level='info') {return '__REWARDS_EVENT__ '+JSON.stringify({version:2,runId:`${resume.DATE}:2:${run}`,ts:resume.DATE+'T11:45:00+07:00',platform:'DESKTOP',title,message,data,level});}
const oldLog = event(resume.PRIOR_RUN,'ACCOUNT-END','failed',{kind:'account',status:'failed',pointsKnown:false,reason:'Microsoft login error: fixture',completion:{counts}});
const loginLog = [event(resume.AUTH_RUN,'LOGIN-TOTP','TOTP challenge advanced; continuing login verification'),event(resume.AUTH_RUN,'LOGIN-STATE','state=LOGGED_IN'),event(resume.AUTH_RUN,'ACCOUNT-END','done',{kind:'account',status:'completed',pointsKnown:true,initialPoints:100,currentBalance:100,pointsGained:0,completion:{counts}})].join('\n');
test('post-update retry is bounded to this account/date, fresh TOTP proof, first attempt and normal daily deadline', () => {
  assert.equal(resume.authorized(scope,now),true);
  for (const change of [{ACCOUNT_SLOT:'1'},{RUN_DATE:'2026-11-04'},{RUN_MODE:'morning'},{AUTH_RESUME_APPROVED:''},{GITHUB_RUN_ATTEMPT:'2'}])
    assert.equal(resume.authorized({...scope,...change},now),false);
  assert.equal(resume.authorized(scope,at('21:00:01')),false);
  assert.equal(resume.verifiedAuthorization(saved,oldLog,loginLog,now),true);
  assert.equal(resume.verifiedAuthorization(saved,oldLog,loginLog,at('13:16:00')),false);
});
test('evidence rejects wrong account, reused claims, errors, earning activity and unconfirmed TOTP', () => {
  for (const state of [{...saved,accountId:3},{...saved,retry:null},{...saved,reconcile:{status:'completed'}},{...saved,'app-test':{runId:'456'}},{...saved,morning:{...saved.morning,status:'running'}},{...saved,morning:{...saved.morning,errorCode:'ACCOUNT_LOCKED'}}])
    assert.equal(resume.verifiedAuthorization(state,oldLog,loginLog,now),false);
  for (const log of [loginLog.replaceAll(resume.AUTH_RUN,'123'),loginLog.replace('"pointsGained":0','"pointsGained":1'),loginLog.replace('state=LOGGED_IN','state=ERROR_ALERT'),loginLog.replace('TOTP challenge advanced','TOTP rejected'),loginLog+'\n'+event(resume.AUTH_RUN,'LOGIN','failed',null,'error'),loginLog+'\n'+event(resume.AUTH_RUN,'ACTIVITY','done',{kind:'activity'})])
    assert.equal(resume.verifiedAuthorization(saved,oldLog,log,now),false);
  assert.equal(resume.verifiedAuthorization(saved,oldLog.replace('"completed":0','"completed":1'),loginLog,now),false);
});
test('claim preserves morning, uses SHA lease, seeds verified unused budgets and cannot be reused', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'auth-resume-')), previous = {...process.env}; let record = structuredClone(saved); const writes=[];
  try {
    Object.assign(process.env,scope,{RUNNER_TEMP:dir,GITHUB_OUTPUT:dir+'/out'});
    t.mock.method(Date,'now',()=>now);t.mock.method(api,'requirePrivateReports',async()=>{});
    t.mock.method(api,'api',async(route,options={})=>{
      if(options.method==='PUT') {const body=JSON.parse(options.body);writes.push({route,body});record=JSON.parse(Buffer.from(body.content,'base64'));return {};}
      return {sha:'expected-sha',content:Buffer.from(route.includes('/state/')?JSON.stringify(record):route.includes('/diagnostics/')?loginLog:oldLog).toString('base64')};
    });
    await resume.claim();assert.equal(writes.length,1);assert.equal(writes[0].body.sha,'expected-sha');
    assert.deepEqual(record.morning,saved.morning);assert.deepEqual(record.searchReview,saved.searchReview);
    assert.equal(record.retry.status,'running');assert.equal(record.retry.authDiagnosticRunId,resume.AUTH_RUN);
    assert.deepEqual(JSON.parse(fs.readFileSync(dir+'/rewards-private/reading-budget.json')),{date:resume.DATE,accountId:2,points:30,verified:true});
    await assert.rejects(resume.claim());assert.equal(writes.length,1);
  } finally {for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);fs.rmSync(dir,{recursive:true,force:true});}
});
test('SHA conflict or missing authentication evidence never authorizes execution',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auth-conflict-')),previous={...process.env};
  try {
    Object.assign(process.env,scope,{RUNNER_TEMP:dir,GITHUB_OUTPUT:dir+'/out'});
    t.mock.method(Date,'now',()=>now);t.mock.method(api,'requirePrivateReports',async()=>{});
    t.mock.method(api,'api',async(route,options={})=>{
      if(options.method==='PUT')throw new Error('SHA conflict');
      return {sha:'stale-sha',content:Buffer.from(route.includes('/state/')?JSON.stringify(saved):route.includes('/diagnostics/')?loginLog:oldLog).toString('base64')};
    });
    await assert.rejects(resume.claim());assert.equal(fs.existsSync(dir+'/out'),false);
  } finally {for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);fs.rmSync(dir,{recursive:true,force:true});}
});

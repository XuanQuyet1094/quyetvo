'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const state = require('./rewards-state.cjs');
const ops = require('./rewards-operations.cjs');
test('delivery ledger prevents duplicate sends and retries only confirmed rejection', async () => {
  const previous={...process.env}, api=state.api, requirePrivate=state.requirePrivateReports;
  const files=new Map();let revision=0,sends=0;
  try {
    Object.assign(process.env,{REWARDS_STATE_TOKEN:'synthetic',TELEGRAM_CHAT_ID:'synthetic-chat',RUN_DATE:'2026-10-06',GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1'});
    state.requirePrivateReports=async()=>{};
    state.api=async(route,options={})=>{
      const key=route.split('?')[0];
      if(options.method==='PUT') {
        const body=JSON.parse(options.body),old=files.get(key);
        if(old && old.sha!==body.sha) throw new Error('SHA conflict');
        const file={sha:String(++revision),content:body.content};files.set(key,file);return {content:{sha:file.sha}};
      }
      return files.get(key)||null;
    };
    await ops.enqueue('account-1','private report');
    const send=async()=>{sends++;};
    assert.equal(await ops.deliver('account-1',send),'sent');
    await ops.enqueue('account-1','different report');
    await ops.deliver('account-1',send);assert.equal(sends,1);
    await ops.enqueue('account-2','second');
    await assert.rejects(ops.deliver('account-2',async()=>{sends++;throw Object.assign(new Error('rejected'),{definitelyNotDelivered:true});}),/retry is available/);
    assert.equal(await ops.deliver('account-2',send),'sent');
    assert.equal(sends,3);
    await ops.enqueue('account-3','third');
    await assert.rejects(ops.deliver('account-3',async()=>{sends++;throw new Error('timeout');}),/uncertain/);
    assert.equal(await ops.deliver('account-3',send),'uncertain');assert.equal(sends,4);
    await ops.enqueue('account-4','fourth');
    await Promise.allSettled([ops.deliver('account-4',send),ops.deliver('account-4',send)]);
    assert.equal(sends,5);
    process.env.TELEGRAM_CHAT_ID='another-chat';
    await assert.rejects(ops.deliver('account-1',send),/Invalid saved notification/);
  } finally {
    state.api=api;state.requirePrivateReports=requirePrivate;
    for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
  }
});
test('retention touches log folders only and respects Vietnam midnight',()=>{
  const entry=p=>({path:p,type:'blob'});
  const tree={tree:['logs/2026-10-03/a.log','logs/2026-10-04/a.log','diagnostics/2026-10-02/a.log',
    'setup-logs/2026-10-01/a.log','state/2026-10-01/account-1.json','reports/2026-10-01/a.log',
    'notifications/2026-10-01/a.json','logs/not-a-date/a.log'].map(entry)};
  assert.deepEqual(ops.expiredLogPaths(tree,new Date('2026-10-05T17:00:00Z')),
    ['logs/2026-10-03/a.log','diagnostics/2026-10-02/a.log','setup-logs/2026-10-01/a.log']);
  assert.throws(()=>ops.expiredLogPaths({...tree,truncated:true}),/Incomplete/);
});
test('cleanup uses a non-forced update and preserves concurrent private state',async()=>{
  const api=state.api,requirePrivate=state.requirePrivateReports,calls=[];
  try {
    state.requirePrivateReports=async()=>{};
    state.api=async(route,options={})=>{
      calls.push({route,options});
      if(route.includes('/ref/heads/'))return {object:{sha:'old'}};
      if(route==='/git/commits/old')return {tree:{sha:'tree'}};
      if(route.includes('recursive'))return {tree:[{type:'blob',path:'logs/2000-01-01/test.log'}]};
      if(route==='/git/trees')return {sha:'new-tree'};
      if(route==='/git/commits')return {sha:'new-commit'};
      if(options.method==='PATCH')throw new Error('Concurrent branch update');
    };
    await assert.rejects(ops.cleanup(),/Concurrent/);
    const body=JSON.parse(calls.find(c=>c.options.method==='PATCH').options.body);
    assert.equal(body.force,false);
    assert.deepEqual(JSON.parse(calls.find(c=>c.route==='/git/commits').options.body).parents,['old']);
  } finally {state.api=api;state.requirePrivateReports=requirePrivate;}
});
test('build captures and redacts failures without printing child output',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-build-'));
  const log=console.log,error=console.error,publicLines=[];
  console.log=(...args)=>publicLines.push(args.join(' '));console.error=(...args)=>publicLines.push(args.join(' '));
  try {
    const env={...process.env,RUNNER_TEMP:tmp,BOT_DIR:tmp,ACCOUNT_SLOT:'1',PRIVATE_REPO_TOKEN:'synthetic-sensitive-token'};
    await assert.rejects(ops.quietBuild(env,[['Build',process.execPath,['-e',"console.log('synthetic-sensitive-token');process.exitCode=1"]]]),/Private setup failed/);
    assert.ok(!publicLines.join('\n').includes('synthetic-sensitive-token'));
    const captured=fs.readFileSync(path.join(tmp,'rewards-private/setup-account-1.log'),'utf8');
    assert.ok(captured.includes('[REDACTED]'));assert.ok(!captured.includes('synthetic-sensitive-token'));
  } finally {console.log=log;console.error=error;fs.rmSync(tmp,{recursive:true,force:true});}
});
test('preflight verifies private write/read credentials and Telegram without sending messages',async()=>{
  const prev={...process.env},api=state.api,requirePrivate=state.requirePrivateReports,fetch=global.fetch,calls=[];
  try {
    Object.assign(process.env,{ACCOUNT_EMAIL:'synthetic@example.test',ACCOUNT_PASSWORD:'synthetic',REWARDS_PRIVATE_REPO:'example/private',REWARDS_STATE_TOKEN:'synthetic',PRIVATE_REPO_TOKEN:'synthetic',TELEGRAM_BOT_TOKEN:'synthetic',TELEGRAM_CHAT_ID:'synthetic',AZDIGI_SSH_HOST:'synthetic.example',AZDIGI_SSH_USER:'synthetic',AZDIGI_SSH_PORT:'22',AZDIGI_SSH_KEY:'synthetic',AZDIGI_KNOWN_HOSTS:'synthetic',RUN_DATE:'2026-10-06',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1'});
    state.requirePrivateReports=async()=>{};
    state.api=async(route,options)=>{calls.push(options.method);return {content:{sha:'probe'}};};
    global.fetch=async(url)=>{calls.push(url);return {ok:true,json:async()=>url.includes('api.github.com')?{private:true}:{ok:true}};};
    await ops.preflight();assert.ok(calls.includes('PUT'));assert.ok(calls.includes('DELETE'));
    assert.ok(!calls.some(c=>c.includes('sendMessage')));assert.ok(calls.some(c=>c.endsWith('/getChat')));
    delete process.env.ACCOUNT_PASSWORD;delete process.env.ACCOUNT_TOTP_SECRET;
    await assert.rejects(ops.preflight(),/Missing account authentication/);
    process.env.ACCOUNT_PASSWORD='synthetic';
    state.api=async()=>{throw new Error('Write access denied');};
    await assert.rejects(ops.preflight(),/Write access denied/);
  } finally {state.api=api;state.requirePrivateReports=requirePrivate;global.fetch=fetch;for(const key of Object.keys(process.env))if(!(key in prev))delete process.env[key];Object.assign(process.env,prev);}
});

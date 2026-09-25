'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {retryable, eligible, stateResult, claim} = require('./rewards-state.cjs');
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
test('claim is persisted before authorization and cannot be claimed twice', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'state-test-'));
  const prev={...process.env}, oldFetch=global.fetch;
  const date=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
  let state={schema:1,date,accountId:2,morning:{status:'failed',retryable:true}}, puts=0;
  try {
    Object.assign(process.env,{RUN_DATE:date,ACCOUNT_SLOT:'2',RUN_MODE:'retry',REWARDS_STATE_TOKEN:'synthetic',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:path.join(tmp,'out')});
    global.fetch=async (url,options) => {
      let body;
      if(options.method==='PUT') { state=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64')); puts++; body={}; }
      else if(url.endsWith('/Microsoft-Rewards-Script')) body={private:true};
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

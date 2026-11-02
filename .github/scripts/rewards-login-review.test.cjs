'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {confirmedFormTimeout,selectionView} = require('./rewards-login-review.cjs');
const {eligible} = require('./rewards-state.cjs');
const entry = {status:'failed',errorCode:'AUTH_REQUIRED',runId:'42',runAttempt:'1',diagnostic:{errors:['TIMEOUT','UNCLASSIFIED_ERROR']}};
const ctx = {date:'2026-11-02',slot:3,mode:'retry'};
const event = data => '[stdout] __REWARDS_EVENT__ ' + JSON.stringify({version:2,runId:'2026-11-02:3:42',ts:'2026-11-02T01:00:00Z',...data});
const log = [event({level:'error',title:'LOGIN-ENTER-EMAIL',message:'locator.fill: Timeout 30000ms exceeded; element was detached from the DOM'}),
  event({data:{kind:'account',status:'failed',reason:'Login failed or aborted at state: EMAIL_INPUT'}})].join('\n');
test('legacy v5 form timeout gets one guarded selection correction without editing the original claim',async()=>{
 const state={schema:1,date:ctx.date,accountId:3,morning:entry},before=JSON.stringify(state);
 const view=await selectionView(state,ctx,async()=>log);
 assert.equal(view.morning.errorCode,'LOGIN_TRANSIENT_ERROR');assert.equal(eligible(view,ctx.date,3),true);
 assert.equal(JSON.stringify(state),before);assert.equal(eligible({...view,retry:{status:'running'}},ctx.date,3),false);
 assert.equal(eligible({...view,retry:{status:'failed'}},ctx.date,3),false);
});
test('missing, mismatched, real authentication and conflicting evidence never relax the guard',()=>{
 assert.equal(confirmedFormTimeout(entry,'',ctx.date,3),false);
 assert.equal(confirmedFormTimeout(entry,log,ctx.date,2),false);
 assert.equal(confirmedFormTimeout(entry,log.replaceAll(':42',':43'),ctx.date,3),false);
 assert.equal(confirmedFormTimeout({...entry,diagnostic:{errors:['TIMEOUT','MICROSOFT_LOGIN_ERROR']}},log,ctx.date,3),false);
 assert.equal(confirmedFormTimeout(entry,log+'\n'+event({level:'error',title:'LOGIN',message:'TOTP rejected'}),ctx.date,3),false);
 assert.equal(confirmedFormTimeout({...entry,status:'running'},log,ctx.date,3),false);
});

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

test('confirmed post-login dashboard 503 permits retry without changing claims', async()=>{
 const e={...entry,diagnostic:{loginState:'LOGGED_IN',errors:['UNCLASSIFIED_ERROR']}};
 const state={schema:1,date:ctx.date,accountId:3,morning:e}, before=JSON.stringify(state);
 const row=(title,message,level='warn',platform='MOBILE')=>event({title,message,level,platform});
 const lines=[row('LOGIN','Successfully logged in','info'),
  row('BOOTSTRAP','Failed to fetch /earn HTML | status=503 - snapshot incomplete'),
  row('BOOTSTRAP','Failed to fetch /dashboard HTML | status=503 - snapshot incomplete'),
  event({data:{kind:'account',status:'failed',reason:'Failed to acquire rewards context: Rewards dashboard did not render (no section#dailyset) - likely a login/redirect issue, aborting'}})];
 const review=async log=>selectionView(state,ctx,async()=>log.join('\n'));
 const view=await review(lines);
 assert.equal(view.morning.errorCode,'HTTP_503');assert.equal(eligible(view,ctx.date,3),true);
 assert.equal(JSON.stringify(state),before);assert.equal(eligible({...view,retry:{status:'completed'}},ctx.date,3),false);
 for (const bad of [lines.slice(1), [lines[0],lines[1],lines[3]],
  [lines[0],lines[1],row('BOOTSTRAP','Failed to fetch /dashboard HTML | status=403'),lines[3]],
  [lines[0],lines[1],row('BOOTSTRAP','Failed to fetch /dashboard HTML | status=503','warn','DESKTOP'),lines[3]],
  [lines[0],lines[1],lines[2],row('LOGIN','TOTP rejected','error'),lines[3]]])
  assert.equal((await review(bad)).morning.errorCode,'AUTH_REQUIRED');
});
test('v5 result adapter recognizes only the explicit dashboard bootstrap marker',()=>{
 const {failure}=require('./rewards-v5-events.cjs');
 assert.equal(failure('Failed to acquire rewards context: REWARDS_BOOTSTRAP_HTTP_503: /earn and /dashboard unavailable'),'HTTP_503');
 assert.equal(failure('Microsoft login error 503'), 'AUTH_REQUIRED');
 assert.equal(failure('Failed to acquire rewards context: Rewards dashboard did not render (no section#dailyset) - likely a login/redirect issue, aborting'),'AUTH_REQUIRED');
});

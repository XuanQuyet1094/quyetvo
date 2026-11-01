'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {collector,failure}=require('./rewards-v5-events.cjs');
const env={RUN_DATE:'2026-11-01',ACCOUNT_EMAIL:'fixture@example.invalid',REWARDS_RUN_ID:'fixture-run'};
const make=(data,platform='MAIN',overrides={})=>'__REWARDS_EVENT__ '+JSON.stringify({version:2,runId:env.REWARDS_RUN_ID,
  user:env.ACCOUNT_EMAIL,ts:'2026-11-01T00:00:00.000Z',platform,title:'ACTIVITY-RESULT',level:'info',message:'synthetic',data,...overrides});
const act=(activity,reason,extra={})=>({kind:'activity',activity,reason,status:'confirmed',pointsKnown:true,pointsGained:0,...extra});
test('v5 rejects a different account, run, date, schema, malformed and oversized events',()=>{
 const c=collector(env,1);
 for(const x of [{user:'other@example.invalid'},{runId:'other'},{version:1},{ts:'2026-10-31T00:00:00Z'},{platform:'invalid'}])
   assert.equal(c.accept(make(act('search','quota-complete'),'MOBILE',x)),null);
 assert.equal(c.accept('__REWARDS_EVENT__ {'),null);
 assert.equal(c.accept('__REWARDS_EVENT__ '+ 'x'.repeat(262145)),null);
});
test('v5 separates process completion, verified points and incomplete tasks',()=>{
 const c=collector(env,1);
 c.accept(make(act('search','quota-complete',{pointsGained:60}),'MOBILE'));
 c.accept(make(act('search','quota-incomplete',{status:'unconfirmed',pointsGained:87}),'DESKTOP'));
 c.accept(make({kind:'account',status:'partial',initialPoints:1000,currentBalance:1147,pointsGained:147,
   pointsKnown:true,durationSeconds:30,completion:{incomplete:[]}}));
 assert.equal(c.state.result.status,'completed');assert.equal(c.state.result.pointsEarned,147);
 assert.equal(c.state.tasks.mobileSearch,'complete');assert.equal(c.state.tasks.desktopSearch,'missing');
 assert.deepEqual(c.state.searchPoints,{mobile:60,desktop:87});assert.equal(c.state.tasks.dailySet,'unknown');
});
test('v5 does not count bonus, balance observations, unknown amounts or duplicate search summaries as receipts',()=>{
 const c=collector(env,1);
 c.accept(make(act('search','quota-incomplete',{pointsGained:57}),'MOBILE'));
 c.accept(make(act('search','quota-incomplete',{pointsGained:57}),'MOBILE'));
 c.accept(make(act('bonus-search','offer-complete',{pointsGained:100}),'MOBILE'));
 c.accept(make(act('search','quota-incomplete',{pointsKnown:false,pointsGained:0}),'DESKTOP'));
 assert.deepEqual(c.state.searchPoints,{mobile:57,desktop:null});
});
test('v5 Daily Set needs three same-day offers or a fresh explicit streak, not two successful cards',()=>{
 const c=collector(env,1);
 for(let n=1;n<=2;n++)c.accept(make(act('daily-set','offer-complete',{offerId:`Global_DailySet_20261101_Child${n}`})));
 assert.equal(c.state.tasks.dailySet,'unknown');
 c.accept(make(act('daily-set','offer-complete',{offerId:'Global_DailySet_20261031_Child3'})));
 assert.equal(c.state.tasks.dailySet,'unknown');
 c.accept(make(act('daily-set','offer-complete',{offerId:'Global_DailySet_20261101_Child3'})));
 assert.equal(c.state.tasks.dailySet,'complete');
 const other=collector(env,2);
 other.accept(make({kind:'account-info',streaks:[{label:'Daily Set Streak',completedToday:true,resetAt:'2026-10-31T00:00:00Z'}]}));
 assert.equal(other.state.tasks.dailySet,'unknown');
 other.accept(make({kind:'account-info',streaks:[{label:'Daily Set Streak',completedToday:true,resetAt:'2026-11-02T00:00:00Z'}]}));
 assert.equal(other.state.tasks.dailySet,'complete');
});
test('v5 partial Read to Earn credit does not certify the daily task',()=>{
 const c=collector(env,1);
 c.accept(make(act('read-to-earn','read-to-earn-progressed-refresh-lagged',{pointsGained:3}),'MOBILE'));
 assert.equal(c.state.readingPoints,3);assert.equal(c.state.tasks.readToEarn,'unknown');
 c.accept(make(act('read-to-earn','read-to-earn-complete',{pointsGained:30}),'MOBILE'));
 assert.equal(c.state.tasks.readToEarn,'complete');
});
test('v5 claims are deduplicated and not attributed to mobile or desktop search',()=>{
 const c=collector(env,1),item=act('doClaimBonusPoints','claim-state-confirmed',{pointsGained:6,operationId:'fixture-op'});
 c.accept(make(item));c.accept(make(item));
 assert.equal(c.state.claimReceived,6);assert.deepEqual(c.state.searchPoints,{mobile:null,desktop:null});
});
test('v5 authentication failures and unknown balances stay actionable, never fake zero credit',()=>{
 const c=collector(env,1);
 c.accept(make({kind:'account',status:'failed',reason:'TOTP secret is required',pointsKnown:false,
   initialPoints:0,currentBalance:0,durationSeconds:2}));
 assert.equal(c.state.result.errorCode,'AUTH_REQUIRED');assert.equal(c.state.result.pointsEarned,null);
 assert.equal(failure('Service rate limit HTTP 429'),'HTTP_429');
 const partial=collector(env,1);
 partial.accept(make({kind:'account',status:'partial',reason:'Service rejected account access (HTTP 401)',pointsKnown:false,
   initialPoints:0,currentBalance:0,durationSeconds:2}));
 assert.equal(partial.state.result.status,'failed');assert.equal(partial.state.result.errorCode,'AUTH_REQUIRED');
});

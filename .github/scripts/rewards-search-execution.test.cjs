'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {collector}=require('./rewards-v5-events.cjs');
const runner=require('./rewards-runner.cjs'),state=require('./rewards-state.cjs');
const env={RUN_DATE:'2026-11-02',ACCOUNT_EMAIL:'fixture@example.invalid',REWARDS_RUN_ID:'fixture-run'};
function event(title,data,message='',platform='DESKTOP') {return '__REWARDS_EVENT__ '+JSON.stringify({version:2,runId:env.REWARDS_RUN_ID,user:env.ACCOUNT_EMAIL,ts:'2026-11-02T05:00:00Z',platform,level:'info',title,data,message})}
test('quota-unavailable is explicitly not-run; actual queries and confirmed completion take priority',()=>{
 const c=collector(env,4);
 c.accept(event('ACTIVITY',{kind:'activity',activity:'mobile-search-quota',status:'unconfirmed',reason:'quota-unavailable'}));
 assert.equal(c.state.searchExecution.mobile,'quota_unavailable');
 c.accept(event('SEARCH-BING',null,'Searching | search=1 | fixture','MOBILE'));
 c.accept(event('ACTIVITY',{kind:'activity',activity:'mobile-search-quota',status:'unconfirmed',reason:'quota-unavailable'}));
 assert.equal(c.state.searchExecution.mobile,'attempted');
 c.accept(event('ACTIVITY',{kind:'activity',activity:'search',status:'confirmed',reason:'quota-complete'},'','MOBILE'));
 assert.equal(c.state.searchExecution.mobile,'complete');
});
test('Telegram distinguishes not-run, attempted unknown and historical credits without inventing completion',()=>{
 const report={date:env.RUN_DATE,accountId:4,status:'completed',nativeStatus:'partial',tasks:{mobileSearch:'unknown',desktopSearch:'unknown'},
  dailySearch:{mobile:{points:0,verified:false},desktop:{points:0,verified:false}},searchExecution:{mobile:'quota_unavailable',desktop:'attempted'}};
 const text=runner.accountMessage(report,'fixture@example.invalid','https://example.invalid');
 assert.ok(text.includes('Mobile search:</b> ⏸️ Chưa chạy — không lấy được quota'));
 assert.ok(text.includes('Desktop search:</b> ⚠️ Đã chạy — chưa xác minh điểm/quota'));
 assert.ok(!text.includes('· 0 điểm'));
 report.dailySearch.mobile.points=27;
 assert.ok(runner.accountMessage(report,'fixture@example.invalid','https://example.invalid').includes('27 điểm ghi nhận trước đó'));
});
test('private search execution keeps only allowed fixed labels',()=>{
 const r=state.safeReport({date:env.RUN_DATE,accountId:4,status:'completed',searchExecution:{mobile:'quota_unavailable',desktop:'fixture-private',token:'secret'}},4,env.RUN_DATE);
 assert.deepEqual(r.searchExecution,{mobile:'quota_unavailable',desktop:'unknown'});
 assert.ok(!JSON.stringify(r).includes('fixture-private'));assert.ok(!JSON.stringify(r).includes('secret'));
});
test('account-end restores quota-unavailable status even when earlier activity messages were absent',()=>{
 const c=collector(env,4);
 c.accept(event('ACCOUNT-END',{kind:'account',status:'partial',pointsKnown:true,initialPoints:100,currentBalance:100,durationSeconds:1,
  completion:{incomplete:[{activity:'desktop-search-quota',status:'unconfirmed',reason:'quota-unavailable'}]}}));
 assert.equal(c.state.searchExecution.desktop,'quota_unavailable');
 assert.equal(c.state.tasks.desktopSearch,'unknown');
});

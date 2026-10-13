'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const tasks=require('./rewards-tasks.cjs'),performance=require('./rewards-performance.cjs'),state=require('./rewards-state.cjs'),runner=require('./rewards-runner.cjs');
const complete=Object.fromEntries(tasks.keys.map(k=>[k,'complete']));
test('completion distinguishes verified, missing, unknown and a scoped diagnostic run',()=>{
 assert.equal(tasks.completion(complete).status,'verified');
 assert.equal(tasks.completion({...complete,dailySet:'missing',mobileSearch:'unknown'}).status,'incomplete');
 assert.equal(tasks.completion({...complete,mobileSearch:'unknown'}).status,'unverified');
 assert.equal(tasks.completion({},[]).status,'not_requested');
 assert.equal(tasks.completion({dailySet:'complete'},tasks.required('test')).status,'verified');
 assert.equal(tasks.review(complete,150).pointsWarning,true);assert.equal(tasks.review(complete,150).needsTaskReview,false);
 assert.equal(tasks.review({...complete,dailySet:'missing'},260).needsTaskReview,true);
});
test('same-day task evidence keeps an earlier completion but a later missing task supersedes it',()=>{
 const s={morning:{status:'completed',finishedAt:'2026-10-10T03:00:00Z',tasks:complete},test:{status:'completed',finishedAt:'2026-10-10T04:00:00Z',tasks:{dailySet:'unknown'}}};
 assert.equal(state.dailyTaskReview(s).status,'verified');
 s.test.tasks.dailySet='missing';assert.equal(state.dailyTaskReview(s).status,'incomplete');
});
test('timings deduplicate spans, retain interrupted work, and ignore unmatched or invalid events',()=>{
 let now=0;const c=performance.collector(()=>now);
 c.accept({id:1,stage:'login',phase:'end',durationMs:100,status:'ok'});
 c.accept({id:1,stage:'login',phase:'start'});now=500;
 c.accept({id:1,stage:'login',phase:'end',durationMs:500,status:'ok'});c.accept({id:1,stage:'login',phase:'end',durationMs:500,status:'ok'});
 c.accept({id:2,stage:'mobile_search',phase:'start'});now=1500;
 c.accept({id:3,stage:'PRIVATE-SECRET',phase:'start'});
 assert.deepEqual(c.snapshot(),[{stage:'login',durationMs:500,calls:1,failed:0,interrupted:false},{stage:'mobile_search',durationMs:1000,calls:1,failed:0,interrupted:true}]);
 assert.ok(!JSON.stringify(c.snapshot()).includes('PRIVATE-SECRET'));
});
test('Telegram distinguishes ended process from unverified daily completion and hides diagnostic timings',()=>{
 const text=runner.accountMessage({accountId:1,date:'2026-10-10',status:'completed',pointsEarned:260,tasks:{dailySet:'missing'},timings:[{stage:'login',durationMs:60000,calls:2}],requiredTasks:tasks.keys},'fixture@example.invalid','https://example.invalid');
 assert.ok(text.includes('Đã kết thúc lượt chạy'));assert.ok(text.includes('Còn nhiệm vụ chưa hoàn tất'));assert.ok(!text.includes('Đăng nhập: 1.0p'));assert.ok(!text.includes('⏱️'));assert.ok(!text.includes('Xem lượt'));assert.ok(!text.includes('Nghỉ ngẫu nhiên'));
});

test('57/87 reporting thresholds do not change real task states or override Microsoft quota',()=>{
 const r={accountId:1,date:'2026-10-13',status:'completed',pointsEarned:180,tasks:{...complete,mobileSearch:'unknown',desktopSearch:'unknown'},dailySearch:{mobile:{points:57,verified:true},desktop:{points:87,verified:true}},requiredTasks:tasks.keys};
 const original=JSON.stringify(r);
 const message=runner.accountMessage(r,'fixture@example.invalid','https://example.invalid');
 assert.ok(message.includes('Đủ mức báo cáo · 57 điểm'));assert.ok(message.includes('Đủ mức báo cáo · 87 điểm'));
 assert.ok(message.includes('Hoàn tất theo báo cáo'));assert.equal(JSON.stringify(r),original);
 assert.equal(tasks.completion(r.tasks).status,'unverified');
 r.searchEvidence={mobile:{earned:57,max:60,source:'api'},desktop:{earned:87,max:90,source:'ui'}};
 const pending=runner.accountMessage(r,'fixture@example.invalid','https://example.invalid');
 assert.ok(pending.includes('Còn thiếu · 57/60'));assert.ok(!pending.includes('Đủ mức báo cáo'));
 delete r.searchEvidence;r.dailySearch.mobile.points=56;r.dailySearch.desktop.verified=false;
 const uncertain=runner.accountMessage(r,'fixture@example.invalid','https://example.invalid');
 assert.ok(!uncertain.includes('Đủ mức báo cáo'));assert.ok(uncertain.includes('Chưa xác minh'));
});

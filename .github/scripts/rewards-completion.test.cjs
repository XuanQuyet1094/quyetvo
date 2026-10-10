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
test('Telegram distinguishes ended process from unverified daily completion and shows stage timings',()=>{
 const text=runner.accountMessage({accountId:1,date:'2026-10-10',status:'completed',pointsEarned:260,tasks:{dailySet:'missing'},timings:[{stage:'login',durationMs:60000,calls:2}],requiredTasks:tasks.keys},'fixture@example.invalid','https://example.invalid');
 assert.ok(text.includes('Đã kết thúc lượt chạy'));assert.ok(text.includes('Còn nhiệm vụ chưa hoàn tất'));assert.ok(text.includes('Đăng nhập: 1.0p'));
});

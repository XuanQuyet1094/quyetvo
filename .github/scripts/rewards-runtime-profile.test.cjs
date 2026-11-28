'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {apply,restRange}=require('./rewards-runtime-profile.cjs');
test('regular modes reduce waits without changing quotas workers transport or retry limits',()=>{
 for(const mode of ['morning','retry','reconcile']){
 const cfg={workers:{doDailySet:true,doMorePromotions:true,doReadToEarn:true,doMobileSearch:true,doDesktopSearch:true},globalTimeout:'30sec',rewardsMode:'api',searchSettings:{parallelSearching:false,runOnZeroPoints:false,maxSearchOnBingAttempts:3},accountDelay:{min:'100sec',max:'180sec'}};
 const before=JSON.parse(JSON.stringify(cfg));
 apply(cfg,mode);
 assert.deepEqual(cfg.workers,before.workers);
 for(const k of ['parallelSearching','runOnZeroPoints','maxSearchOnBingAttempts'])assert.equal(cfg.searchSettings[k],before.searchSettings[k]);
 assert.equal(cfg.globalTimeout,before.globalTimeout);
 assert.equal(cfg.rewardsMode,'api');
 assert.equal(cfg.taskDelay.max,'15sec');
 assert.equal(cfg.searchSettings.searchDelay.min,'30sec');
 assert.equal(cfg.searchSettings.readDelay.min,'30sec');
 assert.deepEqual(restRange(mode),[15,31]);
 }
});
test('diagnostics isolated tests and benchmark keep their existing timing',()=>{
 for(const mode of ['test','app-test','app-read-test','diagnostic','api-benchmark',undefined]){
 const cfg={taskDelay:{min:'15sec',max:'30sec'}};const before=JSON.stringify(cfg);
 apply(cfg,mode);assert.equal(JSON.stringify(cfg),before);assert.deepEqual(restRange(mode),[100,181]);
 }
});


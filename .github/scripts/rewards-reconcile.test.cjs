'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const status=require('./rewards-tasks.cjs'),schedule=require('./rewards-schedule.cjs'),{claim,savePrivateReport}=require('./rewards-state.cjs');
test('evening schedule uses Vietnam date, closes in the same day, and does not reopen morning',()=>{
 const env={GITHUB_EVENT_NAME:'schedule',EVENT_SCHEDULE:schedule.RECONCILE};
 assert.deepEqual(schedule.planRun(env,'2026-10-07T11:17:00Z',Date.parse('2026-10-07T11:17:00Z')),{date:'2026-10-07',mode:'reconcile',run:true});
 assert.equal(schedule.planRun(env,'2026-10-07T11:17:00Z',Date.parse('2026-10-07T15:11:00Z')).run,false);
 assert.equal(schedule.planRun(env,'2026-10-07T11:17:00Z',Date.parse('2026-10-08T11:17:00Z')).run,false);
 assert.equal(schedule.planRun({...env,EVENT_SCHEDULE:schedule.MORNING},'2026-10-07T11:17:00Z',Date.parse('2026-10-07T11:17:00Z')).run,false);
});
test('task reports retain fixed labels only and preserve same-day confirmed completion',()=>{
 const safe=status.tasks({dailySet:'complete',appCheckIn:'private@example.test',token:'private'});
 assert.equal(safe.appCheckIn,'unknown');assert.equal(safe.token,undefined);
 assert.equal(status.merge(safe,{dailySet:'unknown'}).dailySet,'complete');
 assert.equal(status.merge(safe,{dailySet:'missing'}).dailySet,'missing');
 assert.ok(status.lines(safe).join(' ').includes('Read to Earn'));
});
test('repair enables sequential desktop/mobile searches but disables unrelated activity and zero-quota farming',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repair-config-'));
 try{
 fs.writeFileSync(path.join(dir,'config.example.json'),JSON.stringify({workers:{doDailySet:true,doReadToEarn:true,doDailyCheckIn:true,doMobileSearch:true,doDesktopSearch:false,doBonusSearches:true,doMorePromotions:true},activities:{urlReward:true,searchOnBing:true},searchSettings:{parallelSearching:true,runOnZeroPoints:true},experimental:{edgeBrowsing:true,apiSearch:true,apiSearchOnBing:true}}));
 const result=spawnSync(process.execPath,[path.join(__dirname,'rewards-runner.cjs'),'configure'],{encoding:'utf8',env:{...process.env,BOT_DIR:dir,RUNNER_TEMP:dir,ACCOUNT_SLOT:'2',RUN_MODE:'reconcile'}});
 assert.equal(result.status,0);const cfg=JSON.parse(fs.readFileSync(path.join(dir,'config.json')));
 assert.equal(cfg.experimental.edgeBrowsing,false);assert.equal(cfg.workers.doBonusSearches,false);assert.equal(cfg.workers.doMorePromotions,false);assert.equal(cfg.workers.doMobileSearch,true);assert.equal(cfg.workers.doDesktopSearch,true);
 assert.equal(cfg.workers.doDailyCheckIn,true);assert.equal(cfg.searchSettings.parallelSearching,false);
 assert.equal(cfg.searchSettings.runOnZeroPoints,false);
 assert.equal(cfg.experimental.apiSearch,false);assert.equal(cfg.experimental.apiSearchOnBing,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Telegram repair separates platform status and never promotes an unknown quota to completion',()=>{
 const previous=process.env.RUN_MODE;process.env.RUN_MODE='reconcile';
 try{
 const {accountMessage}=require('./rewards-runner.cjs');
 const message=accountMessage({accountId:1,status:'completed',date:'2026-10-09',pointsEarned:3,
  initialBalance:100,finalBalance:103,searchQuota:'unknown',
  tasks:{dailySet:'complete',appCheckIn:'complete',readToEarn:'complete',mobileSearch:'unknown',desktopSearch:'missing'}},'fixture@example.invalid','https://example.invalid');
 assert.ok(message.includes('Điện thoại ❔ Chưa xác minh'));
 assert.ok(message.includes('Máy tính ⚠️ Còn thiếu'));
 assert.ok(message.includes('chỉ tìm kiếm khi Microsoft xác nhận quota còn thiếu'));
 }finally{if(previous===undefined)delete process.env.RUN_MODE;else process.env.RUN_MODE=previous;}
});
test('repair reserves one attempt per day, blocks running/auth failures and subtracts only reading receipts',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-07T18:17:00+07:00'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repair-state-')),previous={...process.env},oldFetch=global.fetch;
 let state={schema:1,date:'2026-10-07',accountId:2,morning:{status:'completed',runId:'100',runAttempt:'1'}},puts=0;
 let report={date:state.date,accountId:2,pointsEarned:220,readingPoints:30};
 try{
 Object.assign(process.env,{RUN_MODE:'reconcile',RUN_DATE:state.date,ACCOUNT_SLOT:'2',RUNNER_TEMP:dir,REWARDS_PRIVATE_REPO:'example/private',REWARDS_STATE_TOKEN:'fixture',GITHUB_RUN_ID:'101',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:path.join(dir,'out')});
 global.fetch=async(url,options={})=>{
 let body;if(options.method==='PUT'){state=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));puts++;body={};}
 else if(url.endsWith('/example/private'))body={private:true};else if(url.includes('/branches/'))body={name:'rewards-state'};
 else body={sha:'fixture',content:Buffer.from(JSON.stringify(url.includes('/reports/')?report:state)).toString('base64')};
 return {ok:true,status:200,json:async()=>body};
 };
 await claim();assert.equal(puts,1);let budget=JSON.parse(fs.readFileSync(path.join(dir,'rewards-private/reading-budget.json')));
 assert.equal(budget.points,0);assert.equal(budget.verified,true);await claim();assert.equal(puts,1);
 delete state.reconcile;state.morning.status='running';await claim();assert.equal(puts,1);
 state.morning.status='failed';state.morning.errorCode='TOTP_REJECTED';await claim();assert.equal(puts,1);
 state.morning.status='completed';delete state.morning.errorCode;delete report.readingPoints;
 await claim();assert.equal(puts,2);budget=JSON.parse(fs.readFileSync(path.join(dir,'rewards-private/reading-budget.json')));
 assert.equal(budget.points,0);assert.equal(budget.verified,false);
 }finally{global.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);fs.rmSync(dir,{recursive:true,force:true});}
});


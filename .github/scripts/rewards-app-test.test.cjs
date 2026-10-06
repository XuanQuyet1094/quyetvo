'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('App test enables only daily check-in and disables Edge and web earning',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-config-'));
 try {
  fs.writeFileSync(path.join(dir,'config.example.json'),JSON.stringify({workers:{doDailySet:true,doDailyCheckIn:true,doReadToEarn:true,doAppPromotions:true,doMobileSearch:true},activities:{urlReward:true,searchOnBing:true},experimental:{edgeBrowsing:true}}));
  const result=spawnSync(process.execPath,[path.join(__dirname,'rewards-runner.cjs'),'configure'],{env:{...process.env,RUN_MODE:'app-test',ACCOUNT_SLOT:'1',BOT_DIR:dir,RUNNER_TEMP:dir},encoding:'utf8'});
  assert.equal(result.status,0);
  const config=JSON.parse(fs.readFileSync(path.join(dir,'config.json')));
  assert.deepEqual(Object.keys(config.workers).filter(k=>config.workers[k]),['doDailyCheckIn']);
  assert.ok(Object.values(config.activities).every(v=>v===false));
  assert.equal(config.experimental.edgeBrowsing,false);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('authentication probe disables every earning activity',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-probe-config-'));
 try{
  fs.writeFileSync(path.join(dir,'config.example.json'),JSON.stringify({workers:{doDailyCheckIn:true,doDesktopSearch:true,doAppPromotions:true},activities:{urlReward:true,searchOnBing:true},experimental:{edgeBrowsing:true},ensureStreakProtection:true,autoClaimPunchcardRewards:true}));
  const result=spawnSync(process.execPath,[path.join(__dirname,'rewards-runner.cjs'),'configure'],{env:{...process.env,RUN_MODE:'app-auth-probe',ACCOUNT_SLOT:'1',BOT_DIR:dir,RUNNER_TEMP:dir},encoding:'utf8'});
  assert.equal(result.status,0);
  const config=JSON.parse(fs.readFileSync(path.join(dir,'config.json')));
  assert.ok(Object.values(config.workers).every(v=>v===false));
  assert.ok(Object.values(config.activities).every(v=>v===false));
  assert.equal(config.experimental.edgeBrowsing,false);
  assert.equal(config.ensureStreakProtection,false);
  assert.equal(config.autoClaimPunchcardRewards,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Read to Earn test enables only reading, leaving check-in and searches disabled',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-read-config-'));
 try {
  fs.writeFileSync(path.join(dir,'config.example.json'),JSON.stringify({workers:{doDailySet:true,doDailyCheckIn:true,doReadToEarn:true,doAppPromotions:true,doMobileSearch:true},activities:{urlReward:true,searchOnBing:true},experimental:{edgeBrowsing:true}}));
  const result=spawnSync(process.execPath,[path.join(__dirname,'rewards-runner.cjs'),'configure'],{env:{...process.env,RUN_MODE:'app-read-test',ACCOUNT_SLOT:'1',BOT_DIR:dir,RUNNER_TEMP:dir},encoding:'utf8'});
  assert.equal(result.status,0);
  const config=JSON.parse(fs.readFileSync(path.join(dir,'config.json')));
  assert.deepEqual(Object.keys(config.workers).filter(k=>config.workers[k]),['doReadToEarn']);
  assert.ok(Object.values(config.activities).every(v=>v===false));
  assert.equal(config.experimental.edgeBrowsing,false);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('late reading test remains in the original Vietnam day without reopening morning runs',()=>{
 const s=require('./rewards-schedule.cjs');
 const now=Date.parse('2026-10-06T23:48:00+07:00');
 assert.equal(s.canStart('2026-10-06',now,'app-read-test'),true);
 assert.equal(s.canStart('2026-10-06',now,'morning'),false);
 assert.equal(s.canStart('2026-10-06',Date.parse('2026-10-07T00:00:00+07:00'),'app-read-test'),false);
});

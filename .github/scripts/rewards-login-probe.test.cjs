'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {verifiedSessionProbe}=require('./rewards-login-probe.cjs');
const env={RUN_DATE:'2026-11-03',ACCOUNT_SLOT:'2',GITHUB_RUN_ID:'123'};
function event(platform,status,extra={}){return '__REWARDS_EVENT__ '+JSON.stringify({version:2,runId:'2026-11-03:2:123',ts:'2026-11-03T05:00:00Z',title:'SESSION-GENERATION',level:'info',data:{kind:'session',platform,status},...extra});}
const complete=['desktop','mobile'].flatMap(p=>[event(p,'running'),event(p,'completed')]).join('\n');
test('both verified native session receipts are required; a Desktop-only success is not authentication proof for Mobile',()=>{
  const r={exitCode:0,signal:null,errorCode:'NO_FINAL_RESULT'};
  assert.equal(verifiedSessionProbe(complete,env,r),true);
  for(const log of [complete.split('\n').slice(0,2).join('\n'),complete.replaceAll('"mobile"','"desktop"'),complete.replace('2026-11-03:2:123','2026-11-03:3:123'),complete.replace(/completed/g,'failed'),complete+'\n'+event('mobile','completed'),complete+'\n'+event('mobile','failed',{level:'error'})])assert.equal(verifiedSessionProbe(log,env,r),false);
  for(const result of [{...r,exitCode:1},{...r,signal:'SIGTERM'},{...r,errorCode:'ACCOUNT_TIMEOUT'}])assert.equal(verifiedSessionProbe(complete,env,result),false);
  assert.equal(verifiedSessionProbe(complete.replaceAll('2026-11-03T05:00:00Z','2026-11-02T05:00:00Z'),env,r),false);
});
test('a reward/account event cannot be reported as a login-only probe',()=>{
  for(const kind of ['activity','account'])assert.equal(verifiedSessionProbe(complete+'\n'+event('desktop','completed',{data:{kind}}),env,{exitCode:0}),false);
});
test('probe launches only native session generation with all earning disabled; no claim or balance is fabricated',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),runner=require('./rewards-runner.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'login-both-'));
  const e={...env,RUN_MODE:'diagnostic',BOT_DIR:dir,RUNNER_TEMP:dir,REPORT_PATH:dir+'/report.json'};
  let calls=0;
  try {
    t.mock.method(Date,'now',()=>Date.parse('2026-11-03T05:00:00Z'));
    const cfg={rewardsMode:'api',ensureStreakProtection:false,autoClaimPunchcardRewards:false,workers:{doDailySet:false,doMobileSearch:false},activities:{urlReward:false},experimental:{edgeBrowsing:false}};
    fs.writeFileSync(dir+'/config.json',JSON.stringify(cfg));
    t.mock.method(runner,'runAccount',async options=>{
      calls++;assert.deepEqual(options.args,['dist/session/RegenerateSessions.js','--platform','both']);assert.equal(options.timeoutMs,600000);
      fs.mkdirSync(dir+'/rewards-private',{recursive:true});fs.writeFileSync(dir+'/rewards-private/account-2.log',complete);
      fs.writeFileSync(e.REPORT_PATH,JSON.stringify({status:'failed',errorCode:'NO_FINAL_RESULT',exitCode:0,signal:null}));return 1;
    });
    assert.equal(await require('./rewards-login-probe.cjs').run(e),0);assert.equal(calls,1);
    assert.equal(JSON.parse(fs.readFileSync(e.REPORT_PATH)).status,'failed');
    cfg.workers.doDailySet=true;fs.writeFileSync(dir+'/config.json',JSON.stringify(cfg));
    await assert.rejects(require('./rewards-login-probe.cjs').run(e));assert.equal(calls,1);
    await assert.rejects(require('./rewards-login-probe.cjs').run({...e,RUN_MODE:'retry'}));assert.equal(calls,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {BASE_MS,recordProgress,extraDelayMs}=require('./rewards-reconcile-budget.cjs');
const min=60000;
const started=1_000_000;
const now=started+BASE_MS;
const quota=(earned,max=60)=>({earned,max,source:'ui'});
const evidence={mobile:quota(6),desktop:quota(90,90),limited:false};

test('reconcile can extend only active, confirmed, incomplete search and rechecks every five minutes',()=>{
  const progress={};
  recordProgress(progress,{mobile:quota(3)},evidence,now-min);
  const opts={slot:2,remaining:230*min,started,now,evidence,progress};
  assert.equal(extraDelayMs(opts),5*min);
  assert.equal(extraDelayMs({...opts,now:now+5*min}),0);
  assert.equal(extraDelayMs({...opts,evidence:{...evidence,limited:true}}),0);
  assert.equal(extraDelayMs({...opts,evidence:{...evidence,mobile:null}}),0);
  assert.equal(extraDelayMs({...opts,evidence:{...evidence,mobile:quota(6,6)}}),0);
});

test('extension preserves time for later accounts and reporting and cannot exceed 60 minutes',()=>{
  const check=(slot, remaining, elapsed)=>extraDelayMs({
    slot,remaining:remaining*min,started,now:started+elapsed*min,evidence,
    progress:{mobile:{max:60,earned:6,at:started+elapsed*min}}
  });
  assert.equal(check(2,215,35),3*min); // 215 - 4*43 - 5 = 38 minutes for slot 2.
  assert.equal(check(2,212,35),0);
  assert.equal(check(3,175,35),5*min);
  assert.equal(check(6,43,35),3*min);
  assert.equal(check(6,45,40),0);
  assert.equal(check(6,180,58),2*min);
  assert.equal(check(6,180,60),0);
});

test('stale quota repeats, initial reads and backwards fluctuations are not new progress',()=>{
  const progress={};
  recordProgress(progress,{},evidence,now-10*min);
  assert.equal(progress.mobile.at,null);
  recordProgress(progress,evidence,{mobile:quota(9)},now-5*min);
  assert.equal(progress.mobile.at,now-5*min);
  recordProgress(progress,{mobile:quota(9)},{mobile:quota(6)},now-2*min);
  recordProgress(progress,{mobile:quota(6)},{mobile:quota(9)},now-min);
  assert.equal(progress.mobile.at,now-5*min);
  recordProgress(progress,{mobile:quota(9)},{mobile:quota(9,90)},now-min);
  assert.equal(progress.mobile.at,null);
});

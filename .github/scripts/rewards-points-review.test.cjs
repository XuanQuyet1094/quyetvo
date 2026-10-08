'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {eligible, needsPointsReview, dailyPointsReview} = require('./rewards-state.cjs');
const schedule = require('./rewards-schedule.cjs');
test('completed accounts below 220 qualify once; 220 is not below target', () => {
  const state = {schema:1,date:'2026-10-08',accountId:1,morning:{status:'completed'},dailyReview:{pointsEarned:150}};
  for (const points of [0,128,150,198,219,null])
    assert.equal(eligible({...state,dailyReview:{pointsEarned:points}},state.date,1),true);
  for (const points of [220,231,392])
    assert.equal(eligible({...state,dailyReview:{pointsEarned:points}},state.date,1),false);
  assert.equal(eligible({...state,retry:{status:'completed'}},state.date,1),false);
  assert.equal(eligible({...state,reconcile:{status:'running'}},state.date,1),false);
  assert.equal(eligible({...state,morning:{status:'completed',diagnostic:{errors:['TOTP_REJECTED']}}},state.date,1),false);
  assert.equal(eligible(state,'2026-10-09',1),false);
  assert.equal(needsPointsReview(220),false);
});
test('daily points aggregate validated private receipts, deduplicate, and flag missing data', async t => {
  const receipts = {
    '100':{date:'2026-10-08',accountId:1,initialBalance:1000,finalBalance:1150,pointsEarned:150},
    '101':{date:'2026-10-08',accountId:1,initialBalance:1150,finalBalance:1220,pointsEarned:70}
  };
  const entry = id => ({runId:id,runAttempt:'1',finishedAt:'2026-10-08T05:00:00Z'});
  const state = {morning:entry('100'),retry:entry('101'),test:entry('100')};
  let reads=0;
  t.mock.method(global,'fetch',async url => {
    reads++; const r=receipts[/run-(\d+)-attempt/.exec(url)[1]];
    return {ok:!!r,status:r?200:404,json:async()=>({content:Buffer.from(JSON.stringify(r)).toString('base64')})};
  });
  const ctx={date:'2026-10-08',slot:1};
  const previous=process.env.REWARDS_PRIVATE_REPO;
  process.env.REWARDS_PRIVATE_REPO='fixture/private';
  try {
    assert.deepEqual(await dailyPointsReview(state,ctx),{target:220,pointsEarned:220,needsReview:false});
    assert.equal(reads,2);
    receipts['101'].finalBalance=1219;
    assert.deepEqual(await dailyPointsReview(state,ctx),{target:220,pointsEarned:null,needsReview:true});
    delete receipts['101'];
    assert.equal((await dailyPointsReview(state,ctx)).needsReview,true);
  } finally {if(previous===undefined)delete process.env.REWARDS_PRIVATE_REPO;else process.env.REWARDS_PRIVATE_REPO=previous;}
});
test('delayed noon retry and evening backups retain same-day deadline',()=>{
  const at=time=>Date.parse('2026-10-08T'+time+'+07:00');
  assert.equal(schedule.planRun({GITHUB_EVENT_NAME:'schedule',EVENT_SCHEDULE:schedule.RETRY},'2026-10-08T12:13:00Z',at('19:13:00')).run,true);
  for(const time of ['19:17:00','20:17:00','21:30:00'])
    assert.equal(schedule.planRun({GITHUB_EVENT_NAME:'schedule',EVENT_SCHEDULE:schedule.RECONCILE_BACKUP},'2026-10-08T11:17:00Z',at(time)).run,true);
  assert.equal(schedule.planRun({GITHUB_EVENT_NAME:'schedule',EVENT_SCHEDULE:schedule.RECONCILE},'2026-10-08T11:17:00Z',at('22:11:00')).run,false);
});

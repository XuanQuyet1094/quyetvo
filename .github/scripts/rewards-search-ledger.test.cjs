'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const ledger=require('./rewards-search-ledger.cjs');
const stateApi=require('./rewards-state.cjs');
const runner=require('./rewards-runner.cjs');
const base={mobile:{points:57,verified:true},desktop:{points:87,verified:true}};
test('day ledger combines separate platforms, caps targets, preserves uncertainty and counts each attempt once',async()=>{
 const entry=runId=>({runId,runAttempt:'1',finishedAt:'2026-10-10T01:00:00Z'});
 const state={morning:entry('100'),retry:entry('101'),test:entry('100')};
 let reads=0;
 const reports={'100':{date:'2026-10-10',accountId:1,searchPoints:{mobile:57,desktop:87}},
  '101':{date:'2026-10-10',accountId:1,searchPoints:{mobile:3,desktop:3}}};
 const result=await ledger.review(state,{date:'2026-10-10',slot:1},async e=>{reads++;return reports[e.runId];},async()=>{throw Error('New receipts should not reread logs');});
 assert.equal(reads,2);assert.equal(result.mobile.points,60);assert.equal(result.desktop.points,90);assert.equal(ledger.needsReview(result),false);
 assert.equal(ledger.add(result,{mobile:3,desktop:3}).mobile.points,60);
 assert.equal(ledger.add(base,{mobile:null,desktop:3}).mobile.verified,false);
 assert.equal(ledger.add(base,{mobile:0,desktop:3}).desktop.points,90);
 reports['101'].date='2026-10-09';
 assert.equal((await ledger.review(state,{date:'2026-10-10',slot:1},async e=>reports[e.runId],async()=>'' )).mobile.verified,false);
});
test('historical log migration counts query credits, excludes activity bonuses and stage summaries',async()=>{
 const log=['MOBILE [SEARCH-BING] Starting Bing searches',
  ...Array.from({length:19},()=> 'MOBILE [SEARCH-BING] pointsGained=3 | currentBalance=1 | query="fixture"'),
  'MOBILE [SEARCH-BING] Completed Bing searches | pointsGained=57',
  'MOBILE [READ-TO-EARN] pointsGained=30',
  ...Array.from({length:29},()=> 'DESKTOP [SEARCH-BING] pointsGained=3 | currentBalance=1 | query="fixture"'),
  'DESKTOP [SEARCH-BING] Completed Bing searches | pointsGained=87',
  'MOBILE [CLAIM-BONUS-POINTS] Completed | pointsGained=106'].join('\n');
 assert.deepEqual(ledger.legacyRunPoints(log),{mobile:57,desktop:87});
 assert.equal(ledger.legacyRunPoints(log+'\nMOBILE [SEARCH-BING] pointsGained=100 | currentBalance=1').mobile,null);
 assert.equal(ledger.legacyRunPoints('').mobile,null);
 const state={morning:{runId:'100',runAttempt:'1',finishedAt:'2026-10-10T01:00:00Z'}};
 const migrated=await ledger.review(state,{date:'2026-10-10',slot:5},async()=>({date:'2026-10-10',accountId:5}),async()=>log);
 assert.equal(migrated.mobile.points,57);assert.equal(migrated.desktop.points,87);
});
test('retry considers remaining tasks/search goals even when total points exceed 220 and still respects claims/blocks',()=>{
 const s={schema:1,date:'2026-10-10',accountId:5,morning:{status:'completed',tasks:{dailySet:'missing'}},dailyReview:{pointsEarned:260},searchReview:base};
 assert.equal(stateApi.eligible(s,s.date,5),true);
 assert.equal(stateApi.eligible({...s,retry:{status:'failed'}},s.date,5),false);
 assert.equal(stateApi.eligible({...s,morning:{status:'completed',diagnostic:{errors:['TOTP_REJECTED']}}},s.date,5),false);
 const complete={mobile:{points:60,verified:true},desktop:{points:90,verified:true}};
 assert.equal(stateApi.eligible({...s,morning:{status:'completed',tasks:{dailySet:'complete'}},searchReview:complete},s.date,5),false);
 assert.equal(stateApi.eligible({...s,morning:{status:'completed',tasks:{dailySet:'complete',mobileSearch:'complete',desktopSearch:'complete'}}},s.date,5),false);
});
test('Telegram shows independent day counters and goal completion without changing missing Daily Set',()=>{
 const completed=ledger.add(base,{mobile:3,desktop:3});
 const tasks=ledger.applyTasks({dailySet:'missing',mobileSearch:'unknown',desktopSearch:'unknown'},completed);
 const text=runner.accountMessage({accountId:5,date:'2026-10-10',status:'completed',pointsEarned:6,tasks,dailySearch:completed},'fixture@example.invalid','https://example.invalid');
 assert.ok(text.includes('60/60'));assert.ok(text.includes('90/90'));assert.ok(text.includes('Hoàn thành mục tiêu'));assert.ok(text.includes('Daily Set:</b> ⚠️ Còn thiếu'));
 const partial=ledger.lines(base,{mobileSearch:'unknown',desktopSearch:'unknown'}).join('\n');
 assert.ok(partial.includes('57/60'));assert.ok(partial.includes('87/90'));assert.ok(partial.includes('Còn thiếu 3'));
});
test('runner persists partial cumulative search receipts after failure and rejects wrong identity/day or duplicate events',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-10T18:17:00+07:00'));
 const now=Date.now(),date=new Date(now+7*3600000).toISOString().slice(0,10);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'search-runner-'));
 fs.mkdirSync(path.join(dir,'rewards-private'));
 fs.writeFileSync(path.join(dir,'rewards-private','search-budget.json'),JSON.stringify({schema:1,date,accountId:1,progress:base}));
 const event={schema:1,date,accountId:1,platform:'mobile',points:3};
 const source=`const e=${JSON.stringify(event)};console.log('DAILY_SEARCH_CREDIT '+JSON.stringify(e));
 console.log('DAILY_SEARCH_CREDIT '+JSON.stringify(e));
 console.log('DAILY_SEARCH_CREDIT '+JSON.stringify({...e,points:2}));
 console.log('DAILY_SEARCH_CREDIT '+JSON.stringify({...e,date:'2000-01-01',platform:'desktop'}));
 console.log('DAILY_SEARCH_CREDIT '+JSON.stringify({...e,accountId:2,platform:'desktop'}));process.exit(1);`;
 const env={ACCOUNT_SLOT:'1',ACCOUNT_EMAIL:'fixture@example.invalid',RUNNER_TEMP:dir,BOT_DIR:dir,REPORT_PATH:path.join(dir,'result.json'),RUN_DATE:date};
 try{
  await runner.runAccount({env,command:process.execPath,args:['-e',source],timeoutMs:2000});
  const r=JSON.parse(fs.readFileSync(env.REPORT_PATH));
  assert.equal(r.status,'failed');assert.deepEqual(r.searchPoints,{mobile:3,desktop:0});
  assert.equal(r.dailySearch.mobile.points,60);assert.equal(r.dailySearch.desktop.points,87);
  assert.equal(r.tasks.mobileSearch,'complete');assert.equal(r.tasks.desktopSearch,'missing');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('state claim seeds the private budget with legacy credits instead of repeating the entire target',async t=>{
 const previous={...process.env},dir=fs.mkdtempSync(path.join(os.tmpdir(),'search-claim-'));
 const date='2026-10-10';t.mock.method(Date,'now',()=>Date.parse(date+'T18:17:00+07:00'));
 let state={schema:1,date,accountId:5,morning:{status:'completed',runId:'100',runAttempt:'1',finishedAt:date+'T01:00:00Z',tasks:{dailySet:'missing'}}};
 const report={date,accountId:5,pointsEarned:260,initialBalance:3820,finalBalance:4080,readingPoints:30};
 const log=[...Array.from({length:19},()=> 'MOBILE [SEARCH-BING] pointsGained=3 | query="fixture"'),...Array.from({length:29},()=> 'DESKTOP [SEARCH-BING] pointsGained=3 | query="fixture"')].join('\n');
 t.mock.method(global,'fetch',async(url,options={})=>{
  let body;
  if(options.method==='PUT'){state=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));body={};}
  else if(url.endsWith('/example/private'))body={private:true};
  else if(url.includes('/branches/'))body={name:'rewards-state'};
  else body={sha:'fixture',content:Buffer.from(url.includes('/logs/')?log:JSON.stringify(url.includes('/reports/')?report:state)).toString('base64')};
  return {ok:true,status:200,json:async()=>body};
 });
 try{
  Object.assign(process.env,{RUN_MODE:'reconcile',RUN_DATE:date,ACCOUNT_SLOT:'5',RUNNER_TEMP:dir,REWARDS_PRIVATE_REPO:'example/private',REWARDS_STATE_TOKEN:'fixture',GITHUB_RUN_ID:'101',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:path.join(dir,'out')});
  await stateApi.claim();
  const budget=JSON.parse(fs.readFileSync(path.join(dir,'rewards-private','search-budget.json')));
  assert.equal(budget.progress.mobile.points,57);assert.equal(budget.progress.desktop.points,87);
  assert.equal(budget.accountId,5);assert.equal(state.reconcile.status,'running');
  const child=runner.childEnvironment({RUN_MODE:'reconcile',RUN_DATE:date,RUNNER_TEMP:dir,ACCOUNT_EMAIL:'fixture@example.invalid'},5);
  assert.equal(JSON.parse(child.REWARDS_SEARCH_LEDGER).progress.desktop.points,87);
 }finally{for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);fs.rmSync(dir,{recursive:true,force:true});}
});

test('an ambiguous historical reward keeps confirmed query credits as a lower bound',async()=>{
 const log=['MOBILE [SEARCH-BING] Starting Bing searches',
  ...Array.from({length:19},()=> 'MOBILE [SEARCH-BING] pointsGained=3 | currentBalance=1'),
  'MOBILE [SEARCH-BING] pointsGained=100 | currentBalance=1',
  'DESKTOP [SEARCH-BING] Starting Bing searches'].join('\n');
 const state={morning:{runId:'100',runAttempt:'1',finishedAt:'2026-10-10T01:00:00Z'}};
 const result=await ledger.review(state,{date:'2026-10-10',slot:1},async()=>({date:'2026-10-10',accountId:1}),async()=>log);
 assert.equal(result.mobile.points,57);assert.equal(result.mobile.verified,false);
 assert.equal(result.desktop.points,0);assert.equal(result.desktop.verified,true);
 assert.ok(ledger.lines(result).join('\n').includes('Ít nhất 57/60'));
 assert.equal(ledger.needsReview(result),true);
});

test('the configured goal and a reliable Microsoft quota are reported separately',()=>{
 const text=ledger.lines(base,{mobileSearch:'complete',desktopSearch:'unknown'}).join('\n');
 assert.ok(text.includes('Đã ghi nhận 57/60'));
 assert.ok(text.includes('Microsoft xác nhận hết quota'));
 assert.ok(text.includes('Còn thiếu 3 so với mục tiêu'));
 assert.equal(ledger.needsReview(base,{mobileSearch:'complete',desktopSearch:'complete'}),false);
});

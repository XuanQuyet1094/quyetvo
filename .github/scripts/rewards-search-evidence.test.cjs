'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const evidence=require('./rewards-search-evidence.cjs');
test('morning and retry keep search enabled until Microsoft quota is read, even with full historical receipts',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
 for(const mode of ['morning','retry','reconcile']) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quota-config-'));
  try {
   fs.mkdirSync(path.join(dir,'rewards-private'));
   fs.writeFileSync(path.join(dir,'config.example.json'),JSON.stringify({workers:{doMobileSearch:true,doDesktopSearch:true},searchSettings:{},activities:{},experimental:{}}));
   fs.writeFileSync(path.join(dir,'rewards-private/search-budget.json'),JSON.stringify({schema:1,date:'2026-10-10',accountId:1,progress:{mobile:{points:60,verified:true},desktop:{points:90,verified:true}}}));
   const run=spawnSync(process.execPath,[path.join(__dirname,'rewards-runner.cjs'),'configure'],{encoding:'utf8',env:{...process.env,BOT_DIR:dir,RUNNER_TEMP:dir,ACCOUNT_SLOT:'1',RUN_DATE:'2026-10-10',RUN_MODE:mode}});
   assert.equal(run.status,0);const cfg=JSON.parse(fs.readFileSync(path.join(dir,'config.json')));
   assert.equal(cfg.workers.doMobileSearch,true);assert.equal(cfg.workers.doDesktopSearch,true);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
 }
});
test('six-account summary with pending mixed rewards fits the Telegram notification limit',()=>{
 const runner=require('./rewards-runner.cjs'),jobs={},env={RUN_MODE:'morning',RUN_DATE:'2026-10-10',RUN_URL:'https://github.com/example/public/actions/runs/123'};
 for(let id=1;id<=6;id++) {
  env['ACCOUNT_'+id+'_EMAIL']='fixture-account-'+id+'@example.invalid';
  const r={accountId:id,status:'completed',pointsEarned:155,initialBalance:10000,finalBalance:10155,tasks:{dailySet:'missing',appCheckIn:'unknown',readToEarn:'complete',mobileSearch:'unknown',desktopSearch:'unknown'},dailySearch:{mobile:{points:57,verified:true},desktop:{points:87,verified:true}},searchEvidence:{pending:{total:106},claimReceived:106}};
  jobs['account_'+id]={outputs:{result:JSON.stringify(r)}};
 }
 const text=runner.summaryMessage(jobs,env);assert.ok(text.length<=4096);assert.ok(text.includes('quota ❔'));assert.ok(text.includes('chưa phân bổ search'));assert.ok(!text.includes('57/60'));
});
test('worker persists sanitized quotas and mixed claim separately, ignoring another account or day',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),runner=require('./rewards-runner.cjs');
 t.mock.method(Date,'now',()=>Date.parse('2026-10-10T18:17:00+07:00'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quota-worker-'));
 const q={schema:1,date:'2026-10-10',accountId:1,mobile:{earned:30,max:30,source:'api'},desktop:{earned:45,max:50,source:'ui'},raw:'PRIVATE-TEXT'};
 const claim={schema:1,date:q.date,accountId:1,received:106,pendingBefore:{total:106,mobile:3,desktop:3}};
 const code=`const q=${JSON.stringify(q)},c=${JSON.stringify(claim)};
 console.log('SEARCH_QUOTA_EVIDENCE '+JSON.stringify(q));
 console.log('SEARCH_QUOTA_EVIDENCE '+JSON.stringify({...q,accountId:2,mobile:{earned:0,max:60,source:'api'}}));
 console.log('SEARCH_QUOTA_EVIDENCE '+JSON.stringify({...q,date:'2000-01-01'}));
 console.log('SEARCH_CLAIM_RECEIPT '+JSON.stringify(c));`;
 const env={RUNNER_TEMP:dir,BOT_DIR:dir,ACCOUNT_SLOT:'1',ACCOUNT_EMAIL:'private@example.invalid',RUN_DATE:q.date,REPORT_PATH:path.join(dir,'result.json')};
 try {
  await runner.runAccount({env,command:process.execPath,args:['-e',code],timeoutMs:2000});
  const r=JSON.parse(fs.readFileSync(env.REPORT_PATH));
  assert.equal(r.searchEvidence.mobile.max,30);assert.equal(r.searchEvidence.claimReceived,106);assert.equal(r.searchEvidence.pendingBefore.mobile,3);
  assert.equal(r.tasks.mobileSearch,'complete');assert.equal(r.tasks.desktopSearch,'missing');assert.ok(!JSON.stringify(r).includes('PRIVATE-TEXT'));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('quota evidence accepts Microsoft caps, rejects impossible values and strips raw fields',()=>{
 const e=evidence.normalize({mobile:{earned:27,max:30,source:'api',token:'secret'},desktop:{earned:51,max:50,source:'ui'},pending:{total:106,email:'secret'},raw:'secret'});
 assert.equal(e.mobile.max,30);assert.equal(e.desktop,null);assert.ok(!JSON.stringify(e).includes('secret'));
 assert.equal(evidence.normalize({mobile:{earned:60,max:60,source:'balance'}}).mobile,null);
});
test('receipts alone never certify completion; shared pool and actual quota control task states',()=>{
 const tasks={mobileSearch:'unknown',desktopSearch:'unknown'};
 assert.deepEqual(evidence.applyTasks(tasks,{}),tasks);
 assert.deepEqual(evidence.applyTasks(tasks,{mobile:{earned:30,max:30,source:'api'},desktop:{earned:45,max:50,source:'ui'}}),{mobileSearch:'complete',desktopSearch:'missing'});
 assert.deepEqual(evidence.applyTasks(tasks,{shared:{earned:30,max:30,source:'ui'}}),{mobileSearch:'complete',desktopSearch:'complete'});
});
test('Telegram keeps mixed claim, pending and observed receipts separate without inventing missing three points',()=>{
 const text=evidence.lines({claimReceived:106,pendingBefore:{total:106},pending:{total:6,mobile:3,desktop:3}}, {mobile:{points:57,verified:false},desktop:{points:87,verified:true}}).join('\n');
 assert.ok(text.includes('Ít nhất 57 điểm'));assert.ok(text.includes('Chưa xác minh quota'));assert.ok(text.includes('+106 điểm · chưa phân bổ'));
 assert.ok(text.includes('Trước claim'));assert.ok(text.includes('Search chờ nhận (mobile)'));
 assert.ok(!text.includes('57/60')&&!text.includes('87/90')&&!text.includes('Còn 3'));
 const complete=evidence.lines({mobile:{earned:50,max:50,source:'api'},desktop:{earned:30,max:30,source:'ui'}},{}).join('\n');
 assert.ok(complete.includes('50/50'));assert.ok(complete.includes('30/30'));assert.ok(complete.includes('✅ Hoàn thành'));
});

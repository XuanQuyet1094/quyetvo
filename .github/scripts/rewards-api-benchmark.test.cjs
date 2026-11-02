'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const b=require('./rewards-api-benchmark.cjs'),s=require('./rewards-schedule.cjs'),state=require('./rewards-state.cjs');
const scope={RUN_DATE:b.DATE,RUN_MODE:b.MODE,ACCOUNT_SLOT:'4',API_BENCHMARK_DATE:b.DATE};
const at=t=>Date.parse(b.DATE+'T'+t+'+07:00');
function fixture(run,title,message,data,level='info') {return '__REWARDS_EVENT__ '+JSON.stringify({version:2,runId:`${b.DATE}:4:${run}`,ts:b.DATE+'T15:45:00Z',platform:'DESKTOP',title,message,data,level});}
const saved={schema:1,date:b.DATE,accountId:4,morning:{runId:'41341117178',status:'failed',errorCode:'AUTH_REQUIRED',diagnostic:{stage:'LOGIN'}}};
const oldLog=fixture('41341117178','ACCOUNT-END','failed',{status:'failed',pointsKnown:false,reason:'Login failed or aborted at state: SIGN_IN_METHOD_PICKER',completion:{counts:{completed:0}}});
const loginLog=[fixture('41474541110','LOGIN-TOTP','TOTP challenge advanced; continuing login verification'),fixture('41474541110','LOGIN-STATE','state=LOGGED_IN'),fixture('41474541110','ACCOUNT-END','done',{status:'completed',pointsGained:0,completion:{counts:{completed:0}}})].join('\n');
test('benchmark approval is only one account/date/mode with a 30-minute same-day budget',()=>{
 assert.equal(b.canStart(scope,at('22:58:00')),true);assert.equal(b.canStart(scope,at('23:29:31')),false);
 for(const change of [{ACCOUNT_SLOT:'3'},{RUN_DATE:'2026-11-03'},{API_BENCHMARK_DATE:''},{RUN_MODE:'morning'}]){
  const e={...scope,...change};assert.equal(b.canStart(e,at('22:58:00')),false);
  assert.equal(s.deadline(e.RUN_DATE,e.RUN_MODE,e),Date.parse(e.RUN_DATE+'T22:30:00+07:00'));
 }
 assert.equal(s.deadline(b.DATE,b.MODE,scope),b.END);
 assert.equal(b.canStart(scope,Date.parse('2026-11-03T00:00:00+07:00')),false);
 assert.throws(()=>s.planRun({GITHUB_EVENT_NAME:'workflow_dispatch',INPUT_MODE:b.MODE},b.DATE+'T15:58:00Z',at('22:58:00')));
});
test('benchmark requires verified TOTP login and proof no earlier tasks ran; unrelated auth blocks remain intact',()=>{
 assert.equal(b.verifiedAuthorization(saved,oldLog,loginLog),true);
 for(const value of [{...saved,accountId:3},{...saved,retry:{status:'completed',runId:'123'}},
  {...saved,morning:{...saved.morning,errorCode:'ACCOUNT_LOCKED'}},
  {...saved,morning:{...saved.morning,status:'running'}}]) assert.equal(b.verifiedAuthorization(value,oldLog,loginLog),false);
 assert.equal(b.verifiedAuthorization(saved,oldLog,loginLog.replaceAll('41474541110','41474541111')),false);
 assert.equal(b.verifiedAuthorization(saved,oldLog,loginLog+'\n'+fixture('41474541110','LOGIN','rejected',null,'error')),false);
 assert.equal(b.verifiedAuthorization(saved,oldLog.replace('"completed":0','"completed":1'),loginLog),false);
});
test('full API benchmark configuration keeps production workers, sequential searches and privacy',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'benchmark-config-'));
 try{
  const template={workers:{doDailySet:true,doDailyCheckIn:true,doReadToEarn:true,doMobileSearch:true,doDesktopSearch:true,doMorePromotions:true,doPunchCards:true,doClaimBonusPoints:true,doVisualSearch:true},activities:{urlReward:true,searchOnBing:true},searchSettings:{parallelSearching:true,runOnZeroPoints:true},experimental:{edgeBrowsing:false}};
  fs.writeFileSync(dir+'/package.json',JSON.stringify({version:'5.0.0'}));fs.writeFileSync(dir+'/config.example.json',JSON.stringify(template));
  const env={...process.env,...scope,BOT_DIR:dir,RUNNER_TEMP:dir};
  const r=spawnSync(process.execPath,[path.join(__dirname,'rewards-runner.cjs'),'configure'],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const c=JSON.parse(fs.readFileSync(dir+'/config.json'));assert.equal(c.rewardsMode,'api');
  for(const key of Object.keys(template.workers))assert.equal(c.workers[key],key!=='doVisualSearch');
  assert.equal(c.searchSettings.parallelSearching,false);assert.equal(c.searchSettings.runOnZeroPoints,false);assert.equal(c.experimental.edgeBrowsing,true);
  assert.equal(c.debugLogs,false);assert.equal(c.errorDiagnostics,false);
  const denied=spawnSync(process.execPath,[path.join(__dirname,'rewards-runner.cjs'),'configure'],{env:{...env,ACCOUNT_SLOT:'3'},encoding:'utf8'});assert.notEqual(denied.status,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('benchmark creates one private claim without touching daily state and seeds only verified unused budgets',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'benchmark-claim-')),prev={...process.env};let record=null;const puts=[];
 try{
  Object.assign(process.env,scope,{RUNNER_TEMP:dir,GITHUB_OUTPUT:dir+'/out',GITHUB_RUN_ID:'999',GITHUB_RUN_ATTEMPT:'1'});
  t.mock.method(Date,'now',()=>at('22:58:00'));t.mock.method(state,'requirePrivateReports',async()=>{});
  t.mock.method(state,'api',async(route,options={})=>{
   if(options.method==='PUT'){puts.push(route);record=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));return {content:{sha:'created'}};}
   const content=route.includes('/benchmarks/')?(record?JSON.stringify(record):null):route.includes('/state/')?JSON.stringify(saved):route.includes('/diagnostics/')?loginLog:oldLog;
   return content===null?null:{sha:'fixture',content:Buffer.from(content).toString('base64')};
  });
  const before=JSON.stringify(saved);await b.claim();assert.equal(puts.length,1);assert.match(puts[0],/^\/contents\/benchmarks\//);
  assert.equal(record.status,'running');assert.equal(record.accountId,4);assert.equal(JSON.stringify(saved),before);
  const budget=JSON.parse(fs.readFileSync(dir+'/rewards-private/reading-budget.json'));assert.equal(budget.points,30);assert.equal(budget.verified,true);
  await b.claim();assert.equal(puts.length,1);assert.ok(fs.readFileSync(dir+'/out','utf8').endsWith('run=false\n'));
 }finally{for(const k of Object.keys(process.env))if(!(k in prev))delete process.env[k];Object.assign(process.env,prev);fs.rmSync(dir,{recursive:true,force:true})}
});

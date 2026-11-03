'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const r=require('./rewards-account-2-reconcile-2026-11-03.cjs'),api=require('./rewards-state.cjs');
const now=Date.parse(r.DATE+'T12:25:00+07:00');
const scope={RUN_DATE:r.DATE,RUN_MODE:'reconcile',ACCOUNT_SLOT:'2',GITHUB_RUN_ID:'999',GITHUB_RUN_ATTEMPT:'1',ACCOUNT_2_REPAIR_APPROVED:r.APPROVAL};
const prior=run=>({status:'failed',errorCode:'AUTH_REQUIRED',diagnostic:{stage:'LOGIN'},runId:run,runAttempt:'1',finishedAt:r.DATE+'T05:00:00Z'});
const saved={schema:1,date:r.DATE,accountId:2,morning:prior(r.PRIOR.morning),retry:prior(r.PRIOR.retry)};
function event(run,title,data,message='',platform='DESKTOP',level='info') {return '__REWARDS_EVENT__ '+JSON.stringify({version:2,runId:`${r.DATE}:2:${run}`,ts:r.DATE+'T05:12:00Z',platform,title,data,message,level});}
const logs=Object.fromEntries(Object.entries(r.PRIOR).map(([mode,run])=>[mode,event(run,'ACCOUNT-END',{kind:'account',status:'failed',pointsKnown:false,reason:'Microsoft login error: fixture',completion:{counts:{completed:0}}})]));
const proof=[...['desktop','mobile'].flatMap(p=>[event(r.PROOF_RUN,'SESSION-GENERATION',{kind:'session',platform:p,status:'running'}),event(r.PROOF_RUN,'LOGIN-TOTP',null,'TOTP challenge advanced; continuing login verification',p.toUpperCase()),event(r.PROOF_RUN,'SESSION-GENERATION',{kind:'session',platform:p,status:'completed'})]),event(r.PROOF_RUN,'SESSIONS-END',null,'saved=2 failed=0')].join('\n');
test('manual repair is restricted to account2/date/first attempt, normal daily budget and explicit current proof',()=>{
  assert.equal(r.authorized(scope,now),true);assert.equal(r.eligible(saved,logs,proof,now),true);
  for(const c of [{ACCOUNT_SLOT:'3'},{RUN_DATE:'2026-11-04'},{RUN_MODE:'retry'},{GITHUB_RUN_ATTEMPT:'2'},{ACCOUNT_2_REPAIR_APPROVED:''}])assert.equal(r.authorized({...scope,...c},now),false);
  assert.equal(r.authorized(scope,Date.parse(r.DATE+'T22:10:01+07:00')),false);
  assert.equal(r.eligible(saved,logs,proof,Date.parse(r.DATE+'T14:00:00+07:00')),false);
});
test('old claims, genuine activity, stale/partial/other-account proof and any earlier reconciliation fail closed',()=>{
  for(const state of [{...saved,accountId:3},{...saved,reconcile:null},{...saved,'app-test':{status:'completed'}},{...saved,retry:{...saved.retry,status:'running'}}])assert.equal(r.eligible(state,logs,proof,now),false);
  for(const log of [proof.replaceAll('"mobile"','"desktop"'),proof.replaceAll(':2:',':3:'),proof+'\n'+event(r.PROOF_RUN,'LOGIN',null,'error','MOBILE','error')])assert.equal(r.eligible(saved,logs,log,now),false);
  assert.equal(r.eligible(saved,{...logs,retry:logs.retry+'\n'+event(r.PRIOR.retry,'ACTIVITY-RESULT',{kind:'activity',activity:'doReadToEarn',status:'completed',pointsGained:3})},proof,now),false);
});
test('single SHA-leased reconciliation keeps both old claims immutable and prevents reuse or conflicting execution',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'account2-reconcile-')),previous={...process.env};let record=structuredClone(saved),writes=0,conflict=false;
  try {
    Object.assign(process.env,scope,{RUNNER_TEMP:dir,GITHUB_OUTPUT:dir+'/out'});
    t.mock.method(Date,'now',()=>now);t.mock.method(api,'requirePrivateReports',async()=>{});
    t.mock.method(api,'api',async(route,options={})=>{
      if(options.method==='PUT'){if(conflict)throw new Error('SHA conflict');const b=JSON.parse(options.body);assert.equal(b.sha,'expected-sha');record=JSON.parse(Buffer.from(b.content,'base64'));writes++;return {};}
      const content=route.includes('/state/')?JSON.stringify(record):route.includes('/diagnostics/')?proof:route.includes(r.PRIOR.morning)?logs.morning:logs.retry;
      return {sha:'expected-sha',content:Buffer.from(content).toString('base64')};
    });
    await r.claim();assert.equal(writes,1);assert.deepEqual(record.morning,saved.morning);assert.deepEqual(record.retry,saved.retry);assert.equal(record.reconcile.status,'running');
    assert.equal(JSON.parse(fs.readFileSync(dir+'/rewards-private/reading-budget.json')).points,30);
    await assert.rejects(r.claim());assert.equal(writes,1);
    record=structuredClone(saved);conflict=true;fs.unlinkSync(dir+'/out');await assert.rejects(r.claim());assert.equal(fs.existsSync(dir+'/out'),false);
  } finally {for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);fs.rmSync(dir,{recursive:true,force:true});}
});

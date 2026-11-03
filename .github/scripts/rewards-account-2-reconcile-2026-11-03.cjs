'use strict';
// One explicit user-requested validation after the Mobile login fix. Never reopen an earlier attempt.
const fs=require('node:fs'),path=require('node:path');
const DATE='2026-11-03',SLOT=2,PROOF_RUN='41582315166';
const PRIOR={morning:'41508759619',retry:'41580247741'};
const APPROVAL=`${DATE}:${SLOT}:${PROOF_RUN}`;
function authorized(env=process.env,now=Date.now()) {
  return env.RUN_DATE===DATE && env.RUN_MODE==='reconcile' && String(env.ACCOUNT_SLOT)==='2' &&
    env.ACCOUNT_2_REPAIR_APPROVED===APPROVAL && env.GITHUB_RUN_ATTEMPT==='1' && /^\d+$/.test(env.GITHUB_RUN_ID||'') &&
    require('./rewards-schedule.cjs').canStart(DATE,now,'reconcile',env);
}
function events(log,run) {
  return String(log).split('\n').flatMap(line=>{
    const marker='__REWARDS_EVENT__ ',at=line.indexOf(marker);
    if(at<0||line.length>262144)return [];
    try {
      const e=JSON.parse(line.slice(at+marker.length)),ts=Date.parse(e.ts);
      return e.version===2&&e.runId===`${DATE}:${SLOT}:${run}`&&Number.isFinite(ts)&&
        require('./rewards-schedule.cjs').dateVN(ts)===DATE?[e]:[];
    } catch{return []}
  });
}
function noEarlierCredit(log,run) {
  const es=events(log,run),end=es.findLast(e=>e.title==='ACCOUNT-END')?.data;
  return end?.kind==='account'&&end.status==='failed'&&end.pointsKnown===false&&end.completion?.counts?.completed===0&&
    typeof end.reason==='string'&&end.reason.startsWith('Microsoft login error:')&&
    !/DAILY_READING_CREDIT|DAILY_SEARCH_CREDIT/.test(log)&&
    es.filter(e=>e.data?.kind==='activity').every(e=>
      ['doEnsureStreakProtection','mobile-search-quota','desktop-search-quota'].includes(e.data.activity)&&
      ['skipped','unconfirmed'].includes(e.data.status)&&e.data.pointsGained===0);
}
function eligible(state,logs,proof,now=Date.now()) {
  if(state?.schema!==1||state.date!==DATE||state.accountId!==SLOT||Object.hasOwn(state,'reconcile'))return false;
  if(Object.entries(state).some(([k,e])=>!Object.hasOwn(PRIOR,k)&&e&&typeof e==='object'&&(e.status||e.runId||e.finishedAt||e.history?.length)))return false;
  for(const [mode,run] of Object.entries(PRIOR)) {
    const e=state[mode];
    if(e?.status!=='failed'||e.errorCode!=='AUTH_REQUIRED'||e.diagnostic?.stage!=='LOGIN'||e.runId!==run||e.runAttempt!=='1'||
      !noEarlierCredit(logs[mode],run))return false;
  }
  if(!require('./rewards-login-probe.cjs').verifiedSessionProbe(proof,{RUN_DATE:DATE,ACCOUNT_SLOT:'2',GITHUB_RUN_ID:PROOF_RUN},{exitCode:0,signal:null}))return false;
  const es=events(proof,PROOF_RUN),end=es.findLast(e=>e.title==='SESSIONS-END'),ended=Date.parse(end?.ts);
  return Number.isFinite(ended)&&ended>Math.max(...Object.keys(PRIOR).map(k=>Date.parse(state[k].finishedAt)))&&ended<=now&&now-ended<=90*60000&&
    ['DESKTOP','MOBILE'].every(p=>es.some(e=>e.platform===p&&e.title==='LOGIN-TOTP'&&e.message==='TOTP challenge advanced; continuing login verification'));
}
const route=`/contents/state/${DATE}/account-${SLOT}.json`;
const text=file=>file?Buffer.from(file.content,'base64').toString('utf8'):'';
async function claim() {
  if(!authorized())throw new Error('Validation scope/window expired');
  const api=require('./rewards-state.cjs');await api.requirePrivateReports();
  const [saved,morning,retry,proof]=await Promise.all([
    api.api(route+'?ref=rewards-state',{},true),
    ...Object.values(PRIOR).map(run=>api.api(`/contents/logs/${DATE}/account-2-run-${run}-attempt-1.log?ref=rewards-state`,{},true)),
    api.api(`/contents/diagnostics/${DATE}/account-2-run-${PROOF_RUN}-attempt-1.log?ref=rewards-state`,{},true)
  ]);
  const state=saved?JSON.parse(text(saved)):null;
  if(!saved?.sha||!eligible(state,{morning:text(morning),retry:text(retry)},text(proof)))throw new Error('Validation evidence unavailable or claim already exists');
  const next={...state,reconcile:{status:'running',retryable:false,errorCode:null,runId:process.env.GITHUB_RUN_ID,
    runAttempt:process.env.GITHUB_RUN_ATTEMPT,startedAt:new Date().toISOString(),readingPointsBudget:30,
    authDiagnosticRunId:PROOF_RUN,authorization:'user_requested_after_verified_mobile_fix'}};
  await api.api(route,{method:'PUT',body:JSON.stringify({branch:'rewards-state',sha:saved.sha,
    message:'Reserve user-requested account-2 reconciliation after verified login fix',content:Buffer.from(JSON.stringify(next,null,2)+'\n').toString('base64')})});
  const folder=path.join(process.env.RUNNER_TEMP,'rewards-private');fs.mkdirSync(folder,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(folder,'reading-budget.json'),JSON.stringify({date:DATE,accountId:SLOT,points:30,verified:true}),{mode:0o600});
  fs.writeFileSync(path.join(folder,'search-budget.json'),JSON.stringify({schema:1,date:DATE,accountId:SLOT,
    progress:require('./rewards-search-ledger.cjs').progress(state.searchReview)}),{mode:0o600});
  fs.appendFileSync(process.env.GITHUB_OUTPUT,'stored=true\nrun=true\n');
  console.log('One account reconciliation reserved privately; previous attempts preserved.');
}
module.exports={DATE,SLOT,PROOF_RUN,PRIOR,APPROVAL,authorized,eligible,claim};
if(require.main===module)claim().catch(()=>{console.error('Account validation authorization/storage failed; bot not started.');process.exitCode=1;});

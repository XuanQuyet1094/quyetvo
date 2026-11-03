'use strict';
// One user-authorized retry after a separately verified credential update.
// Existing claims/errors remain immutable; ordinary automatic auth guards are unchanged.
const fs = require('node:fs');
const path = require('node:path');
const DATE = '2026-11-03', SLOT = 2, AUTH_RUN = '41579652732', PRIOR_RUN = '41508759619';
const APPROVAL = `${DATE}:${SLOT}:${AUTH_RUN}`;
function authorized(env = process.env, now = Date.now()) {
  return env.RUN_DATE === DATE && env.RUN_MODE === 'retry' && String(env.ACCOUNT_SLOT) === String(SLOT) &&
    env.AUTH_RESUME_APPROVED === APPROVAL && env.GITHUB_RUN_ATTEMPT === '1' && /^\d+$/.test(env.GITHUB_RUN_ID || '') &&
    require('./rewards-schedule.cjs').canStart(DATE, now, 'retry', env);
}
function events(log, runId) {
  return String(log).split('\n').flatMap(line => {
    const marker = '__REWARDS_EVENT__ ', at = line.indexOf(marker);
    if (at < 0 || line.length > 262144) return [];
    try {
      const e = JSON.parse(line.slice(at + marker.length));
      return e.version === 2 && e.runId === `${DATE}:${SLOT}:${runId}` && Number.isFinite(Date.parse(e.ts)) &&
        new Date(Date.parse(e.ts) + 7 * 3600000).toISOString().slice(0, 10) === DATE ? [e] : [];
    } catch { return []; }
  });
}
function noActivities(end, list) {
  const counts = end?.completion?.counts;
  return counts && ['completed','incomplete','unavailable','notApplicable'].every(k => counts[k] === 0) &&
    !list.some(e => e.data?.kind === 'activity');
}
function verifiedAuthorization(state, oldLog, loginLog, now = Date.now()) {
  const prior = state?.morning;
  if (state?.schema !== 1 || state.date !== DATE || state.accountId !== SLOT ||
      prior?.runId !== PRIOR_RUN || prior.runAttempt !== '1' || prior.status !== 'failed' ||
      prior.errorCode !== 'AUTH_REQUIRED' || prior.diagnostic?.stage !== 'LOGIN' ||
      Object.hasOwn(state,'retry') || Object.hasOwn(state,'reconcile')) return false;
  if (Object.entries(state).some(([key,e]) => key !== 'morning' && e && typeof e === 'object' &&
      (e.runId || e.finishedAt || e.status || e.history?.length))) return false;
  const old = events(oldLog, PRIOR_RUN), login = events(loginLog, AUTH_RUN);
  const oldEnd = old.findLast(e => e.title === 'ACCOUNT-END')?.data;
  const loginEvent = login.findLast(e => e.title === 'ACCOUNT-END'), loginEnd = loginEvent?.data;
  const ended = Date.parse(loginEvent?.ts);
  return oldEnd?.kind === 'account' && oldEnd.status === 'failed' && oldEnd.pointsKnown === false &&
    typeof oldEnd.reason === 'string' && oldEnd.reason.startsWith('Microsoft login error:') && noActivities(oldEnd, old) &&
    !old.some(e => e.title === 'LOGIN-STATE' && e.message === 'state=LOGGED_IN') &&
    loginEnd?.kind === 'account' && loginEnd.status === 'completed' && loginEnd.pointsKnown === true &&
    Number.isSafeInteger(loginEnd.initialPoints) && loginEnd.initialPoints >= 0 &&
    loginEnd.currentBalance === loginEnd.initialPoints && loginEnd.pointsGained === 0 && noActivities(loginEnd, login) &&
    !login.some(e => e.level === 'error') &&
    login.some(e => e.platform === 'DESKTOP' && e.title === 'LOGIN-TOTP' && e.message === 'TOTP challenge advanced; continuing login verification') &&
    login.some(e => e.platform === 'DESKTOP' && e.title === 'LOGIN-STATE' && e.message === 'state=LOGGED_IN') &&
    Number.isFinite(ended) && ended > Date.parse(prior.finishedAt) && ended <= now && now - ended <= 90 * 60000;
}
const route = `/contents/state/${DATE}/account-${SLOT}.json`;
const logText = file => file ? Buffer.from(file.content, 'base64').toString('utf8') : '';
async function claim() {
  if (!authorized()) throw new Error('Auth resume scope/window expired');
  const stateAPI = require('./rewards-state.cjs');
  await stateAPI.requirePrivateReports();
  const [saved, oldFile, loginFile] = await Promise.all([
    stateAPI.api(route + '?ref=rewards-state', {}, true),
    stateAPI.api(`/contents/logs/${DATE}/account-${SLOT}-run-${PRIOR_RUN}-attempt-1.log?ref=rewards-state`, {}, true),
    stateAPI.api(`/contents/diagnostics/${DATE}/account-${SLOT}-run-${AUTH_RUN}-attempt-1.log?ref=rewards-state`, {}, true)
  ]);
  const state = saved ? JSON.parse(logText(saved)) : null;
  if (!saved?.sha || !verifiedAuthorization(state, logText(oldFile), logText(loginFile)))
    throw new Error('Auth resume evidence unavailable, stale, or attempt already claimed');
  const value = {...state, retry: {status:'running',retryable:false,errorCode:null,
    runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,startedAt:new Date().toISOString(),
    readingPointsBudget:30,authDiagnosticRunId:AUTH_RUN,authorization:'user_requested_after_verified_totp'}};
  // Update only the previously absent retry slot, with a SHA lease. Never remove an auth failure.
  await stateAPI.api(route, {method:'PUT',body:JSON.stringify({branch:'rewards-state',sha:saved.sha,
    message:'Reserve one account retry after verified TOTP update',
    content:Buffer.from(JSON.stringify(value,null,2)+'\n').toString('base64')})});
  const folder = path.join(process.env.RUNNER_TEMP,'rewards-private');
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  // Both immutable receipts prove no earning activity ran today; live Microsoft quota is still required.
  fs.writeFileSync(path.join(folder,'reading-budget.json'),JSON.stringify({date:DATE,accountId:SLOT,points:30,verified:true}),{mode:0o600});
  fs.writeFileSync(path.join(folder,'search-budget.json'),JSON.stringify({schema:1,date:DATE,accountId:SLOT,
    progress:require('./rewards-search-ledger.cjs').progress(state.searchReview)}),{mode:0o600});
  fs.appendFileSync(process.env.GITHUB_OUTPUT,'stored=true\nrun=true\n');
  console.log('One verified account retry reserved privately; earlier claims preserved.');
}
module.exports = {DATE,SLOT,AUTH_RUN,PRIOR_RUN,APPROVAL,authorized,verifiedAuthorization,claim};
if (require.main === module) claim().catch(() => {
  console.error('Account retry authorization/storage failed; no bot launched.');process.exitCode=1;
});

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DATE = '2026-11-02';
const MODE = 'api-benchmark';
const AUTH_RUN = '41474541110';
const PRIOR_RUN = '41341117178';
const LIMIT_MS = 30 * 60000;
const END = Date.parse(DATE + 'T23:59:30+07:00');
function authorized(date, mode, env = process.env) {
  return date === DATE && mode === MODE && env.API_BENCHMARK_DATE === DATE && String(env.ACCOUNT_SLOT) === '4';
}
function canStart(env = process.env, now = Date.now()) {
  return authorized(env.RUN_DATE, env.RUN_MODE, env) &&
    new Date(now + 7 * 3600000).toISOString().slice(0, 10) === DATE &&
    now >= Date.parse(DATE + 'T22:50:00+07:00') && END - now >= LIMIT_MS;
}
function events(log, runId) {
  const result = [];
  for (const line of String(log).split('\n')) {
    const marker = '__REWARDS_EVENT__ ';
    const at = line.indexOf(marker);
    if (at < 0) continue;
    try {
      const e = JSON.parse(line.slice(at + marker.length));
      const ts = Date.parse(e.ts);
      if (e.version === 2 && e.runId === `${DATE}:4:${runId}` && Number.isFinite(ts) &&
          new Date(ts + 7 * 3600000).toISOString().slice(0, 10) === DATE) result.push(e);
    } catch {}
  }
  return result;
}
function verifiedAuthorization(state, oldLog, loginLog) {
  if (state?.schema !== 1 || state.date !== DATE || state.accountId !== 4 ||
      state.morning?.runId !== PRIOR_RUN || state.morning.status !== 'failed' ||
      state.morning.errorCode !== 'AUTH_REQUIRED' || state.morning.diagnostic?.stage !== 'LOGIN') return false;
  if (Object.entries(state).some(([key,e]) => e && typeof e === 'object' &&
      (e.status === 'running' || (key !== 'morning' && (e.runId || e.finishedAt))))) return false;
  const old = events(oldLog, PRIOR_RUN), login = events(loginLog, AUTH_RUN);
  const oldEnd = old.findLast(e => e.title === 'ACCOUNT-END')?.data;
  const loginEnd = login.findLast(e => e.title === 'ACCOUNT-END')?.data;
  return oldEnd?.status === 'failed' && oldEnd.pointsKnown === false &&
    oldEnd.completion?.counts?.completed === 0 &&
    oldEnd.reason === 'Login failed or aborted at state: SIGN_IN_METHOD_PICKER' &&
    !old.some(e => e.title === 'LOGIN-STATE' && e.message === 'state=LOGGED_IN') &&
    loginEnd?.status === 'completed' && loginEnd.pointsGained === 0 &&
    loginEnd.completion?.counts?.completed === 0 &&
    !login.some(e => e.level === 'error') &&
    login.some(e => e.platform === 'DESKTOP' && e.title === 'LOGIN-STATE' && e.message === 'state=LOGGED_IN') &&
    login.some(e => e.platform === 'DESKTOP' && e.title === 'LOGIN-TOTP' &&
      e.message === 'TOTP challenge advanced; continuing login verification');
}
const route = `/contents/benchmarks/${DATE}/account-4.json`;
const decode = file => JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
const logText = file => file ? Buffer.from(file.content, 'base64').toString('utf8') : '';
function output(key, value) { fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); }
function runReference() {
  const runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!/^\d+$/.test(runId || '') || attempt !== '1') throw new Error('Invalid benchmark run reference');
  return {runId, attempt};
}
async function claim() {
  if (!canStart()) throw new Error('Benchmark authorization/window expired');
  const ref = runReference(), state = require('./rewards-state.cjs');
  await state.requirePrivateReports();
  if (await state.api(route + '?ref=rewards-state', {}, true)) {
    output('run', 'false'); console.log('Skipped: the authorized benchmark was already reserved.'); return;
  }
  const [saved, oldLog, loginLog] = await Promise.all([
    state.api(`/contents/state/${DATE}/account-4.json?ref=rewards-state`, {}, true),
    state.api(`/contents/logs/${DATE}/account-4-run-${PRIOR_RUN}-attempt-1.log?ref=rewards-state`, {}, true),
    state.api(`/contents/diagnostics/${DATE}/account-4-run-${AUTH_RUN}-attempt-1.log?ref=rewards-state`, {}, true)
  ]);
  if (!saved || !verifiedAuthorization(decode(saved), logText(oldLog), logText(loginLog)))
    throw new Error('Benchmark authentication/no-earlier-credit evidence unavailable');
  const value = {schema:1,date:DATE,accountId:4,mode:MODE,status:'running',runId:ref.runId,
    runAttempt:ref.attempt,startedAt:new Date().toISOString(),authDiagnosticRunId:AUTH_RUN,limitSeconds:1800};
  // No SHA: this is create-only. A concurrent reservation fails closed; old daily claims are never edited.
  await state.api(route, {method:'PUT',body:JSON.stringify({branch:'rewards-state',
    message:'Reserve one user-authorized API benchmark',content:Buffer.from(JSON.stringify(value)).toString('base64')})});
  const folder = path.join(process.env.RUNNER_TEMP, 'rewards-private');
  fs.mkdirSync(folder, {recursive:true,mode:0o700});
  fs.writeFileSync(path.join(folder,'reading-budget.json'),JSON.stringify({date:DATE,accountId:4,points:30,verified:true}),{mode:0o600});
  fs.writeFileSync(path.join(folder,'search-budget.json'),JSON.stringify({schema:1,date:DATE,accountId:4,
    progress:{mobile:{points:0,target:60,verified:true},desktop:{points:0,target:90,verified:true}}}),{mode:0o600});
  output('stored','true'); output('run','true');
  console.log('One-account API benchmark reserved privately; ordinary daily claims preserved.');
}
async function finish() {
  if (!authorized(process.env.RUN_DATE,process.env.RUN_MODE)) throw new Error('Invalid benchmark scope');
  const ref = runReference(), state = require('./rewards-state.cjs');
  await state.requirePrivateReports();
  const file = await state.api(route + '?ref=rewards-state');
  const record = decode(file);
  if (record.runId !== ref.runId || record.runAttempt !== ref.attempt || record.status !== 'running')
    throw new Error('Benchmark attempt ownership mismatch');
  let result;
  try { result = JSON.parse(fs.readFileSync(process.env.REPORT_PATH,'utf8')); }
  catch { result = {accountId:4,date:DATE,status:'failed',errorCode:'SETUP_FAILED'}; }
  const safe = state.safeReport(result,4,DATE);
  const logs = {};
  for (const [key, local, folder] of [['logPath','account-4.log','logs'],['setupLogPath','setup-account-4.log','setup-logs']]) {
    const source = path.join(process.env.RUNNER_TEMP,'rewards-private',local);
    if (!fs.existsSync(source)) continue;
    let content = fs.readFileSync(source,'utf8');
    content = require('./rewards-runner.cjs').redactLog(content,process.env);
    if (Buffer.byteLength(content) > 900*1024) content = Buffer.from(content).subarray(-900*1024).toString('utf8');
    const location = `${folder}/${DATE}/account-4-run-${ref.runId}-attempt-${ref.attempt}.log`;
    await state.api('/contents/'+location,{method:'PUT',body:JSON.stringify({branch:'rewards-state',
      message:'Save redacted API benchmark log',content:Buffer.from(content).toString('base64')})});
    logs[key] = location;
  }
  const durationSeconds = Number.isSafeInteger(result.durationSeconds) && result.durationSeconds >= 0 ? result.durationSeconds : null;
  const value = {...record,...safe,...logs,durationSeconds,finishedAt:new Date().toISOString(),
    exitCode:Number.isSafeInteger(result.exitCode)?result.exitCode:null,
    wallSeconds:Math.max(0,Math.round((Date.now()-Date.parse(record.startedAt))/1000))};
  await state.api(route,{method:'PUT',body:JSON.stringify({branch:'rewards-state',sha:file.sha,
    message:'Finish user-authorized API benchmark',content:Buffer.from(JSON.stringify(value)).toString('base64')})});
  console.log('API benchmark result, timing and redacted logs saved privately.');
}
module.exports = {DATE,MODE,LIMIT_MS,END,authorized,canStart,verifiedAuthorization,claim,finish};
if (require.main === module) {
  const op = process.argv[2];
  (async()=>{
    if (op === 'window') { output('run',canStart()?'true':'false'); return; }
    if (op === 'claim') return claim();
    if (op === 'finish') return finish();
    throw new Error('Invalid benchmark operation');
  })().catch(()=>{console.error('API benchmark guard/storage failed; details suppressed.');process.exitCode=1;});
}

'use strict';
const fs = require('node:fs');
const path = require('node:path');
function privateRepository() {
  const value = process.env.REWARDS_PRIVATE_REPO || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('Missing or invalid REWARDS_PRIVATE_REPO');
  }
  return value;
}
const BRANCH = 'rewards-state';
const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const transient = new Set(['NETWORK_TIMEOUT', 'ACCOUNT_TIMEOUT', 'HTTP_408', 'HTTP_425', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']);
const network = new Set(['ERR_EMPTY_RESPONSE', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_SOCKS_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_RESET']);
const blocked = new Set(['DAILY_WINDOW_EXPIRED', 'AUTH_REQUIRED', 'ACCOUNT_LOCKED', 'BOT_WARNING', 'PASSWORD_NOT_CONFIGURED', 'MICROSOFT_LOGIN_ERROR', 'MICROSOFT_LOGIN_UNKNOWN_ERROR',
  'TOTP_METHOD_SELECTION_FAILED', 'TOTP_SECRET_INVALID', 'TOTP_SECRET_MISSING',
  'TOTP_REJECTED', 'TOTP_INPUT_MISSING', 'TOTP_SUBMIT_FAILED', 'TOTP_NOT_ADVANCED']);
const diagnosticErrors = new Set([...network, ...blocked, 'TRANSIENT_LOGIN_ALERT',
  'BROWSER_EXECUTABLE_MISSING', 'BROWSER_LIBRARY_MISSING', 'DISPLAY_MISSING',
  'BROWSER_OR_CONTEXT_CLOSED', 'TIMEOUT', 'CHROMEWEBDATA_ERROR', 'UNCLASSIFIED_ERROR', 'TOTP_NOT_OFFERED']);
const diagnosticStages = new Set(['STARTING', 'BROWSER', 'SESSION', 'LOGIN',
  'LOGIN-TOTP', 'LOGIN-ENTER-EMAIL', 'LOGIN-ENTER-PASSWORD', 'DAILY-SET', 'READ-TO-EARN',
  'SEARCH-MANAGER', 'SEARCH-BING']);
const diagnosticLoginStates = new Set(['EMAIL_INPUT', 'FOOTER_ACTION', 'PASSWORD_INPUT',
  'KMSI_PROMPT', 'ERROR_ALERT', 'EMAIL_VERIFICATION_INPUT', 'RECOVERY_EMAIL_INPUT',
  'SIGN_IN_METHOD_PICKER', '2FA_TOTP', 'LOGIN_PASSWORDLESS', 'PASSWORDLESS_SEND_CODE',
  'OTP_CODE_ENTRY', 'PASSKEY_ERROR', 'PASSKEY_VIDEO', 'ACCOUNT_LOCKED', 'LOGGED_IN',
  'UNKNOWN', 'CHROMEWEBDATA_ERROR']);
function safeDiagnostic(value) {
  // Persist only fixed labels. Never include raw text, URLs, account identity or tokens.
  const stage = diagnosticStages.has(value?.stage) ? value.stage : null;
  const loginState = diagnosticLoginStates.has(value?.loginState) ? value.loginState : null;
  const errors = [...new Set((Array.isArray(value?.errors) ? value.errors : [])
    .filter(label => diagnosticErrors.has(label)))];
  return stage || loginState || errors.length ? {stage, loginState, errors} : null;
}
function retryable(r) {
  if (!r || r.status !== 'failed') return false;
  const labels = [r.errorCode, ...(r.diagnostic?.errors || [])];
  if (labels.some(x => blocked.has(x))) return false;
  return transient.has(r.errorCode) || labels.some(x => network.has(x));
}
function eligible(state, date, slot) {
  return Boolean(state && state.schema === 1 && state.date === date && state.accountId === slot &&
    state.morning?.status === 'failed' && state.morning.retryable === true && !state.retry);
}
function stateResult(r) {
  const result = {status: ['completed', 'failed', 'needs_action'].includes(r.status) ? r.status : 'failed',
    retryable: retryable(r), errorCode: typeof r.errorCode === 'string' && /^[A-Z_0-9]{1,50}$/.test(r.errorCode) ? r.errorCode : null};
  const diagnostic = safeDiagnostic(r.diagnostic);
  if (diagnostic) result.diagnostic = diagnostic;
  return result;
}
async function api(route, options = {}, allow404 = false) {
  const response = await fetch(`https://api.github.com/repos/${privateRepository()}${route}`, {
    ...options, headers: {Authorization: `Bearer ${process.env.REWARDS_STATE_TOKEN}`,
      Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'}, signal: AbortSignal.timeout(20000)
  });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`State API status ${response.status}`);
  return response.json();
}
function context() {
  const date = process.env.RUN_DATE;
  const slot = Number(process.env.ACCOUNT_SLOT);
  const mode = process.env.RUN_MODE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || ![1,2,3,4,5,6].includes(slot) || !['morning','retry','diagnostic','test','app-test','app-auth-probe','app-read-test'].includes(mode)) throw new Error('Invalid state context');
  return {date, slot, mode, file: `/contents/state/${date}/account-${slot}.json`};
}
async function get(ctx) {
  const repo = await api('');
  if (repo.private !== true) throw new Error('State repository must be private');
  await api(`/branches/${BRANCH}`); // A missing branch is a setup error, not missing daily state.
  const file = await api(`${ctx.file}?ref=${BRANCH}`, {}, true);
  if (!file) return {state: null, sha: undefined};
  const state = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  if (state.schema !== 1 || state.date !== ctx.date || state.accountId !== ctx.slot) throw new Error('Invalid saved state');
  return {state, sha: file.sha};
}
async function put(ctx, state, sha) {
  await api(ctx.file, {method: 'PUT', body: JSON.stringify({branch: BRANCH, sha,
    message: `Update ${ctx.date} account ${ctx.slot} ${ctx.mode} state`,
    content: Buffer.from(JSON.stringify(state, null, 2) + '\n').toString('base64')})});
}
function output(key, value) { fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); }
async function claim() {
  const ctx = context();
  if (ctx.date !== today()) { output('run', 'false'); console.log('Skipped: run date is no longer today in Vietnam.'); return; }
  if (!require('./rewards-schedule.cjs').canStart(ctx.date, Date.now(), ctx.mode)) {
    output('run', 'false'); console.log('Skipped: insufficient daily execution budget; no attempt reserved.'); return;
  }
  if (!process.env.REWARDS_STATE_TOKEN) {
    if (ctx.mode === 'test') {
      console.log('::warning::REWARDS_STATE_TOKEN missing: one-account test disabled to prevent duplicate runs.');
      output('run', 'false');
    } else if (ctx.mode === 'morning') {
      console.log('::warning::REWARDS_STATE_TOKEN missing: morning run continues without saved retry state.');
      output('run', 'true'); output('stored', 'false');
    } else {
      console.log('::warning::REWARDS_STATE_TOKEN missing: afternoon retry disabled.');
      output('run', 'false');
    }
    return;
  }
  const {state: old, sha} = await get(ctx);
  const state = old || {schema: 1, date: ctx.date, accountId: ctx.slot};
  const probe = state['app-auth-probe'];
  const appReadObserved = probe?.authVerified === true || (probe?.history || []).some(entry => entry.authVerified === true);
  if ((ctx.mode === 'app-auth-probe' && (ctx.slot !== 1 || (state['app-auth-probe'] &&
        (state['app-auth-probe'].status === 'running' || state['app-test']?.checkInVerified === true ||
         (state['app-auth-probe'].history || []).length >= 5)))) ||
      (ctx.mode === 'retry' && !eligible(state, ctx.date, ctx.slot)) ||
      (ctx.mode === 'morning' && state.morning) ||
      (ctx.mode === 'test' && (ctx.slot !== 1 || state.test)) ||
      (ctx.mode === 'app-read-test' && (ctx.slot !== 1 || state['app-read-test'])) ||
      (ctx.mode === 'app-test' && (ctx.slot !== 1 || (state['app-test'] &&
        (state['app-test'].status === 'running' || state['app-test'].checkInVerified === true ||
         ((state['app-test'].history || []).length >= (appReadObserved ? 8 : 2) && state['app-test'].errorCode !== 'SETUP_FAILED') ||
         (state['app-test'].history || []).length >= (appReadObserved ? 9 : 3)))))) {
    output('run', 'false'); console.log('Skipped: no eligible new attempt for this account today.'); return;
  }
  // Claim BEFORE the bot starts. Cancellation or re-running a job cannot reset the retry budget.
  const history = ['app-test', 'app-auth-probe'].includes(ctx.mode) && state[ctx.mode]
    ? [...(state[ctx.mode].history || []), {...state[ctx.mode], history: undefined}] : [];
  state[ctx.mode] = {...(history.length ? {history} : {}), status: 'running', retryable: false, errorCode: null,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    startedAt: new Date().toISOString()};
  await put(ctx, state, sha); // SHA conflict fails closed instead of launching a duplicate.
  output('stored', 'true'); output('run', 'true');
}
function privateLogLocation(ctx) {
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!/^\d+$/.test(runId || '') || !/^\d+$/.test(attempt || '')) throw new Error('Invalid run reference');
  const folder = ctx.mode === 'diagnostic' ? 'diagnostics' : 'logs';
  return `${folder}/${ctx.date}/account-${ctx.slot}-run-${runId}-attempt-${attempt}.log`;
}
async function uploadPrivateLog(ctx, kind = 'bot') {
  if (!process.env.REWARDS_STATE_TOKEN || !process.env.RUNNER_TEMP) return null;
  const localPath = path.join(process.env.RUNNER_TEMP, 'rewards-private', `${kind === 'setup' ? 'setup-' : ''}account-${ctx.slot}.log`);
  let content;
  try { content = fs.readFileSync(localPath, 'utf8'); } catch { return null; }
  // Keep GitHub Contents API payload well below its size limit.
  const maxBytes = 900 * 1024;
  if (Buffer.byteLength(content) > maxBytes) {
    content = Buffer.from(content).subarray(-maxBytes).toString('utf8');
    content = '[Earlier log lines omitted to fit the private storage limit.]\n' + content;
  }
  const location = kind === 'setup' ? privateLogLocation(ctx).replace(/^(logs|diagnostics)\//, 'setup-logs/') : privateLogLocation(ctx);
  const route = `/contents/${location.split('/').map(encodeURIComponent).join('/')}?ref=${BRANCH}`;
  const existing = await api(route, {}, true);
  const body = {branch: BRANCH, message: `Save redacted ${ctx.date} account ${ctx.slot} ${ctx.mode} log`,
    content: Buffer.from(content, 'utf8').toString('base64')};
  if (existing?.sha) body.sha = existing.sha;
  const putRoute = `/contents/${location.split('/').map(encodeURIComponent).join('/')}`;
  await api(putRoute, {method: 'PUT', body: JSON.stringify(body)});
  return location;
}
async function finish() {
  if (process.env.STATE_STORED !== 'true') return;
  const ctx = context();
  const {state, sha} = await get(ctx);
  const entry = state?.[ctx.mode];
  if (!entry || entry.runId !== process.env.GITHUB_RUN_ID || entry.runAttempt !== process.env.GITHUB_RUN_ATTEMPT) throw new Error('Attempt ownership mismatch');
  let result;
  try { result = JSON.parse(fs.readFileSync(process.env.REPORT_PATH, 'utf8')); }
  catch { result = {status: 'failed', errorCode: process.env.JOB_STATUS === 'cancelled' ? 'CANCELLED' : 'SETUP_FAILED'}; }
  if (result.accountId !== undefined && Number(result.accountId) !== ctx.slot) throw new Error('Wrong account result');
  let logPath = null, setupLogPath = null;
  try { setupLogPath = await uploadPrivateLog(ctx, 'setup'); }
  catch { console.warn('::warning::Private setup log upload failed; bot execution will not be repeated.'); }
  try { logPath = await uploadPrivateLog(ctx); }
  catch { console.error('Private bot log upload failed; private status will still be saved.'); }
  try { await uploadPrivateLog(ctx, 'setup'); }
  catch { console.error('Private setup log upload failed; status will still be saved.'); }
  state[ctx.mode] = {...entry, ...stateResult(result), ...(ctx.mode === 'app-test' ? {checkInVerified: result.appCheckInVerified === true} : {}), ...(ctx.mode === 'app-auth-probe' ? {authVerified: result.appAuthVerified === true} : {}), ...(logPath ? {logPath} : {}), ...(setupLogPath ? {setupLogPath} : {}), finishedAt: new Date().toISOString()};
  await put(ctx, state, sha);
  console.log(logPath ? 'Private result and redacted bot log saved to rewards-state.' : 'Private result saved; bot log was not available.');
}

function reportContext(env = process.env) {
  if (!env.REWARDS_STATE_TOKEN) throw new Error('Private reporting requires state credentials');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(env.RUN_DATE || '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '')) {
    throw new Error('Invalid private report context');
  }
  return {date: env.RUN_DATE, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT};
}
function reportRoute(ctx, slot) {
  return `/contents/reports/${ctx.date}/run-${ctx.runId}-attempt-${ctx.attempt}/account-${slot}.json`;
}
function safeReport(value, slot, date) {
  if (!value || value.accountId !== slot || value.date !== date ||
      !['completed', 'failed', 'needs_action'].includes(value.status)) {
    throw new Error('Invalid private report');
  }
  const metric = (v, nonnegative = false) => Number.isSafeInteger(v) && (!nonnegative || v >= 0) ? v : null;
  return {accountId: slot, date, status: value.status,
    appCheckIn: ['verified','auth_rejected','unverified','not_requested','unknown'].includes(value.appCheckIn) ? value.appCheckIn : 'unknown',
    pointsEarned: metric(value.pointsEarned),
    initialBalance: metric(value.initialBalance, true),
    finalBalance: metric(value.finalBalance, true),
    errorCode: typeof value.errorCode === 'string' && /^[A-Z_0-9]{1,50}$/.test(value.errorCode) ? value.errorCode : null};
}
async function requirePrivateReports() {
  if ((await api('')).private !== true) throw new Error('Reports repository must be private');
  await api(`/branches/${BRANCH}`);
}
async function savePrivateReport(value) {
  const ctx = reportContext();
  const slot = Number(process.env.ACCOUNT_SLOT);
  if (![1,2,3,4,5,6].includes(slot)) throw new Error('Invalid report slot');
  const report = safeReport(value, slot, ctx.date);
  await requirePrivateReports();
  const route = reportRoute(ctx, slot);
  const old = await api(`${route}?ref=${BRANCH}`, {}, true);
  await api(route, {method:'PUT', body: JSON.stringify({branch: BRANCH, sha: old?.sha,
    message: 'Save private run report',
    content: Buffer.from(JSON.stringify(report)).toString('base64')})});
}
async function readPrivateReports(jobs) {
  const ctx = reportContext();
  await requirePrivateReports();
  const result = {};
  for (const slot of [1,2,3,4,5,6]) {
    const job = jobs[`account_${slot}`] || {};
    const file = await api(`${reportRoute(ctx, slot)}?ref=${BRANCH}`, {}, true);
    const report = file ? safeReport(JSON.parse(Buffer.from(file.content,'base64').toString('utf8')), slot, ctx.date) : null;
    result[`account_${slot}`] = {...job, outputs: {result: report ? JSON.stringify(report) : ''}};
  }
  return result;
}

module.exports = {retryable, eligible, stateResult, claim, finish, savePrivateReport, readPrivateReports,
  api, requirePrivateReports, reportContext};
if (require.main === module) {
  const task = process.argv[2] === 'claim' ? claim :
    process.argv[2] === 'finish' ? finish :
    process.argv[2] === 'upload-log' ? async () => {
      const ctx = context();
      if (ctx.mode !== 'diagnostic') throw new Error('upload-log is only for diagnostic runs');
      const location = await uploadPrivateLog(ctx);
      const setup = await uploadPrivateLog(ctx, 'setup');
      if (!location && !setup) throw new Error('Private diagnostic log was not available');
      console.log('Private diagnostic/setup log saved.');
    } : null;
  if (!task) process.exitCode = 1;
  else task().catch(() => {
    console.error('State operation failed; bot will not be retried blindly. Check REWARDS_STATE_TOKEN (Contents: read/write on private repo) and rewards-state branch.');
    process.exitCode = 1;
  });
}

'use strict';
const fs = require('node:fs');
const REPO = 'XuanQuyet1094/Microsoft-Rewards-Script';
const BRANCH = 'rewards-state';
const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const transient = new Set(['NETWORK_TIMEOUT', 'ACCOUNT_TIMEOUT', 'HTTP_408', 'HTTP_425', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']);
const network = new Set(['ERR_EMPTY_RESPONSE', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_SOCKS_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_RESET']);
const blocked = new Set(['AUTH_REQUIRED', 'ACCOUNT_LOCKED', 'BOT_WARNING', 'PASSWORD_NOT_CONFIGURED', 'MICROSOFT_LOGIN_ERROR', 'MICROSOFT_LOGIN_UNKNOWN_ERROR']);
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
  return {status: ['completed', 'failed', 'needs_action'].includes(r.status) ? r.status : 'failed',
    retryable: retryable(r), errorCode: typeof r.errorCode === 'string' && /^[A-Z_0-9]{1,50}$/.test(r.errorCode) ? r.errorCode : null};
}
async function api(route, options = {}, allow404 = false) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${route}`, {
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || ![1,2,3,4,5,6].includes(slot) || !['morning','retry'].includes(mode)) throw new Error('Invalid state context');
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
  if (!process.env.REWARDS_STATE_TOKEN) {
    if (ctx.mode === 'morning') {
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
  if ((ctx.mode === 'retry' && !eligible(state, ctx.date, ctx.slot)) ||
      (ctx.mode === 'morning' && state.morning)) {
    output('run', 'false'); console.log('Skipped: no eligible new attempt for this account today.'); return;
  }
  // Claim BEFORE the bot starts. Cancellation or re-running a job cannot reset the retry budget.
  state[ctx.mode] = {status: 'running', retryable: false, errorCode: null,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    startedAt: new Date().toISOString()};
  await put(ctx, state, sha); // SHA conflict fails closed instead of launching a duplicate.
  output('stored', 'true'); output('run', 'true');
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
  state[ctx.mode] = {...entry, ...stateResult(result), finishedAt: new Date().toISOString()};
  await put(ctx, state, sha);
  console.log('Minimal result saved to private state branch.');
}
module.exports = {retryable, eligible, stateResult, claim, finish};
if (require.main === module) {
  const task = process.argv[2] === 'claim' ? claim : process.argv[2] === 'finish' ? finish : null;
  if (!task) process.exitCode = 1;
  else task().catch(() => {
    console.error('State operation failed; bot will not be retried blindly. Check REWARDS_STATE_TOKEN (Contents: read/write on private repo) and rewards-state branch.');
    process.exitCode = 1;
  });
}

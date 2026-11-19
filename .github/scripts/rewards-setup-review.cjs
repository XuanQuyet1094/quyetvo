'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SSH_STEP = 'Start verified AZDIGI SOCKS5 tunnel';
const BOT_STEP = 'Run selected activities within the configured time limit';
const timeoutLine = /^ssh: connect to host .+ port .+: Connection timed out$/;
const vnDate = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);

function sshTimeout(text) {
  return String(text).trim().split(/\r?\n/).some(line => timeoutLine.test(line.trim())) &&
    !/Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|invalid format|Load key|Could not resolve hostname/i.test(text);
}

// A fixed failure receipt lets state and Telegram agree, without printing SSH output publicly.
function recordSshFailure(file, env = process.env) {
  const slot = Number(env.ACCOUNT_SLOT);
  if (![1,2,3,4,5,6].includes(slot) || !/^\d{4}-\d{2}-\d{2}$/.test(env.RUN_DATE || '') ||
      !env.RUNNER_TEMP || !env.REPORT_PATH) throw new Error('Invalid SSH failure context');
  const raw = fs.readFileSync(file, 'utf8').slice(-65536);
  const folder = path.join(env.RUNNER_TEMP, 'rewards-private');
  fs.mkdirSync(folder, {recursive:true, mode:0o700});
  let safe = require('./rewards-runner.cjs').redactLog(raw, env);
  for (const name of ['AZDIGI_SSH_HOST','AZDIGI_SSH_USER','AZDIGI_SSH_PORT'])
    if (env[name]) safe = safe.split(env[name]).join('[REDACTED SSH]');
  fs.appendFileSync(path.join(folder, `setup-account-${slot}.log`), '\n[SSH] ' + safe + '\n', {mode:0o600});
  const timeout = sshTimeout(raw);
  // Never overwrite a result from an already-started bot or a different failure stage.
  fs.writeFileSync(env.REPORT_PATH, JSON.stringify({accountId:slot, date:env.RUN_DATE, status:'failed',
    errorCode:timeout ? 'NETWORK_TIMEOUT' : 'SETUP_FAILED', initialBalance:null, finalBalance:null,
    pointsEarned:null, readingPoints:0, searchQuota:'unknown',
    diagnostic:{stage:'STARTING', errors:timeout ? ['TIMEOUT'] : []}}), {flag:'wx', mode:0o600});
  console.error(timeout ? 'SSH connection timed out; eligible for one daily recovery attempt.' :
    'SSH setup failed; detailed log remains private.');
}

function confirmedSshTimeout(entry, job, text, ctx, mode) {
  if (entry?.status !== 'failed' || entry.errorCode !== 'SETUP_FAILED' || entry.logPath ||
      !/^\d+$/.test(entry.runId || '') || !/^\d+$/.test(entry.runAttempt || '') ||
      job?.conclusion !== 'failure' || String(job.run_id) !== entry.runId ||
      !Number.isSafeInteger(job.id) || job.id < 1) return false;
  const start = Date.parse(entry.startedAt), end = Date.parse(entry.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start ||
      vnDate(start) !== ctx.date || vnDate(end) !== ctx.date) return false;
  const failed = job.steps?.filter(step => step.conclusion === 'failure') || [];
  if (failed.length !== 1 || failed[0].name !== SSH_STEP ||
      job.steps?.find(step => step.name === BOT_STEP)?.conclusion !== 'skipped') return false;
  const lines = String(text).split(/\r?\n/).flatMap(line => {
    const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/.exec(line);
    return match ? [{time:Date.parse(match[1]), value:match[2]}] : [];
  });
  // Read only actual Inputs and stderr lines; echoed shell code is not evidence.
  const begin = lines.findIndex(line => line.value === '##[group] Inputs');
  const stop = lines.findIndex((line, index) => index > begin && line.value === '##[endgroup]');
  if (begin < 0 || stop < 0) return false;
  const inputs = lines.slice(begin + 1, stop).map(line => line.value.trim());
  if (!inputs.includes(`account: ${ctx.slot}`) || !inputs.includes(`run_mode: ${mode}`) ||
      !inputs.includes(`run_date: ${ctx.date}`)) return false;
  const errors = lines.filter(line => line.time >= start && line.time <= end).map(line => line.value);
  return sshTimeout(errors.join('\n'));
}

async function selectionView(state, ctx, fetchFn = fetch, env = process.env) {
  if (!['retry','reconcile'].includes(ctx.mode) || state?.date !== ctx.date || state.accountId !== ctx.slot ||
      !env.GITHUB_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '')) return state;
  // Only the old morning classification needs repair; daily retry/reconcile claims stay consumed.
  const entry = state.morning;
  if (state.retry || entry?.status !== 'failed' || entry.errorCode !== 'SETUP_FAILED' || entry.logPath ||
      !/^\d+$/.test(entry.runId || '') || !/^\d+$/.test(entry.runAttempt || '')) return state;
  const api = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
  const options = () => ({headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`, Accept:'application/vnd.github+json'},
    signal:AbortSignal.timeout(20000)});
  try {
    const response = await fetchFn(`${api}/actions/runs/${entry.runId}/attempts/${entry.runAttempt}/jobs?per_page=100`, options());
    if (!response.ok) throw new Error('Jobs unavailable');
    const data = await response.json();
    if (!Array.isArray(data.jobs) || !Number.isSafeInteger(data.total_count) ||
        data.total_count > 100 || data.total_count !== data.jobs.length) throw new Error('Incomplete job evidence');
    const candidates = data.jobs.filter(job => job.conclusion === 'failure' &&
      String(job.run_id) === entry.runId && job.steps?.some(step => step.name === SSH_STEP && step.conclusion === 'failure'));
    if (candidates.length > 6) throw new Error('Unexpected job evidence');
    for (const job of candidates) {
      if (!Number.isSafeInteger(job.id) || job.id < 1) continue;
      const logs = await fetchFn(`${api}/actions/jobs/${job.id}/logs`, options());
      if (!logs.ok) throw new Error('SSH evidence unavailable');
      const text = await logs.text();
      if (text.length > 2 * 1024 * 1024) throw new Error('Oversized SSH evidence');
      if (confirmedSshTimeout(entry, job, text, ctx, 'morning')) {
        console.log('Confirmed earlier SSH timeout before bot startup; one daily recovery is eligible.');
        return {...state, morning:{...entry, errorCode:'NETWORK_TIMEOUT', retryable:true, setupNotStarted:true}};
      }
    }
  } catch {
    console.warn('Earlier setup failure could not be verified; recovery eligibility unchanged.');
  }
  return state;
}
module.exports = {sshTimeout, recordSshFailure, confirmedSshTimeout, selectionView};
if (require.main === module) {
  if (process.argv[2] !== 'record-ssh') process.exitCode = 1;
  else try { recordSshFailure(process.argv[3]); }
  catch { console.error('SSH failure receipt could not be recorded; no recovery was authorized.'); process.exitCode = 1; }
}

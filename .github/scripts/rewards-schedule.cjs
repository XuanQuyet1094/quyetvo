'use strict';
const fs = require('node:fs');
const MORNING = '17 19 * * *'; // 02:17 Vietnam
const RETRY = '37 5 * * *'; // 12:37 Vietnam
const dateVN = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
function deadline(date, mode) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Invalid run date');
  return Date.parse(date + (mode === 'app-read-test' ? 'T23:59:30+07:00' : 'T22:30:00+07:00'));
}
function canStart(date, now = Date.now(), mode) {
  return date === dateVN(now) && deadline(date, mode) - now >= (mode === 'app-read-test' ? 5 : 90) * 60000;
}
function planRun(env, createdAt, now = Date.now()) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) throw new Error('Invalid run creation time');
  const date = dateVN(created);
  const scheduled = env.GITHUB_EVENT_NAME === 'schedule';
  if (scheduled && ![MORNING, RETRY].includes(env.EVENT_SCHEDULE)) throw new Error('Unknown schedule');
  const mode = scheduled ? (env.EVENT_SCHEDULE === RETRY ? 'retry' : 'morning') : (env.INPUT_MODE || 'morning');
  if (!['morning', 'retry'].includes(mode)) throw new Error('Invalid mode');
  const local = new Date(now + 7 * 3600000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const inWindow = !scheduled || (mode === 'morning' ? minutes >= 137 && minutes < 600 : minutes >= 757 && minutes < 960);
  return {date, mode, run: canStart(date, now) && inWindow};
}
async function plan(env = process.env, fetchFn = fetch, now = Date.now()) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ID || '')) throw new Error('Invalid run reference');
  const response = await fetchFn('https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/actions/runs/' + env.GITHUB_RUN_ID, {
    headers: {Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json'},
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Cannot read original run date');
  const run = await response.json();
  const result = planRun(env, run.created_at, now);
  fs.appendFileSync(env.GITHUB_OUTPUT, 'date=' + result.date + '\nmode=' + result.mode + '\nrun=' + result.run + '\n');
  console.log(result.run ? 'Run is within the Vietnam execution window.' : 'Skipped: original run date or execution window has expired.');
}
module.exports = {MORNING, RETRY, dateVN, deadline, canStart, planRun, plan};
if (require.main === module) {
  if (process.argv[2] === 'plan') plan().catch(() => {console.error('Schedule validation failed.'); process.exitCode = 1;});
  else if (process.argv[2] === 'window') {
    const run = canStart(process.env.RUN_DATE, Date.now(), process.env.RUN_MODE);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'run=' + run + '\n');
    console.log(run ? 'Account can start within the daily budget.' : 'Skipped: insufficient time remains for this account.');
  } else process.exitCode = 1;
}

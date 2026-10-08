'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {MORNING, RETRY, planRun, canStart, deadline} = require('./rewards-schedule.cjs');
const at = time => Date.parse('2026-10-06T' + time + '+07:00');
const env = cron => ({GITHUB_EVENT_NAME: 'schedule', EVENT_SCHEDULE: cron});
test('UTC cron maps to correct Vietnam date and mode', () => {
  assert.deepEqual(planRun(env(MORNING), '2026-10-05T19:17:00Z', at('02:20:00')),
    {date: '2026-10-06', mode: 'morning', run: true});
  assert.equal(planRun(env(RETRY), '2026-10-06T05:37:00Z', at('12:40:00')).mode, 'retry');
});
test('late scheduled starts are skipped even on the same date', () => {
  assert.equal(planRun(env(MORNING), '2026-10-05T19:17:00Z', at('10:00:00')).run, false);
  assert.equal(planRun(env(RETRY), '2026-10-06T05:37:00Z', at('21:01:00')).run, false);
  assert.equal(planRun(env(MORNING), '2026-10-06T16:42:00Z', at('23:42:00')).run, false);
});
test('queued run across midnight retains original date and is not started', () => {
  const result = planRun(env(RETRY), '2026-10-05T05:37:00Z', at('12:40:00'));
  assert.equal(result.date, '2026-10-05');
  assert.equal(result.run, false);
});
test('remaining daily budget refuses late accounts without reducing a full morning run', () => {
  assert.equal(canStart('2026-10-06', at('02:17:00')), true);
  assert.equal(canStart('2026-10-06', at('21:00:00')), true);
  assert.equal(canStart('2026-10-06', at('21:00:01')), false);
  assert.equal(canStart('2026-10-05', at('02:17:00')), false);
  assert.equal(deadline('2026-10-06'), at('22:30:00'));
});
test('manual runs preserve selected mode but cannot bypass date or daily deadline', () => {
  const manual = {GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_MODE: 'retry'};
  assert.equal(planRun(manual, '2026-10-06T04:00:00Z', at('11:00:00')).run, true);
  assert.equal(planRun(manual, '2026-10-06T04:00:00Z', at('21:01:00')).run, false);
  assert.throws(() => planRun(env('0 8 * * *'), '2026-10-06T08:00:00Z', at('15:00:00')));
});
test('daily-window expiry cannot qualify for another earning attempt', () => {
  assert.equal(require('./rewards-state.cjs').retryable({status: 'failed', errorCode: 'DAILY_WINDOW_EXPIRED'}), false);
  assert.equal(require('./rewards-state.cjs').retryable({status: 'failed', errorCode: 'DAILY_WINDOW_EXPIRED',
    diagnostic: {errors: ['ERR_PROXY_CONNECTION_FAILED']}}), false);
});
test('expired account is refused before spawning a process and keeps original report date', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-expired-'));
  try {
    const report = path.join(dir, 'result.json');
    const code = await require('./rewards-runner.cjs').runAccount({
      command: '/nonexistent-must-never-spawn',
      env: {ACCOUNT_SLOT: '1', ACCOUNT_EMAIL: 'fixture@example.invalid', RUN_DATE: '2020-01-01',
        RUNNER_TEMP: dir, BOT_DIR: dir, REPORT_PATH: report}
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(fs.readFileSync(report)).errorCode, 'DAILY_WINDOW_EXPIRED');
    assert.equal(JSON.parse(fs.readFileSync(report)).date, '2020-01-01');
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});
test('late claim performs no private API request and consumes no attempt', async (t) => {
  t.mock.method(Date, 'now', () => at('21:00:01'));
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-claim-')), prev = {...process.env};
  try {
    Object.assign(process.env, {RUN_DATE: '2026-10-06', RUN_MODE: 'morning', ACCOUNT_SLOT: '1',
      GITHUB_OUTPUT: path.join(dir, 'output'), REWARDS_STATE_TOKEN: 'synthetic'});
    t.mock.method(global, 'fetch', () => {throw new Error('No API request expected');});
    await require('./rewards-state.cjs').claim();
    assert.equal(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), 'run=false\n');
  } finally {
    for(const key of Object.keys(process.env)) if(!(key in prev)) delete process.env[key];
    Object.assign(process.env, prev);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});


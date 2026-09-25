'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('./rewards-runner.cjs');
const fixture = {schema: 1, accountId: '2', date: '2026-09-25', status: 'completed',
  startedAt: '2026-09-25T00:00:00Z', finishedAt: '2026-09-25T00:30:00Z',
  initialBalance: 1000, finalBalance: 1159, pointsEarned: 159, searchQuota: 'unknown', errorCode: null};

test('unknown points stay unknown and another account cannot overwrite the result', () => {
  assert.equal(api.number(null), null);
  assert.equal(api.number(''), null);
  assert.equal(api.cleanResult(fixture, 1), null);
  assert.equal(api.cleanResult({...fixture, pointsEarned: null}, 2).pointsEarned, null);
});

test('only selected credentials enter the bot; browser and HTTP use SOCKS5', () => {
  const env = api.childEnvironment({ACCOUNT_EMAIL: 'test@example.invalid', ACCOUNT_PASSWORD: 'synthetic',
    ACCOUNT_1_EMAIL: 'other@example.invalid', TELEGRAM_BOT_TOKEN: 'synthetic',
    PRIVATE_REPO_TOKEN: 'synthetic', AZDIGI_SSH_KEY: 'synthetic', RUNNER_TEMP: '/tmp'}, 2);
  assert.equal(env.ACCOUNT_1_EMAIL, undefined);
  assert.equal(env.ACCOUNT_2_EMAIL, 'test@example.invalid');
  assert.equal(env.REWARDS_ACCOUNT_IDS, '2');
  assert.equal(env.ACCOUNT_2_PROXY_HTTP, 'true');
  assert.equal(env.ACCOUNT_2_PROXY_URL, 'socks5://127.0.0.1');
  for (const key of ['ACCOUNT_EMAIL', 'ACCOUNT_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'PRIVATE_REPO_TOKEN', 'AZDIGI_SSH_KEY']) assert.equal(env[key], undefined);
});

async function fakeBot(source, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-test-'));
  try {
    const code = await api.runAccount({command: process.execPath, args: ['-e', source], timeoutMs: 3000,
      killGraceMs: 20, ...options, env: {ACCOUNT_SLOT: '2', ACCOUNT_EMAIL: 'test@example.invalid',
        RUNNER_TEMP: dir, BOT_DIR: dir, REPORT_PATH: path.join(dir, 'result.json')}});
    return {code, result: JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'))};
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
test('successful child yields verified balance and Daily Set completion', async () => {
  const result = await fakeBot(`console.log('private: synthetic-password');
    console.log('DAILY_SET_VERIFICATION ' + JSON.stringify({state:'complete',total:3,completed:3,remaining:0}));
    console.log('RECOVERY_ACCOUNT_RESULT ' + JSON.stringify(${JSON.stringify(fixture)}));`);
  assert.equal(result.code, 0);
  assert.equal(result.result.pointsEarned, 159);
  assert.equal(result.result.diagnostic.dailySet.completed, 3);
  assert.ok(!JSON.stringify(result).includes('synthetic-password'));
});
test('exit zero with failed recovery result still fails', async () => {
  const result = await fakeBot(`console.log('RECOVERY_ACCOUNT_RESULT ' + JSON.stringify(${JSON.stringify({...fixture, status: 'failed', pointsEarned: null, errorCode: 'FLOW_FAILED'})}));`);
  assert.equal(result.code, 1);
  assert.equal(result.result.errorCode, 'FLOW_FAILED');
  assert.equal(result.result.pointsEarned, null);
});
test('missing final result and timeout are not successful', async () => {
  const empty = await fakeBot('process.exit(0)');
  assert.equal(empty.code, 1);
  assert.equal(empty.result.errorCode, 'NO_FINAL_RESULT');
  const timeout = await fakeBot('setInterval(()=>{},1000)', {timeoutMs: 100});
  assert.equal(timeout.code, 1);
  assert.equal(timeout.result.errorCode, 'ACCOUNT_TIMEOUT');
});
test('Telegram report escapes account identity and does not claim all daily points complete', async () => {
  const text = api.accountMessage({...api.cleanResult(fixture, 2), diagnostic: {dailySet: null, errors: []}}, 'a&b@example.invalid', 'https://github.com/example/repo/actions/runs/1');
  assert.ok(text.includes('a&amp;b@example.invalid'));
  assert.ok(text.includes('<b>Daily Set:</b> Chưa xác minh'));
  assert.ok(text.includes('+159'));
  let calls = 0;
  await api.telegram(text, {TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_CHAT_ID: '1'}, async (_, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).parse_mode, 'HTML');
    return {ok: true, json: async () => ({ok: true})};
  });
  assert.equal(calls, 1);
});
test('summary distinguishes missing balances from zero', () => {
  const jobs = {account_2: {outputs: {result: JSON.stringify(api.cleanResult(fixture, 2))}}};
  const text = api.summaryMessage(jobs, {RUN_URL: 'https://github.com/example/repo/actions/runs/1'});
  assert.ok(text.includes('+159 (1/6'));
  assert.ok(text.includes('Chưa đủ số liệu 6 tài khoản'));
});

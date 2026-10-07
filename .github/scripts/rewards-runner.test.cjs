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
        RUNNER_TEMP: dir, BOT_DIR: dir, ACCOUNT_PASSWORD: 'synthetic-password', ACCOUNT_TOTP_SECRET: 'JBSWY3DPEHPK3PXP', REPORT_PATH: path.join(dir, 'result.json'), ...(options.env || {})}});
    return {code, result: JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')), privateLog: fs.readFileSync(path.join(dir, 'rewards-private', 'account-2.log'), 'utf8')};
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
test('successful child yields verified balance and Daily Set completion', async () => {
  const result = await fakeBot(`console.log('private: synthetic-password');
    console.log('DAILY_SET_VERIFICATION ' + JSON.stringify({state:'complete',total:3,completed:3,remaining:0}));
    console.log('RECOVERY_ACCOUNT_RESULT ' + JSON.stringify(${JSON.stringify(fixture)}));`);
  assert.equal(result.code, 0);
  assert.equal(result.result.pointsEarned, 159);
  assert.equal(result.result.diagnostic.dailySet.completed, 3);
  assert.ok(!JSON.stringify(result.result).includes('synthetic-password'));
  assert.ok(result.privateLog.includes('DAILY_SET_VERIFICATION'));
  assert.ok(result.privateLog.split('\n').length >= 3, 'captured records are newline-separated');
  assert.ok(!result.privateLog.includes('synthetic-password'));
  assert.ok(!result.privateLog.includes('JBSWY3DPEHPK3PXP'));
});
test('exit zero with failed recovery result still fails', async () => {
  const result = await fakeBot(`console.log('RECOVERY_ACCOUNT_RESULT ' + JSON.stringify(${JSON.stringify({...fixture, status: 'failed', pointsEarned: null, errorCode: 'FLOW_FAILED'})}));`);
  assert.equal(result.code, 1);
  assert.equal(result.result.errorCode, 'FLOW_FAILED');
  assert.equal(result.result.pointsEarned, null);
});
test('a completed web flow retains rejected App authentication separately', async () => {
 const result=await fakeBot(`console.log('[ERROR] MOBILE [GET-APP-DASHBOARD-DATA] Error fetching dashboard data: Request failed with status code 401');console.log('RECOVERY_ACCOUNT_RESULT ' + JSON.stringify(${JSON.stringify(fixture)}));`);
 assert.equal(result.code,0);assert.equal(result.result.status,'completed');assert.equal(result.result.appCheckIn,'auth_rejected');
 assert.ok(api.accountMessage(result.result,'fixture@example.invalid','https://example.invalid').includes('Chưa thực hiện · API từ chối 401'));
});
test('a rejected check-in submission is reported as App authentication rejection', async () => {
 const r=await fakeBot(`console.log('[DAILY-CHECK-IN] Starting Daily Check-In');console.log('[ERROR] MOBILE [DAILY-CHECK-IN] Error during Daily Check-In | message=Request failed with status code 401');console.log('RECOVERY_ACCOUNT_RESULT ' + JSON.stringify(${JSON.stringify(fixture)}));`);
 assert.equal(r.result.appCheckIn,'auth_rejected');assert.equal(r.result.appCheckInVerified,undefined);
});
test('the App probe report requires two confirmed reads, not one successful response', async () => {
 const final=`console.log('RECOVERY_ACCOUNT_RESULT ' + JSON.stringify(${JSON.stringify(fixture)}));`;
 const single=await fakeBot(`console.log('[APP-AUTH-PROBE] Result | valid=true');${final}`,{env:{RUN_MODE:'app-auth-probe'}});
 assert.equal(single.code,1);assert.equal(single.result.appAuthVerified,false);assert.equal(single.result.errorCode,'APP_AUTH_PROBE_FAILED');
 const stable=await fakeBot(`console.log('[APP-AUTH-PROBE] Stable read confirmed | variant=fixture | successfulReads=2');${final}`,{env:{RUN_MODE:'app-auth-probe'}});
 assert.equal(stable.code,0);assert.equal(stable.result.appAuthVerified,true);assert.equal(stable.result.appCheckIn,'not_requested');
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
  assert.ok(text.includes('<b>App check-in:</b> Chưa xác minh'));
  const rejected = api.accountMessage({...api.cleanResult(fixture,2),appCheckIn:'auth_rejected'},'fixture@example.invalid','https://example.invalid');
  assert.ok(rejected.includes('Chưa thực hiện · API từ chối 401'));
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

test('private log redactor removes tokens, auth headers, email, codes, and URL parameters while retaining trace', () => {
  const safe = api.redactLog([
    'Microsoft login error: Unknown Error for user@example.com',
    'Authorization: Bearer top-secret-bearer',
    'Set-Cookie: session=session-cookie-secret',
    'OTP 123456',
    'https://example.invalid/callback?code=private-oauth&state=private-state',
    'TOTP secret is malformed'
  ].join('\n'), {ACCOUNT_PASSWORD:'top-secret-bearer', ACCOUNT_TOTP_SECRET:'private-cookie', ACCOUNT_RECOVERY_EMAIL:'session-cookie-secret'});
  for (const secret of ['user@example.com', 'top-secret-bearer', 'private-cookie', 'session-cookie-secret', '123456', 'private-oauth', 'private-state']) assert.ok(!safe.includes(secret));
  assert.ok(safe.includes('Microsoft login error: Unknown Error'));
  assert.ok(safe.includes('TOTP secret is malformed'));
  assert.ok(safe.includes('https://example.invalid/callback?[REDACTED]'));
});

test('per-task evidence is scoped to today and reading credit remains private and separate from total points', async t => {
 t.mock.method(Date,'now',()=>Date.parse('2026-10-07T18:17:00+07:00'));
 const date=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
 const event={date,tasks:{dailySet:'complete',appCheckIn:'missing',readToEarn:'complete',mobileSearch:'unknown',desktopSearch:'missing',token:'secret'}};
 const end={...fixture,date};
 const r=await fakeBot(`console.log('DAILY_TASK_VERIFICATION '+JSON.stringify(${JSON.stringify(event)}));
 console.log('DAILY_TASK_VERIFICATION '+JSON.stringify({date:'2000-01-01',tasks:{dailySet:'missing'}}));
 console.log('DAILY_READING_CREDIT '+JSON.stringify({date:${JSON.stringify(date)},points:30}));
 console.log('RECOVERY_ACCOUNT_RESULT '+JSON.stringify(${JSON.stringify(end)}));`,{env:{RUN_DATE:date}});
 assert.equal(r.result.tasks.dailySet,'complete');assert.equal(r.result.tasks.mobileSearch,'unknown');
 assert.equal(r.result.tasks.token,undefined);assert.equal(r.result.readingPoints,30);
 assert.equal(r.result.pointsEarned,159);
 const text=api.accountMessage(r.result,'fixture@example.invalid','https://example.invalid');
 assert.ok(text.includes('Read to Earn'));assert.ok(text.includes('Còn thiếu'));assert.ok(text.includes('Chưa xác minh'));
});
test('ambiguous reading errors never certify zero credit for a later repeat',async()=>{
 const r=await fakeBot(`console.log('[ERROR] MOBILE [READ-TO-EARN] Error during Read to Earn | message=timeout');
 console.log('RECOVERY_ACCOUNT_RESULT '+JSON.stringify(${JSON.stringify(fixture)}));`);
 assert.equal(r.result.readingPoints,null);
});

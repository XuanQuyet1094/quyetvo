'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {randomInt} = require('node:crypto');
const {setTimeout: wait} = require('node:timers/promises');
const createDiagnostics = require('./rewards-diagnostics.cjs');

const slots = [1, 2, 3, 4, 5, 6];
const number = v => typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
const balance = v => number(v) !== null && v >= 0 ? v : null;
const html = v => String(v).replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
const fmt = v => number(v) === null ? 'Chưa xác minh' : v.toLocaleString('vi-VN');
const gain = v => number(v) === null ? 'Chưa xác minh' : (v >= 0 ? '+' : '') + fmt(v);
const dateVN = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Ho_Chi_Minh'}).format(new Date());
const errors = new Set(['ACCOUNT_LOCKED', 'BOT_WARNING', 'AUTH_REQUIRED', 'NETWORK_TIMEOUT',
  'DASHBOARD_UNAVAILABLE', 'FLOW_FAILED', 'BALANCE_UNVERIFIED', 'STALE_RUN_DATE',
  'INVALID_ACCOUNT_SELECTION', 'MISSING_ACCOUNT_EMAIL', 'PROCESS_FAILED', 'NO_FINAL_RESULT',
  'ACCOUNT_TIMEOUT', 'CANCELLED', 'SETUP_FAILED']);
function errorLabel(value) {
  return errors.has(value) || /^HTTP_[45]\d\d$/.test(String(value)) ? value : value ? 'FLOW_FAILED' : null;
}
function accountSlot(value = process.env.ACCOUNT_SLOT) {
  const id = Number(value);
  if (!slots.includes(id)) throw new Error('Invalid account slot');
  return id;
}
function read(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function save(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), {mode: 0o600});
}
function cleanResult(r, id) {
  if (!r || r.schema !== 1 || String(r.accountId) !== String(id)) return null;
  const start = Date.parse(r.startedAt), end = Date.parse(r.finishedAt);
  return {
    accountId: id,
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : dateVN(),
    status: ['running', 'completed', 'failed', 'needs_action'].includes(r.status) ? r.status : 'failed',
    finished: Number.isFinite(end),
    initialBalance: balance(r.initialBalance), finalBalance: balance(r.finalBalance),
    pointsEarned: number(r.pointsEarned),
    searchQuota: ['complete', 'remaining', 'unknown', 'not_requested'].includes(r.searchQuota) ? r.searchQuota : 'unknown',
    errorCode: errorLabel(r.errorCode),
    durationSeconds: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : null
  };
}
function childEnvironment(source, id) {
  const env = {...source};
  for (const key of Object.keys(env)) {
    if (/^ACCOUNT_/.test(key) || /TOKEN|SECRET|PASSWORD|SSH_KEY|KNOWN_HOSTS/.test(key)) delete env[key];
  }
  Object.assign(env, {
    [`ACCOUNT_${id}_EMAIL`]: String(source.ACCOUNT_EMAIL || '').trim(),
    [`ACCOUNT_${id}_PASSWORD`]: source.ACCOUNT_PASSWORD || '',
    [`ACCOUNT_${id}_TOTP_SECRET`]: source.ACCOUNT_TOTP_SECRET || '',
    [`ACCOUNT_${id}_RECOVERY_EMAIL`]: source.ACCOUNT_RECOVERY_EMAIL || '',
    [`ACCOUNT_${id}_GEO_LOCALE`]: 'VN', [`ACCOUNT_${id}_LANG_CODE`]: 'vi',
    [`ACCOUNT_${id}_PROXY_HTTP`]: 'true',
    [`ACCOUNT_${id}_PROXY_URL`]: 'socks5://127.0.0.1', [`ACCOUNT_${id}_PROXY_PORT`]: '1080',
    REWARDS_ACCOUNT_IDS: String(id),
    REWARDS_REPORT_DIR: path.join(source.RUNNER_TEMP, 'rewards-private')
  });
  return env;
}
function configure() {
  accountSlot();
  const dir = process.env.BOT_DIR;
  const cfg = read(path.join(dir, 'config.example.json'));
  if (!cfg) throw new Error('Missing config template');
  cfg.headless = true;
  cfg.clusters = 1;
  cfg.accountDelay = {min: '100sec', max: '180sec'};
  cfg.errorDiagnostics = false;
  cfg.debugLogs = false;
  cfg.sessionPath = path.join(process.env.RUNNER_TEMP, 'rewards-private', 'sessions');
  if (cfg.consoleLogFilter) cfg.consoleLogFilter.enabled = false;
  for (const channel of Object.values(cfg.webhook || {})) {
    if (channel && typeof channel === 'object' && 'enabled' in channel) channel.enabled = false;
  }
  save(path.join(dir, 'config.json'), cfg);
  fs.writeFileSync(path.join(dir, '.env'), '', {mode: 0o600});
}

async function runAccount(options = {}) {
  const source = options.env || process.env;
  const id = accountSlot(source.ACCOUNT_SLOT);
  const diagnostic = {stage: 'STARTING', loginState: null, errors: [], dailySet: null};
  const diagnose = createDiagnostics(diagnostic);
  const started = Date.now();
  let last = null, stopped = null;
  function persist(code, signal) {
    const result = last || {accountId: id, date: dateVN(), status: 'failed', initialBalance: null,
      finalBalance: null, pointsEarned: null, searchQuota: 'unknown', errorCode: 'NO_FINAL_RESULT'};
    if (stopped || code !== 0 || signal || !result.finished) {
      result.status = 'failed';
      result.errorCode = stopped || result.errorCode || (code !== 0 || signal ? 'PROCESS_FAILED' : 'NO_FINAL_RESULT');
    }
    result.durationSeconds = Math.round((Date.now() - started) / 1000);
    result.diagnostic = diagnostic;
    result.exitCode = number(code);
    result.signal = ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal) ? signal : null;
    save(source.REPORT_PATH, result);
    return result;
  }
  if (!String(source.ACCOUNT_EMAIL || '').trim()) {
    stopped = 'MISSING_ACCOUNT_EMAIL';
    persist(1, null);
    return 1;
  }
  const child = spawn(options.command || process.execPath, options.args || ['dist/index.js'], {
    cwd: source.BOT_DIR, env: childEnvironment(source, id), detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const killGroup = signal => {
    if (child.pid) { try { process.kill(-child.pid, signal); } catch {} }
  };
  let killTimer;
  function stop(reason) {
    if (stopped) return;
    stopped = reason;
    killGroup('SIGTERM');
    killTimer = setTimeout(() => killGroup('SIGKILL'), options.killGraceMs ?? 10000);
  }
  const onSignal = () => stop('CANCELLED');
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const timeout = setTimeout(() => stop('ACCOUNT_TIMEOUT'), options.timeoutMs ?? 75 * 60000);
  const heartbeat = setInterval(() => console.log(`Account ${id}/6: running; raw logs remain private.`), 60000);
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({input: stream}).on('line', line => {
      // Never echo raw lines: they may contain account details or browser cookies.
      diagnose(line);
      const marker = 'RECOVERY_ACCOUNT_RESULT ';
      const at = line.indexOf(marker);
      if (at < 0) return;
      try {
        const r = cleanResult(JSON.parse(line.slice(at + marker.length)), id);
        if (r) last = r;
      } catch {}
    });
  }
  const {code, signal} = await new Promise(resolve => {
    child.on('error', () => { stopped = 'PROCESS_FAILED'; });
    child.on('close', (code, signal) => resolve({code, signal}));
  });
  clearTimeout(timeout);
  clearTimeout(killTimer);
  clearInterval(heartbeat);
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  killGroup('SIGKILL');
  const result = persist(code, signal);
  console.log(`Account ${id}/6: ${result.status}; report prepared.`);
  return result.status === 'completed' && code === 0 && !signal ? 0 : 1;
}

const statusText = {completed: 'Đã kết thúc lượt chạy', failed: 'Lượt chạy gặp lỗi', needs_action: 'Cần kiểm tra', running: 'Chưa kết thúc'};
const quotaText = {complete: 'Đã hết hạn mức', remaining: 'Còn hạn mức', unknown: 'Chưa xác minh', not_requested: 'Không được yêu cầu'};
function accountMessage(r, email, url) {
  const daily = r.diagnostic?.dailySet;
  const dailyText = daily && daily.state !== 'unverified'
    ? `${daily.completed}/${daily.total} · ${daily.state === 'complete' ? 'Hoàn tất' : 'Chưa hoàn tất'}` : 'Chưa xác minh';
  const lines = [
    '<b>MICROSOFT REWARDS</b>',
    `<b>${process.env.RUN_MODE === 'retry' ? 'Chạy dự phòng · ' : ''}Báo cáo tài khoản ${r.accountId}/6</b>`,
    `<code>${html(email || `Tài khoản ${r.accountId}`)}</code>`,
    `${html(r.date)} · Giờ Việt Nam`, '',
    `<b>Trạng thái:</b> ${statusText[r.status] || 'Chưa có kết quả'}`,
    `<b>Điểm trong lượt:</b> ${gain(r.pointsEarned)}`,
    `<b>Số dư:</b> ${fmt(r.initialBalance)} → ${fmt(r.finalBalance)}`,
    `<b>Daily Set:</b> ${dailyText}`,
    `<b>Tìm kiếm:</b> ${quotaText[r.searchQuota] || 'Chưa xác minh'}`,
    `<b>Thời gian:</b> ${number(r.durationSeconds) === null ? 'Chưa xác minh' : (r.durationSeconds / 60).toFixed(1) + ' phút'}`
  ];
  if (r.errorCode) lines.push(`<b>Mã lỗi:</b> <code>${html(errorLabel(r.errorCode))}</code>`);
  if (r.status !== 'completed' && r.diagnostic) {
    lines.push(`<b>Bước cuối:</b> ${html(r.diagnostic.stage)}`);
    if (r.diagnostic.errors.length) lines.push(`<b>Chẩn đoán:</b> ${html(r.diagnostic.errors.slice(-3).join(', '))}`);
  }
  lines.push('', r.accountId < 6 ? 'Nghỉ ngẫu nhiên 100–180 giây rồi chuyển tài khoản tiếp theo.' : 'Đã đến tài khoản cuối cùng trong danh sách.');
  lines.push(`<a href="${html(url)}">Xem lượt chạy GitHub</a>`);
  return lines.join('\n');
}
async function telegram(text, env = process.env, fetchFn = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error('Telegram secrets missing');
  // Do not retry ambiguous network failures: that can send duplicate notifications.
  const response = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}}),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true) throw new Error('Telegram rejected notification');
  console.log('Telegram report delivered.');
}
async function report() {
  const id = accountSlot();
  const r = read(process.env.REPORT_PATH) || {accountId: id, date: dateVN(), status: 'failed',
    initialBalance: null, finalBalance: null, pointsEarned: null, durationSeconds: null,
    searchQuota: 'unknown', errorCode: process.env.JOB_STATUS === 'cancelled' ? 'CANCELLED' : 'SETUP_FAILED'};
  // Only numeric balances and fixed labels cross job boundaries; never email or logs.
  const output = {accountId: id, date: r.date, status: r.status, pointsEarned: r.pointsEarned,
    initialBalance: r.initialBalance, finalBalance: r.finalBalance, errorCode: r.errorCode};
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'result=' + JSON.stringify(output) + '\n');
  await telegram(accountMessage(r, process.env.ACCOUNT_EMAIL, process.env.RUN_URL));
}
function summaryMessage(jobs, env = process.env) {
  const rows = slots.map(id => {
    let r;
    try { r = JSON.parse(jobs[`account_${id}`]?.outputs?.result || 'null'); } catch {}
    return {id, r};
  });
  const sum = field => {
    const known = rows.map(({r}) => r?.[field]).filter(v => number(v) !== null);
    return {n: known.length, total: known.reduce((a, b) => a + b, 0)};
  };
  const points = sum('pointsEarned'), initial = sum('initialBalance'), final = sum('finalBalance');
  const completed = rows.filter(({r}) => r?.status === 'completed').length;
  const lines = ['<b>MICROSOFT REWARDS</b>', env.RUN_MODE === 'retry' ? '<b>Tổng kết lượt dự phòng</b>' : '<b>Tổng kết 6 tài khoản</b>', `${env.RUN_DATE || dateVN()} · Giờ Việt Nam`, '',
    `<b>Điểm ghi nhận:</b> ${points.n ? gain(points.total) : 'Chưa xác minh'} (${points.n}/6 tài khoản có số liệu)`,
    `<b>Kết thúc thành công:</b> ${completed}/6`,
    `<b>Tổng số dư:</b> ${initial.n === 6 && final.n === 6 ? fmt(initial.total) + ' → ' + fmt(final.total) : 'Chưa đủ số liệu 6 tài khoản'}`, ''];
  for (const {id, r} of rows) {
    lines.push(`<b>${id}. ${html(env[`ACCOUNT_${id}_EMAIL`] || `Tài khoản ${id}`)}</b>`);
    lines.push(r ? `${gain(r.pointsEarned)} điểm · ${r.status === 'completed' ? 'Đã chạy xong' : 'Cần kiểm tra'}` : env.RUN_MODE === 'retry' && jobs[`account_${id}`]?.result === 'success' ? 'Không thuộc diện chạy lại / đã dùng lượt dự phòng' : 'Không chạy hoặc chưa có kết quả');
  }
  if (env.STATE_ENABLED === 'false') lines.push('', 'Chưa có REWARDS_STATE_TOKEN: chưa bật lưu trạng thái và chạy dự phòng.');
  lines.push('', 'Điểm tính theo chênh lệch số dư của lượt chạy; không đồng nghĩa đã hoàn thành mọi nhiệm vụ.',
    `<a href="${html(env.RUN_URL)}">Xem lượt chạy GitHub</a>`);
  return lines.join('\n');
}
async function main() {
  switch (process.argv[2]) {
    case 'configure': configure(); break;
    case 'run': process.exitCode = await runAccount(); break;
    case 'report': await report(); break;
    case 'summary': await telegram(summaryMessage(JSON.parse(process.env.JOB_RESULTS))); break;
    case 'rest': {
      const seconds = randomInt(100, 181);
      console.log(`Resting ${seconds} seconds before the next account.`);
      await wait(seconds * 1000);
      break;
    }
    default: throw new Error('Invalid operation');
  }
}
module.exports = {number, cleanResult, childEnvironment, runAccount, accountMessage, summaryMessage, telegram};
if (require.main === module) main().catch(() => {
  console.error('Automation step failed. Check setup or Telegram delivery; sensitive details were suppressed.');
  process.exitCode = 1;
});

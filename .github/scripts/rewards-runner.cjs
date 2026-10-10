'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {randomInt} = require('node:crypto');
const {setTimeout: wait} = require('node:timers/promises');
const createDiagnostics = require('./rewards-diagnostics.cjs');
const schedule = require('./rewards-schedule.cjs');
const taskStatus = require('./rewards-tasks.cjs');
const searchLedger = require('./rewards-search-ledger.cjs');
const searchEvidence = require('./rewards-search-evidence.cjs');
const performance = require('./rewards-performance.cjs');

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
  'ACCOUNT_TIMEOUT', 'CANCELLED', 'SETUP_FAILED', 'DAILY_WINDOW_EXPIRED', 'APP_CHECKIN_UNVERIFIED', 'APP_AUTH_PROBE_FAILED']);
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
function redactLog(text, env = {}) {
  let output = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // Remove complete private-key blocks before applying individual environment values.
  output = output.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  const sensitive = Object.entries(env)
    .filter(([key, value]) => /PASSWORD|TOTP|RECOVERY_EMAIL|TOKEN|SECRET|SSH_KEY|COOKIE|AUTHORIZATION/i.test(key) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const secret of sensitive) {
    const variants = new Set([secret, secret.replace(/\r?\n/g, '\n'), secret.replace(/\r?\n/g, '')]);
    for (const variant of variants) if (variant) output = output.split(variant).join('[REDACTED]');
  }
  return output
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+/ig, '$1[REDACTED]')
    .replace(/((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/ig, '$1[REDACTED]')
    .replace(/(["']?(?:authorization|cookie|set-cookie|password|passwd|totp(?:_secret)?|access_token|refresh_token|client_secret|api_key)["']?\s*:\s*)("[^"]*"|'[^']*'|[^,\s}]+)/ig, '$1"[REDACTED]"')
    .replace(/((?:password|passwd|totp(?:_secret)?|access_token|refresh_token|client_secret|api_key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^&\s,}]+)/ig, '$1[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED TOKEN]')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g, '[REDACTED TOKEN]')
    .replace(/(https?:\/\/)\S+:[^/@\s]+@/ig, '$1[REDACTED]@')
    .replace(/\b\d{6}\b/g, '[REDACTED CODE]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[REDACTED EMAIL]')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/ig, '$1?[REDACTED]');
}
function captureLogPath(env, id) {
  const root = env.RUNNER_TEMP;
  if (!root) throw new Error('RUNNER_TEMP is required for private log capture');
  const dir = path.join(root, 'rewards-private');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  return path.join(dir, `account-${id}.log`);
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
  if (['morning','retry','reconcile'].includes(source.RUN_MODE)) {
    const budget=read(path.join(source.RUNNER_TEMP,'rewards-private','search-budget.json'));
    if (!budget || budget.schema!==1 || budget.date!==source.RUN_DATE || budget.accountId!==id)
      throw new Error('Missing or invalid daily search budget');
    env.REWARDS_SEARCH_LEDGER=JSON.stringify(budget);
  } else delete env.REWARDS_SEARCH_LEDGER;
  if (['morning', 'retry', 'reconcile', 'app-read-test'].includes(source.RUN_MODE)) {
    const budget = read(path.join(source.RUNNER_TEMP, 'rewards-private', 'reading-budget.json'));
    if (!budget && source.RUN_MODE === 'app-read-test') throw new Error('Missing private reading budget');
    if (budget) {
      if (budget.date !== source.RUN_DATE || budget.accountId !== id || !Number.isSafeInteger(budget.points) || budget.points < 0 || budget.points > 30)
        throw new Error('Invalid private reading budget');
      env.REWARDS_READING_POINTS_BUDGET = String(budget.points);
      env.REWARDS_READING_RECEIPTS_VERIFIED = budget.verified === false ? 'false' : 'true';
    }
  }
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
    REWARDS_APP_AUTH_PROBE: source.RUN_MODE === 'app-auth-probe' ? 'true' : 'false',
    REWARDS_READING_CREDITED_THIS_RUN: '0',
    REWARDS_ACCOUNT_IDS: String(id),
    REWARDS_REPORT_DIR: path.join(source.RUNNER_TEMP, 'rewards-private')
  });
  return env;
}
function configure(diagnosticOnly = false) {
  diagnosticOnly = diagnosticOnly || process.env.RUN_MODE === 'app-auth-probe';
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
  if (['morning','retry','reconcile'].includes(process.env.RUN_MODE)) {
    cfg.searchSettings ||= {};
    cfg.searchSettings.parallelSearching=false;
    cfg.searchSettings.runOnZeroPoints=false;
    if (cfg.experimental) {
      cfg.experimental.apiSearch=false;
      cfg.experimental.apiSearchOnBing=false;
      cfg.experimental.edgeBrowsing=false;
    }
    // Keep configured search workers available until the bot reads Microsoft quota.
    // Observed balance receipts alone cannot disable a platform at a fixed goal.
  }
  if (diagnosticOnly) {
    cfg.ensureStreakProtection = false;
    cfg.autoClaimPunchcardRewards = false;
    if (cfg.workers && typeof cfg.workers === 'object') {
      for (const key of Object.keys(cfg.workers)) cfg.workers[key] = false;
    }
    if (cfg.activities && typeof cfg.activities === 'object') {
      for (const key of Object.keys(cfg.activities)) cfg.activities[key] = false;
    }
  }
  else if (['test', 'app-test', 'app-read-test'].includes(process.env.RUN_MODE)) {
    cfg.ensureStreakProtection = false;
    cfg.autoClaimPunchcardRewards = false;
    if (cfg.workers && typeof cfg.workers === 'object') {
      for (const key of Object.keys(cfg.workers)) cfg.workers[key] = false;
      cfg.workers.doDailySet = process.env.RUN_MODE === 'test';
      cfg.workers.doDailyCheckIn = process.env.RUN_MODE === 'app-test';
      cfg.workers.doReadToEarn = process.env.RUN_MODE === 'app-read-test';
    }
    if (cfg.activities && typeof cfg.activities === 'object') {
      for (const key of Object.keys(cfg.activities)) cfg.activities[key] = false;
      cfg.activities.urlReward = process.env.RUN_MODE === 'test';
    }
  }
  if (process.env.RUN_MODE === 'reconcile') {
    cfg.ensureStreakProtection = false;
    cfg.autoClaimPunchcardRewards = false;
    for (const key of Object.keys(cfg.workers || {})) cfg.workers[key] = false;
    // Fresh quota selects missing searches; unverified repair quota cannot authorize queries.
    cfg.workers.doDailySet = true;
    cfg.workers.doDailyCheckIn = true;
    cfg.workers.doReadToEarn = true;
    cfg.workers.doMobileSearch = true;
    cfg.workers.doDesktopSearch = true;
    for (const key of Object.keys(cfg.activities || {})) cfg.activities[key] = false;
    cfg.activities.urlReward = true;
    cfg.activities.searchOnBing = true;
    cfg.searchSettings.parallelSearching = false;
    cfg.searchSettings.runOnZeroPoints = false;
    if (cfg.experimental) {
      cfg.experimental.apiSearch = false;
      cfg.experimental.apiSearchOnBing = false;
    }
  }
  if (['test', 'reconcile', 'app-test', 'app-auth-probe', 'app-read-test'].includes(process.env.RUN_MODE) && cfg.experimental) cfg.experimental.edgeBrowsing = false;
  const readingBudget = read(path.join(process.env.RUNNER_TEMP, 'rewards-private', 'reading-budget.json'));
  if (readingBudget?.date === process.env.RUN_DATE && readingBudget?.accountId === Number(process.env.ACCOUNT_SLOT) && readingBudget?.points === 0 && cfg.workers)
    cfg.workers.doReadToEarn = false;
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
  let last = null, stopped = null, appCheckInVerified = false, appAuthVerified = false;
  let appAuthRejected = false, appCheckInAttempted = false;
  let verifiedTasks = taskStatus.tasks(), readingPoints = 0, readingUncertain = false;
  const searchBudget=read(path.join(source.RUNNER_TEMP,'rewards-private','search-budget.json'));
  const hasSearchBudget=searchBudget?.schema===1 && searchBudget.date===source.RUN_DATE && searchBudget.accountId===id;
  const searchPoints={mobile:0,desktop:0};
  let observedSearch = searchEvidence.normalize(null), claimReceived = 0, hasClaim = false, pendingBefore = null;
  const stages=performance.collector();
  const requested=taskStatus.required(source.RUN_MODE,read(path.join(source.BOT_DIR,'config.example.json')));
  const quotaDiagnostics=[];
  function persist(code, signal) {
    const result = last || {accountId: id, date: source.RUN_DATE || dateVN(), status: 'failed', initialBalance: null,
      finalBalance: null, pointsEarned: null, searchQuota: 'unknown', errorCode: 'NO_FINAL_RESULT'};
    if (source.RUN_MODE === 'app-auth-probe' && !appAuthVerified && !stopped) stopped = 'APP_AUTH_PROBE_FAILED';
    if (source.RUN_MODE === 'app-test' && !appCheckInVerified && !stopped) stopped = 'APP_CHECKIN_UNVERIFIED';
    if (stopped || code !== 0 || signal || !result.finished) {
      result.status = 'failed';
      result.errorCode = stopped || result.errorCode || (code !== 0 || signal ? 'PROCESS_FAILED' : 'NO_FINAL_RESULT');
    }
    result.durationSeconds = Math.round((Date.now() - started) / 1000);
    if(hasSearchBudget) {
      result.searchPoints={...searchPoints};
      result.dailySearch=searchLedger.add(searchBudget.progress,searchPoints);
      verifiedTasks=searchLedger.applyTasks(verifiedTasks,result.dailySearch);
      if(searchLedger.platforms.every(p=>verifiedTasks[p+'Search']==='complete')) result.searchQuota='complete';
    }
    result.tasks = verifiedTasks;
    result.searchEvidence = searchEvidence.normalize({...observedSearch,pendingBefore,claimReceived:hasClaim?claimReceived:null});
    result.tasks = searchEvidence.applyTasks(result.tasks,result.searchEvidence);
    result.requiredTasks=requested;
    result.completion=taskStatus.completion(result.tasks,requested);
    result.timings=stages.snapshot();
    result.quotaDiagnostics=[...quotaDiagnostics];
    if (['mobileSearch','desktopSearch'].every(k=>result.tasks[k]==='complete')) result.searchQuota='complete';
    else result.searchQuota='unknown';
    result.readingPoints = readingPoints === 30 ? 30 :
      readingUncertain || stopped || code !== 0 || signal ? null : readingPoints;
    result.diagnostic = diagnostic;
    if (source.RUN_MODE === 'app-test') result.appCheckInVerified = appCheckInVerified;
    if (source.RUN_MODE === 'app-auth-probe') result.appAuthVerified = appAuthVerified;
    result.appCheckIn = ['test', 'diagnostic', 'app-auth-probe', 'app-read-test'].includes(source.RUN_MODE) ? 'not_requested'
      : appCheckInVerified ? 'verified' : appAuthRejected ? 'auth_rejected' : appCheckInAttempted ? 'unverified' : 'unknown';
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
  let remaining = Infinity;
  if (source.RUN_DATE) {
    remaining = schedule.deadline(source.RUN_DATE, source.RUN_MODE, source) - started;
    if (source.RUN_DATE !== schedule.dateVN(started) || remaining <= 0) {
      stopped = 'DAILY_WINDOW_EXPIRED';
      persist(1, null);
      return 1;
    }
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
  const accountLimit = options.timeoutMs ?? (schedule.lateReconcile(source.RUN_DATE, source.RUN_MODE, source) ? 15 : source.RUN_MODE === 'reconcile' ? 35 : source.RUN_MODE === 'app-read-test' ? 15 : ['app-test','app-auth-probe'].includes(source.RUN_MODE) ? 10 : 75) * 60000;
  const timeout = setTimeout(() => stop(remaining <= accountLimit ? 'DAILY_WINDOW_EXPIRED' : 'ACCOUNT_TIMEOUT'),
    Math.min(accountLimit, remaining));
  const heartbeat = setInterval(() => console.log('Worker running; details remain private.'), 60000);
  const privateLogPath = captureLogPath(source, id);
  const privateLog = fs.createWriteStream(privateLogPath, {flags: 'w', mode: 0o600});
  const maxRawLogBytes = 2 * 1024 * 1024;
  let rawLogBytes = 0, logTruncated = false;
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    readline.createInterface({input: stream}).on('line', line => {
      const record = `[${name}] ${line}\n`;
      const size = Buffer.byteLength(record);
      if (rawLogBytes + size <= maxRawLogBytes) {
        privateLog.write(record);
        rawLogBytes += size;
      } else {
        logTruncated = true;
      }
      // Raw bot lines stay off public Actions logs; only fixed-label diagnostics are reported.
      diagnose(line);
      const timingAt=line.indexOf('REWARDS_STAGE_TIMING ');
      if(timingAt>=0)try {
        const e=JSON.parse(line.slice(timingAt+'REWARDS_STAGE_TIMING '.length));
        if(e.schema===1&&e.date===source.RUN_DATE&&e.accountId===id)stages.accept(e);
      }catch{}
      for (const marker of ['SEARCH_QUOTA_EVIDENCE ', 'SEARCH_CLAIM_RECEIPT ']) {
        const at=line.indexOf(marker);
        if(at<0) continue;
        try {
          const event=JSON.parse(line.slice(at+marker.length));
          if(event.schema!==1 || event.date!==source.RUN_DATE || event.accountId!==id) continue;
          if(marker==='SEARCH_QUOTA_EVIDENCE ') {
            observedSearch=searchEvidence.merge(observedSearch,event);
            const d=searchEvidence.diagnostic(event.diagnostic);
            if(d&&(d.reason!=='poll'||d.ui.attempted||!observedSearch.mobile||!observedSearch.desktop)) {
              quotaDiagnostics.push(d);if(quotaDiagnostics.length>40)quotaDiagnostics.shift();
            }
          }
          else {
            pendingBefore=searchEvidence.normalize({pendingBefore:event.pendingBefore}).pendingBefore;
            if(searchEvidence.metric(event.received)!==null) {hasClaim=true;claimReceived=Math.min(100000,claimReceived+event.received);}
          }
        } catch {}
      }
      const searchAt=line.indexOf('DAILY_SEARCH_CREDIT ');
      if(hasSearchBudget && searchAt>=0) try {
        const event=JSON.parse(line.slice(searchAt+'DAILY_SEARCH_CREDIT '.length));
        const p=event.platform;
        if(event.schema===1 && event.date===source.RUN_DATE && event.accountId===id && searchLedger.platforms.includes(p) &&
           Number.isSafeInteger(event.points) && event.points>=searchPoints[p] && event.points<=10000)
          searchPoints[p]=event.points;
      } catch {}
      for (const marker of ['DAILY_TASK_VERIFICATION ', 'DAILY_READING_CREDIT ']) {
        const position = line.indexOf(marker);
        if (position < 0) continue;
        try {
          const event = JSON.parse(line.slice(position + marker.length));
          if (event.date !== source.RUN_DATE) continue;
          if (marker === 'DAILY_TASK_VERIFICATION ') verifiedTasks = taskStatus.merge(verifiedTasks, event.tasks);
          else if (Number.isSafeInteger(event.points) && event.points >= readingPoints && event.points <= 30)
            readingPoints = event.points;
        } catch {}
      }
      if (line.includes('[READ-TO-EARN]') && line.includes('Error during Read to Earn')) readingUncertain = true;
      if (line.includes('[APP-AUTH-PROBE] Stable read confirmed') && line.includes('successfulReads=2')) appAuthVerified = true;
      if (line.includes('[DAILY-CHECK-IN]') && line.includes('Recorded verified completion marker')) {
        appCheckInVerified = true;
        verifiedTasks.appCheckIn = 'complete';
      }
      if (line.includes('[DAILY-CHECK-IN]') && line.includes('Starting Daily Check-In')) appCheckInAttempted = true;
      if (/\[(GET-APP-DASHBOARD-DATA|GET-APP-EARNABLE-POINTS|DAILY-CHECK-IN)\]/.test(line) && /status code 401/.test(line)) appAuthRejected = true;
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
  await new Promise(resolve => privateLog.end(resolve));
  let logText = redactLog(fs.readFileSync(privateLogPath, 'utf8'), source);
  if (logTruncated) logText += '\n[Log truncated after the 2 MiB capture limit.]\n';
  const maxSafeLogBytes = 900 * 1024;
  if (Buffer.byteLength(logText) > maxSafeLogBytes) {
    logText = Buffer.from(logText).subarray(-maxSafeLogBytes).toString('utf8');
    logText = '[Earlier log lines omitted to fit the 900 KiB private log limit.]\n' + logText;
  }
  fs.writeFileSync(privateLogPath, logText, {mode: 0o600});
  clearTimeout(timeout);
  clearTimeout(killTimer);
  clearInterval(heartbeat);
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  killGroup('SIGKILL');
  const result = persist(code, signal);
  console.log('Worker finished; report prepared privately.');
  return result.status === 'completed' && code === 0 && !signal ? 0 : 1;
}

const statusText = {completed: 'Đã kết thúc lượt chạy', failed: 'Lượt chạy gặp lỗi', needs_action: 'Cần kiểm tra', running: 'Chưa kết thúc'};
const quotaText = {complete: 'Đã hết hạn mức', remaining: 'Còn hạn mức', unknown: 'Chưa xác minh', not_requested: 'Không được yêu cầu'};
function accountMessage(r, email, url) {
  if (process.env.RUN_MODE === 'app-auth-probe') return [
    '🔬 <b>KIỂM TRA XÁC THỰC APP</b>',
    `👤 <code>${html(email || `Tài khoản ${r.accountId}`)}</code>`,
    `📅 ${html(r.date)} · Giờ Việt Nam`, '',
    r.appAuthVerified ? '✅ API App đã chấp nhận token.' : '❌ Chưa xác thực được API App.',
    'Chế độ chỉ đọc; kết quả chi tiết đã lưu private.',
    `<a href="${html(url)}">🔗 Xem lượt kiểm tra GitHub</a>`
  ].join('\n');
  const daily = r.diagnostic?.dailySet;
  const dailyText = daily && daily.state !== 'unverified'
    ? `${daily.completed}/${daily.total} · ${daily.state === 'complete' ? 'Hoàn tất' : 'Chưa hoàn tất'}` : 'Chưa xác minh';
  const lines = [
    '🏆 <b>MICROSOFT REWARDS</b>',
    `<b>${process.env.RUN_MODE === 'reconcile' ? 'Kiểm tra và chạy bù · ' : process.env.RUN_MODE === 'test' ? 'Kiểm tra Daily Set · ' : process.env.RUN_MODE === 'retry' ? 'Chạy dự phòng · ' : ''}Báo cáo tài khoản ${r.accountId}/6</b>`,
    `👤 <code>${html(email || `Tài khoản ${r.accountId}`)}</code>`,
    `📅 ${html(r.date)} · Giờ Việt Nam`, '',
    `${r.status === 'completed' ? '✅' : r.status === 'needs_action' ? '⚠️' : '❌'} <b>Trạng thái:</b> ${statusText[r.status] || 'Chưa có kết quả'}`,
    `📋 <b>Hoàn tất nhiệm vụ:</b> ${taskStatus.completionLabels[taskStatus.completion(r.tasks,r.requiredTasks).status]}`,
    `💎 <b>Điểm trong lượt:</b> ${gain(r.pointsEarned)}`,
    `💰 <b>Số dư:</b> ${fmt(r.initialBalance)} → ${fmt(r.finalBalance)}`,
    ...(r.tasks ? taskStatus.lines(r.tasks,r.dailySearch,r.searchEvidence) : [
      `🔥 <b>Daily Set:</b> ${dailyText}`,
      `📱 <b>App check-in:</b> ${{verified:'Máy chủ xác nhận',auth_rejected:'Chưa thực hiện · API từ chối 401',unverified:'Đã gửi · Chưa xác minh',not_requested:'Không được yêu cầu'}[r.appCheckIn] || 'Chưa xác minh'}`,
      '📰 <b>Read to Earn:</b> Chưa xác minh',
      `🔎 <b>Tìm kiếm:</b> ${quotaText[r.searchQuota] || 'Chưa xác minh'}`
    ]),
    `⏱️ <b>Thời gian:</b> ${number(r.durationSeconds) === null ? 'Chưa xác minh' : (r.durationSeconds / 60).toFixed(1) + ' phút'}`,
    ...performance.lines(r.timings)
  ];
  if (process.env.RUN_MODE === 'morning' && (require('./rewards-state.cjs').needsPointsReview(r.pointsEarned) ||
      Object.values(r.tasks||{}).includes('missing') || (r.dailySearch && searchLedger.needsReview(r.dailySearch,r.tasks))))
    lines.push(taskStatus.completion(r.tasks,r.requiredTasks).status==='verified' ? '🔍 <b>Cảnh báo điểm:</b> Dưới 220 hoặc thiếu số liệu; nhiệm vụ đã xác minh đủ, không tự lặp lại để đạt mốc.' : '🔍 <b>Cần kiểm tra lại:</b> Dưới 220 điểm hoặc nhiệm vụ chưa xác minh đủ; chạy bù xét bằng chứng còn thiếu.');
  if (process.env.RUN_MODE === 'reconcile' &&
      (r.tasks?.mobileSearch === 'unknown' || r.tasks?.desktopSearch === 'unknown' || r.searchQuota === 'unknown'))
    lines.push('ℹ️ Lượt bù chỉ tìm kiếm khi Microsoft xác nhận quota còn thiếu; quota chưa rõ được giữ để kiểm tra.');
  if (r.errorCode) lines.push(`⚠️ <b>Mã lỗi:</b> <code>${html(errorLabel(r.errorCode))}</code>`);
  if (r.appCheckIn === 'auth_rejected') lines.push('⚠️ <b>API App:</b> Chưa thực hiện · API từ chối 401');
  if (r.status !== 'completed' && r.diagnostic) {
    lines.push(`📍 <b>Bước cuối:</b> ${html(r.diagnostic.stage)}`);
    if (r.diagnostic.errors.length) lines.push(`🛠️ <b>Chẩn đoán:</b> ${html(r.diagnostic.errors.slice(-3).join(', '))}`);
  }
  lines.push('', ['test','app-test','app-read-test','diagnostic'].includes(process.env.RUN_MODE) ? '🔬 Đã kết thúc lượt kiểm tra riêng.' : r.accountId < 6 ? '☕ Nghỉ ngẫu nhiên 100–180 giây rồi chuyển tài khoản tiếp theo.' : '🏁 Đã đến tài khoản cuối cùng trong danh sách.');
  lines.push(`<a href="${html(url)}">🔗 Xem lượt chạy GitHub</a>`);
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
  if (!response.ok || body.ok !== true) {
    const error = new Error('Telegram rejected notification');
    // A valid Telegram error response explicitly confirms that no message was accepted.
    error.definitelyNotDelivered = body.ok === false;
    throw error;
  }
  console.log('Telegram report delivered.');
}
async function prepareReport() {
  const id = accountSlot();
  const r = read(process.env.REPORT_PATH) || {accountId: id, date: process.env.RUN_DATE || dateVN(), status: 'failed',
    initialBalance: null, finalBalance: null, pointsEarned: null, durationSeconds: null,
    searchQuota: 'unknown', errorCode: process.env.JOB_STATUS === 'cancelled' ? 'CANCELLED' : 'SETUP_FAILED'};
  // Balances remain in the private repository; never emit them as Actions outputs.
  const output = {accountId: id, date: r.date, status: r.status, pointsEarned: r.pointsEarned,
    initialBalance: r.initialBalance, finalBalance: r.finalBalance, errorCode: r.errorCode, appCheckIn: r.appCheckIn,
    tasks: r.tasks, requiredTasks:r.requiredTasks, completion:r.completion, timings:r.timings, quotaDiagnostics:r.quotaDiagnostics,
    readingPoints: r.readingPoints, searchPoints:r.searchPoints, dailySearch:r.dailySearch, searchEvidence:r.searchEvidence};
  await require('./rewards-state.cjs').savePrivateReport(output);
  await require('./rewards-operations.cjs').enqueue(`account-${id}`,
    accountMessage(r, process.env.ACCOUNT_EMAIL, process.env.RUN_URL));
  console.log('Account report saved privately; notification queued.');
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
  const verified=rows.filter(({r})=>r?.status==='completed'&&taskStatus.completion(r.tasks,r.requiredTasks).status==='verified').length;
  const lines = ['🏆 <b>MICROSOFT REWARDS</b>', env.RUN_MODE === 'reconcile' ? '🔍 <b>Tổng kết kiểm tra và chạy bù</b>' : env.RUN_MODE === 'retry' ? '🔁 <b>Tổng kết lượt dự phòng</b>' : '📊 <b>Tổng kết 6 tài khoản</b>', `${env.RUN_DATE || dateVN()} · Giờ Việt Nam`, '',
    `💎 <b>Điểm ghi nhận:</b> ${points.n ? gain(points.total) : 'Chưa xác minh'} (${points.n}/6 tài khoản có số liệu)`,
    `⚙️ <b>Tiến trình kết thúc:</b> ${completed}/6 · ✅ <b>Nhiệm vụ xác minh đủ:</b> ${verified}/6`,
    `💰 <b>Tổng số dư:</b> ${initial.n === 6 && final.n === 6 ? fmt(initial.total) + ' → ' + fmt(final.total) : 'Chưa đủ số liệu 6 tài khoản'}`, ''];
  for (const {id, r} of rows) {
    lines.push(`<b>${id}. ${html(env[`ACCOUNT_${id}_EMAIL`] || `Tài khoản ${id}`)}</b>`);
    lines.push(r ? `${gain(r.pointsEarned)} điểm · ${r.status === 'completed' ? taskStatus.completionLabels[taskStatus.completion(r.tasks,r.requiredTasks).status] : 'Lượt chạy gặp lỗi'}` : env.RUN_MODE === 'retry' && jobs[`account_${id}`]?.result === 'success' ? 'Không thuộc diện chạy lại / đã dùng lượt dự phòng' : 'Không chạy hoặc chưa có kết quả');
    if (r?.tasks) lines.push(...taskStatus.lines(r.tasks,r.dailySearch,r.searchEvidence,true));
    if (env.RUN_MODE === 'morning' && r && (require('./rewards-state.cjs').needsPointsReview(r.pointsEarned) ||
        Object.values(r.tasks||{}).includes('missing') || (r.dailySearch && searchLedger.needsReview(r.dailySearch,r.tasks))))
      lines.push(taskStatus.completion(r.tasks,r.requiredTasks).status==='verified' ? '🔍 Dưới 220/thiếu số liệu; nhiệm vụ đã xác minh đủ.' : '🔍 Cần xem lại điểm hoặc nhiệm vụ; bù theo quota thực tế.');
  }
  if (env.STATE_ENABLED === 'false') lines.push('', 'Chưa có REWARDS_STATE_TOKEN: chưa bật lưu trạng thái và chạy dự phòng.');
  lines.push('', 'Điểm tính theo chênh lệch số dư của lượt chạy; không đồng nghĩa đã hoàn thành mọi nhiệm vụ.',
    `<a href="${html(env.RUN_URL)}">🔗 Xem lượt chạy GitHub</a>`);
  return lines.join('\n');
}
async function main() {
  switch (process.argv[2]) {
    case 'configure': configure(); break;
    case 'configure-login-diagnostic': configure(true); break;
    case 'run': process.exitCode = await runAccount(); break;
    case 'prepare-report': await prepareReport(); break;
    case 'report': await require('./rewards-operations.cjs').deliver(`account-${accountSlot()}`, telegram); break;
    case 'resend': await require('./rewards-operations.cjs').resendPending(telegram); break;
    case 'summary': {
      const jobs = await require('./rewards-state.cjs').readPrivateReports(JSON.parse(process.env.JOB_RESULTS));
      const operations = require('./rewards-operations.cjs');
      await operations.enqueue('summary', summaryMessage(jobs));
      await operations.deliver('summary', telegram);
      break;
    }
    case 'rest': {
      const seconds = randomInt(100, 181);
      console.log(`Resting ${seconds} seconds before the next account.`);
      await wait(seconds * 1000);
      break;
    }
    default: throw new Error('Invalid operation');
  }
}
module.exports = {number, cleanResult, childEnvironment, redactLog, runAccount, accountMessage, summaryMessage, telegram};
if (require.main === module) main().catch(() => {
  console.error('Automation step failed. Check setup or Telegram delivery; sensitive details were suppressed.');
  process.exitCode = 1;
});

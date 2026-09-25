'use strict';
module.exports = function createDiagnostics(diagnostic, saveDiagnostic = () => {}) {
function diagnose(line) {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (clean.startsWith('DAILY_SET_VERIFICATION ')) {
    try {
      const v = JSON.parse(clean.slice('DAILY_SET_VERIFICATION '.length));
      if (['complete', 'incomplete', 'unverified'].includes(v.state) && [v.total, v.completed, v.remaining].every(n => Number.isSafeInteger(n) && n >= 0)) {
        diagnostic.dailySet = {state: v.state, total: v.total, completed: v.completed, remaining: v.remaining};
        if (process.env.DEBUG_DAILY_SET === 'true') console.log('Daily Set verification: ' + JSON.stringify(diagnostic.dailySet));
      }
    } catch {}
  }
  if (process.env.DEBUG_DAILY_SET === 'true') {
    if (clean.startsWith('LOGIN_ALERT_DIAGNOSTIC ')) {
      try {
        const v = JSON.parse(clean.slice('LOGIN_ALERT_DIAGNOSTIC '.length));
        const safe = {persistent: v.persistent === true, textAvailable: v.textAvailable === true};
        console.log('Login alert diagnostic: ' + JSON.stringify(safe));
      } catch { console.log('Login alert diagnostic could not be parsed'); }
    }
    if (clean.startsWith('SERVER_ACTION_DIAGNOSTIC ')) {
      try {
        const v = JSON.parse(clean.slice('SERVER_ACTION_DIAGNOSTIC '.length));
        const safe = {};
        for (const k of ['length', 'rows', 'decimalTrueRows', 'hexTrueRows', 'falseRows', 'errorRows', 'status']) {
          if (Number.isSafeInteger(v[k]) && v[k] >= 0) safe[k] = v[k];
        }
        for (const k of ['html', 'redirectMarker', 'hasAvailablePoints', 'acknowledged']) safe[k] = v[k] === true;
        for (const [k, allowed] of Object.entries({kind: ['string', 'object', 'array', 'null', 'boolean', 'number', 'undefined'], contentType: ['rsc', 'json', 'html', 'other'], route: ['earn', 'dashboard', 'other']})) {
          safe[k] = allowed.includes(v[k]) ? v[k] : 'other';
        }
        console.log('Server action response shape: ' + JSON.stringify(safe));
      } catch { console.log('Server action diagnostic could not be parsed'); }
    }
    if (clean.startsWith('DAILY_SET_URL_DIAGNOSTIC ')) {
      try {
        const v = JSON.parse(clean.slice('DAILY_SET_URL_DIAGNOSTIC '.length));
        const source = ['dom', 'dashboard', 'snapshot'].includes(v.source) ? v.source : 'other';
        const host = typeof v.host === 'string' && /(^|\.)bing\.com$/i.test(v.host) ? v.host : 'other';
        const matchedBy = typeof v.matchedBy === 'string' && /^[a-z0-9+_-]{1,40}$/i.test(v.matchedBy) ? v.matchedBy : 'other';
        console.log('Daily Set URL: ' + JSON.stringify({
          source, host, matchedBy,
          hasBTDSUOID: v.hasBTDSUOID === true,
          hasPUBL: v.hasPUBL === true,
          hasCREA: v.hasCREA === true,
          hasRnoreward: v.hasRnoreward === true
        }));
      } catch { console.log('Daily Set URL diagnostic could not be parsed'); }
    }
    if (clean.startsWith('DAILY_SET_DIAGNOSTIC ')) {
      try {
        const v = JSON.parse(clean.slice('DAILY_SET_DIAGNOSTIC '.length));
        const date = value => typeof value === 'string' && /^[0-9TZ:./+-]+$/.test(value) ? value : '?';
        console.log('Daily Set dates: ' + JSON.stringify({utc: date(v.utcNow), machine: date(v.machineDate), vietnam: date(v.vietnamDate), partialDashboard: v.partialDashboard === true, selectedDatePresent: v.selectedDatePresent === true,
          groups: (Array.isArray(v.groups) ? v.groups : []).slice(0, 14).map(g => ({date: date(g.date), total: Number(g.total), incomplete: Number(g.incomplete), pendingWithPoints: Number(g.pendingWithPoints)}))}));
      } catch { console.log('Daily Set diagnostic could not be parsed'); }
    }
    if (clean.startsWith('MORE_PROMOTIONS_DIAGNOSTIC ')) {
      try {
        const v = JSON.parse(clean.slice('MORE_PROMOTIONS_DIAGNOSTIC '.length));
        const allowedPools = ['morePromotions', 'morePromotionsWithoutPromotionalItems', 'promotionalItem', 'promotionalItems', 'reactSnapshot'];
        const allowedKinds = ['mid_week_puzzle', 'puzzle', 'trivia', 'quote', 'wallpaper', 'sea_of_thieves', 'search_bar', 'referral', 'artist', 'birds', 'other'];
        const allowedTypes = ['urlreward', 'quiz', 'poll', 'search', 'other', 'none'];
        const allowedReasons = ['actionable', 'complete', 'no-points', 'locked', 'missing-type', 'negative-priority', 'promotional'];
        const counts = {};
        for (const pool of allowedPools) {
          const n = Number(v.counts?.[pool]);
          counts[pool] = Number.isSafeInteger(n) && n >= 0 ? n : 0;
        }
        const items = (Array.isArray(v.items) ? v.items : []).slice(0, 40).map(item => ({
          pool: allowedPools.includes(item.pool) ? item.pool : 'other',
          titleKind: allowedKinds.includes(item.titleKind) ? item.titleKind : 'other',
          complete: item.complete === true,
          pointProgress: Number.isSafeInteger(Number(item.pointProgress)) ? Number(item.pointProgress) : 0,
          pointProgressMax: Number.isSafeInteger(Number(item.pointProgressMax)) ? Number(item.pointProgressMax) : 0,
          type: allowedTypes.includes(item.type) ? item.type : 'other',
          locked: item.locked === true,
          promotional: item.promotional === true,
          priority: Number.isSafeInteger(Number(item.priority)) ? Number(item.priority) : 0,
          actionable: item.actionable === true,
          reason: allowedReasons.includes(item.reason) ? item.reason : 'other'
        }));
        console.log('More Promotions pools: ' + JSON.stringify({
          partialDashboard: v.partialDashboard === true,
          counts,
          items
        }));
      } catch { console.log('More Promotions diagnostic could not be parsed'); }
    }
    const tag = clean.match(/\[(DAILY-SET|MORE-PROMOTIONS|ACTIVITY|URL-REWARD|GET-DASHBOARD-DATA|REACT-PARSE)\]/)?.[1];
    if (tag) {
      const labels = [
        ['All "Daily Set" items have already been completed', 'NO_PENDING_ITEMS'],
        ['Started solving', 'STARTED'], ['Finished processing', 'FINISHED_PROCESSING'],
        ['All "More Promotions" items have already been completed', 'NO_MORE_PROMOTIONS_PENDING'],
        ['Recovered React-only point activity', 'REACT_ONLY_RECOVERED'],
        ['Found activity type "UrlReward"', 'URL_REWARD_SELECTED'],
        ['Starting UrlReward', 'URL_REWARD_STARTED'], ['Completed UrlReward', 'URL_REWARD_COMPLETED'],
        ['Retrying UrlReward once', 'URL_REWARD_RETRY'],
        ['credited no points', 'NO_POINTS_CREDITED'], ['not acknowledged', 'NOT_ACKNOWLEDGED'],
        ['not reportable', 'NOT_REPORTABLE'], ['not present in page snapshot', 'OFFER_NOT_FOUND'],
        ['not discovered in bundle', 'ACTION_NOT_FOUND'], ['unsupported type', 'UNSUPPORTED_TYPE'],
        ['disabled in config', 'DISABLED'], ['using Bing flyout fallback', 'FALLBACK_SELECTED'],
        ['Using partial Bing flyout dashboard', 'PARTIAL_DASHBOARD'], ['Error in doUrlReward', 'URL_REWARD_ERROR']
      ].filter(([needle]) => clean.includes(needle)).map(([, label]) => label);
      const counts = [...clean.matchAll(/\b(remaining|offers|reportable|streaks|pointsGained|currentBalance|expected|status)=(-?\d+)\b/g)].map(m => m[1] + '=' + m[2]);
      console.log('[Diagnostic][' + tag + '] ' + [...labels, ...counts].join(' '));
    }
  }
  const stage = clean.match(/\[(BROWSER|SESSION|LOGIN|LOGIN-ENTER-EMAIL|LOGIN-ENTER-PASSWORD|DAILY-SET|READ-TO-EARN|SEARCH-MANAGER|SEARCH-BING)\]/)?.[1];
  if (stage) diagnostic.stage = stage;
  const state = clean.match(/State transition: [A-Z_]+\s*\u2192\s*(EMAIL_INPUT|FOOTER_ACTION|PASSWORD_INPUT|KMSI_PROMPT|ERROR_ALERT|EMAIL_VERIFICATION_INPUT|RECOVERY_EMAIL_INPUT|SIGN_IN_METHOD_PICKER|2FA_TOTP|LOGIN_PASSWORDLESS|PASSWORDLESS_SEND_CODE|OTP_CODE_ENTRY|PASSKEY_ERROR|PASSKEY_VIDEO|ACCOUNT_LOCKED|LOGGED_IN|UNKNOWN|CHROMEWEBDATA_ERROR)\b/)?.[1];
  if (state) diagnostic.loginState = state;
  const patterns = [
    [/net::ERR_EMPTY_RESPONSE/, 'ERR_EMPTY_RESPONSE'],
    [/net::ERR_PROXY_CONNECTION_FAILED/, 'ERR_PROXY_CONNECTION_FAILED'],
    [/net::ERR_SOCKS_CONNECTION_FAILED/, 'ERR_SOCKS_CONNECTION_FAILED'],
    [/net::ERR_TUNNEL_CONNECTION_FAILED/, 'ERR_TUNNEL_CONNECTION_FAILED'],
    [/net::ERR_NAME_NOT_RESOLVED/, 'ERR_NAME_NOT_RESOLVED'],
    [/net::ERR_CONNECTION_RESET/, 'ERR_CONNECTION_RESET'],
    [/Microsoft login error: Unknown Error/, 'MICROSOFT_LOGIN_UNKNOWN_ERROR'],
    [/Microsoft login error:/, 'MICROSOFT_LOGIN_ERROR'],
    [/Login alert disappeared before handling/, 'TRANSIENT_LOGIN_ALERT'],
    [/Password input detected but no password is configured/, 'PASSWORD_NOT_CONFIGURED'],
    [/Executable doesn't exist/, 'BROWSER_EXECUTABLE_MISSING'],
    [/error while loading shared libraries/, 'BROWSER_LIBRARY_MISSING'],
    [/Missing X server|without having a XServer/, 'DISPLAY_MISSING'],
    [/Target page, context or browser has been closed/, 'BROWSER_OR_CONTEXT_CLOSED'],
    [/TimeoutError|Timeout \d+ms exceeded|timed out/i, 'TIMEOUT'],
    [/Fraud_UserWarning_BotScore_UX/, 'BOT_WARNING'],
    [/chromewebdata error/i, 'CHROMEWEBDATA_ERROR']
  ];
  let recognized = false;
  for (const [pattern, label] of patterns) {
    if (!pattern.test(clean)) continue;
    recognized = true;
    if (!diagnostic.errors.includes(label)) diagnostic.errors.push(label);
  }
  if (/\[ERROR\]/.test(clean) && !recognized && !diagnostic.errors.includes('UNCLASSIFIED_ERROR')) {
    diagnostic.errors.push('UNCLASSIFIED_ERROR');
  }
  saveDiagnostic();
}

return diagnose;
};


'use strict';
// Read-only selection correction for the initial v5 adapter. Never delete/reopen claims.
function confirmedFormTimeout(entry, text, date, slot) {
  if (entry?.status !== 'failed' || entry.errorCode !== 'AUTH_REQUIRED' ||
      !/^\d+$/.test(entry.runId || '') || !/^\d+$/.test(entry.runAttempt || '') ||
      !entry.diagnostic?.errors?.includes('TIMEOUT') ||
      entry.diagnostic.errors.some(x => !['TIMEOUT','UNCLASSIFIED_ERROR'].includes(x))) return false;
  const events = readEvents(entry, text, date, slot);
  const end = events.findLast(e => e.data?.kind === 'account');
  if (end?.data?.status !== 'failed' || end.data.reason !== 'Login failed or aborted at state: EMAIL_INPUT') return false;
  if (events.some(e => e.level === 'error' && /Microsoft login error|TOTP|OTP|authenticator|ACCOUNT_LOCKED|serviceAbuse/i.test(e.message || ''))) return false;
  return events.some(e => e.level === 'error' && e.title === 'LOGIN-ENTER-EMAIL' &&
    /Timeout \d+ms exceeded/.test(e.message || '') && /locator\.(?:fill|waitFor)|detached from the DOM/.test(e.message || ''));
}
function readEvents(entry, text, date, slot) {
  return String(text).split('\n').flatMap(line => {
    const marker = '__REWARDS_EVENT__ ', at = line.indexOf(marker);
    if (at < 0 || line.length > 262144) return [];
    try {
      const e = JSON.parse(line.slice(at + marker.length));
      return e.version === 2 && e.runId === `${date}:${slot}:${entry.runId}` &&
        Number.isFinite(Date.parse(e.ts)) && new Date(Date.parse(e.ts) + 7*3600000).toISOString().slice(0,10) === date ? [e] : [];
    } catch { return []; }
  });
}
function confirmedDashboard503(entry, text, date, slot) {
  const errors = entry?.diagnostic?.errors;
  if (entry?.status !== 'failed' || entry.errorCode !== 'AUTH_REQUIRED' ||
      entry.diagnostic?.loginState !== 'LOGGED_IN' ||
      !Array.isArray(errors) || errors.some(x => x !== 'UNCLASSIFIED_ERROR')) return false;
  const events = readEvents(entry, text, date, slot);
  const end = events.findLastIndex(e => e.data?.kind === 'account');
  if (events[end]?.data?.status !== 'failed' ||
      events[end].data.reason !== 'Failed to acquire rewards context: Rewards dashboard did not render (no section#dailyset) - likely a login/redirect issue, aborting') return false;
  if (events.some(e => e.level === 'error' &&
      /Microsoft login error|TOTP|OTP|authenticator|ACCOUNT_LOCKED|AUTH_REQUIRED|AUTH_METHOD_UNAVAILABLE|recovery email|serviceAbuse|Fraud_UserWarning|invalid password|status(?:=| code | )40[13]/i.test(e.message || ''))) return false;
  return ['MOBILE','DESKTOP'].some(platform => {
    const same = events.slice(0, end).filter(e => e.platform === platform);
    const login = same.findLastIndex(e => e.title === 'LOGIN' && e.message === 'Successfully logged in');
    if (login < 0) return false;
    const latest = new Map();
    for (const e of same.slice(login + 1)) {
      const match = /^Failed to fetch (\/earn|\/dashboard) HTML \| (status=(\d+)|error=)/.exec(e.message || '');
      if (e.title === 'BOOTSTRAP' && match) latest.set(match[1], match[3]);
    }
    return latest.get('/earn') === '503' && latest.get('/dashboard') === '503';
  });
}
async function selectionView(state, ctx, readLog) {
  if (!['retry','reconcile'].includes(ctx.mode)) return state;
  let view = state;
  for (const mode of ['morning','retry','reconcile']) {
    const entry = state[mode];
    if (entry?.status !== 'failed' || entry.errorCode !== 'AUTH_REQUIRED' ||
        (!entry.diagnostic?.errors?.includes('TIMEOUT') && entry.diagnostic?.loginState !== 'LOGGED_IN') ||
        !/^\d+$/.test(entry.runId || '') || !/^\d+$/.test(entry.runAttempt || '')) continue;
    const log = await readLog(entry);
    const code = confirmedFormTimeout(entry, log, ctx.date, ctx.slot) ? 'LOGIN_TRANSIENT_ERROR' :
      confirmedDashboard503(entry, log, ctx.date, ctx.slot) ? 'HTTP_503' : null;
    if (code) view = {...view, [mode]: {...entry, errorCode:code, retryable:true}};
  }
  return view;
}
module.exports = {confirmedFormTimeout, confirmedDashboard503, selectionView};

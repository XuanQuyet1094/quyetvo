'use strict';
// Read-only selection correction for the initial v5 adapter. Never delete/reopen claims.
function confirmedFormTimeout(entry, text, date, slot) {
  if (entry?.status !== 'failed' || entry.errorCode !== 'AUTH_REQUIRED' ||
      !/^\d+$/.test(entry.runId || '') || !/^\d+$/.test(entry.runAttempt || '') ||
      !entry.diagnostic?.errors?.includes('TIMEOUT') ||
      entry.diagnostic.errors.some(x => !['TIMEOUT','UNCLASSIFIED_ERROR'].includes(x))) return false;
  const events = String(text).split('\n').flatMap(line => {
    const marker = '__REWARDS_EVENT__ ', at = line.indexOf(marker);
    if (at < 0 || line.length > 262144) return [];
    try {
      const e = JSON.parse(line.slice(at + marker.length));
      return e.version === 2 && e.runId === `${date}:${slot}:${entry.runId}` &&
        Number.isFinite(Date.parse(e.ts)) && new Date(Date.parse(e.ts) + 7*3600000).toISOString().slice(0,10) === date ? [e] : [];
    } catch { return []; }
  });
  const end = events.findLast(e => e.data?.kind === 'account');
  if (end?.data?.status !== 'failed' || end.data.reason !== 'Login failed or aborted at state: EMAIL_INPUT') return false;
  if (events.some(e => e.level === 'error' && /Microsoft login error|TOTP|OTP|authenticator|ACCOUNT_LOCKED|serviceAbuse/i.test(e.message || ''))) return false;
  return events.some(e => e.level === 'error' && e.title === 'LOGIN-ENTER-EMAIL' &&
    /Timeout \d+ms exceeded/.test(e.message || '') && /locator\.(?:fill|waitFor)|detached from the DOM/.test(e.message || ''));
}
async function selectionView(state, ctx, readLog) {
  if (!['retry','reconcile'].includes(ctx.mode)) return state;
  let view = state;
  for (const mode of ['morning','retry','reconcile']) {
    const entry = state[mode];
    if (entry?.errorCode !== 'AUTH_REQUIRED' || !entry.diagnostic?.errors?.includes('TIMEOUT') ||
        !/^\d+$/.test(entry.runId || '') || !/^\d+$/.test(entry.runAttempt || '')) continue;
    const log = await readLog(entry);
    if (!confirmedFormTimeout(entry, log, ctx.date, ctx.slot)) continue;
    view = {...view, [mode]: {...entry, errorCode:'LOGIN_TRANSIENT_ERROR', retryable:true}};
  }
  return view;
}
module.exports = {confirmedFormTimeout, selectionView};

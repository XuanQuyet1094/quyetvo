'use strict';
// Adapter for the upstream v5 machine channel. Never forward raw events to Actions.
const tasks = require('./rewards-tasks.cjs');
const metric = x => Number.isSafeInteger(x) && x >= 0 && x <= 100000 ? x : null;
const vnDate = value => new Date(Date.parse(value) + 7 * 3600000).toISOString().slice(0, 10);
function failure(reason) {
  const text = String(reason || '');
  if (/locked|serviceAbuse/i.test(text)) return 'ACCOUNT_LOCKED';
  if (/Fraud_UserWarning|bot.score/i.test(text)) return 'BOT_WARNING';
  if (/RECOVERY_EMAIL_REQUIRED/.test(text)) return 'RECOVERY_EMAIL_REQUIRED';
  if (/AUTH_METHOD_UNAVAILABLE/.test(text)) return 'AUTH_METHOD_UNAVAILABLE';
  if (/LOGIN_TRANSIENT_ERROR|Login failed or aborted at state: (?:EMAIL_INPUT|PASSWORD_INPUT)\b/.test(text)) return 'LOGIN_TRANSIENT_ERROR';
  if (/TOTP|OTP|2FA|authenticator|interactive|HTTP 40[13]|Microsoft login error|SIGN_IN_METHOD_PICKER|recovery email/i.test(text)) return 'AUTH_REQUIRED';
  if (/429|rate.limit/i.test(text)) return 'HTTP_429';
  if (/timeout|timed.out|detached|ERR_|ECONN|ENET|fetch failed/i.test(text)) return 'NETWORK_TIMEOUT';
  if (/^(?:Failed to acquire rewards context: )?REWARDS_BOOTSTRAP_HTTP_503: \/earn and \/dashboard unavailable$/.test(text)) return 'HTTP_503';
  if (/password|sign.in|login/i.test(text)) return 'AUTH_REQUIRED';
  if (/dashboard|snapshot|render/i.test(text)) return 'DASHBOARD_UNAVAILABLE';
  return 'FLOW_FAILED';
}
function collector(env, id) {
  const state = {tasks:tasks.tasks(), searchPoints:{mobile:null,desktop:null}, readingPoints:0, readingUncertain:false,
    claimReceived:0, hasClaim:false, result:null, searchExecution:{mobile:'unknown',desktop:'unknown'}};
  const daily = new Map(), claims = new Map();
  function activity(data, platform) {
    const complete = data.status === 'confirmed' || data.status === 'skipped' && /^(?:already-complete|offer-already-complete)$/.test(data.reason);
    const quotaPlatform=/^(mobile|desktop)-search-quota$/.exec(data.activity||'')?.[1];
    if(quotaPlatform && data.reason==='quota-unavailable' && state.searchExecution[quotaPlatform]==='unknown')
      state.searchExecution[quotaPlatform]='quota_unavailable';
    // Individual successes do not prove that every Keep earning card was discovered.
    if (data.activity === 'more-promotions' && !complete && ['failed','unconfirmed'].includes(data.status))
      state.tasks.keepEarning = 'missing';
    if (data.activity === 'daily-set' && typeof data.offerId === 'string') {
      const date = env.RUN_DATE.replaceAll('-', '');
      if (data.offerId.includes(date)) {
        daily.set(data.offerId, complete);
        if (daily.size >= 3) state.tasks.dailySet = [...daily.values()].every(Boolean) ? 'complete' : 'missing';
      }
    }
    if (data.activity === 'daily-check-in') state.tasks.appCheckIn = complete ? 'complete' : data.status === 'failed' ? 'missing' : 'unknown';
    if (data.activity === 'read-to-earn') {
      const budgetComplete=data.status==='skipped' && data.reason==='automation-reading-budget-complete';
      state.tasks.readToEarn = (complete || budgetComplete) && /^(?:read-to-earn-(?:browser-)?complete|browser-fallback-read-to-earn-complete|already-complete|automation-reading-budget-complete)$/.test(data.reason)
        ? 'complete' : /progress-unchanged|quota-incomplete/.test(data.reason) ? 'missing' : 'unknown';
      if (data.pointsKnown === true && metric(data.pointsGained) !== null)
        state.readingPoints = Math.max(state.readingPoints, Math.min(30,data.pointsGained));
      if (data.pointsKnown === false || data.status === 'failed') state.readingUncertain=true;
    }
    if (data.activity === 'search' && ['mobile','desktop'].includes(platform)) {
      state.tasks[platform+'Search'] = complete && /^(?:quota-complete|already-complete)$/.test(data.reason)
        ? 'complete' : data.reason === 'quota-incomplete' ? 'missing' : 'unknown';
      if(state.tasks[platform+'Search']==='complete') state.searchExecution[platform]='complete';
      if (data.pointsKnown === true && metric(data.pointsGained) !== null)
        state.searchPoints[platform] = Math.max(state.searchPoints[platform] || 0,data.pointsGained);
    }
    if (data.activity === 'doClaimBonusPoints' && complete && data.pointsKnown === true &&
      metric(data.pointsGained) !== null && typeof data.operationId === 'string') {
      claims.set(data.operationId,data.pointsGained);
      state.claimReceived = [...claims.values()].reduce((a,b)=>a+b,0);
      state.hasClaim = true;
    }
  }
  function accept(line) {
    const marker = '__REWARDS_EVENT__ ';
    if (!line.startsWith(marker) || line.length > 262144) return null;
    let event;
    try { event=JSON.parse(line.slice(marker.length)); } catch { return null; }
    if (event.version !== 2 || event.runId !== env.REWARDS_RUN_ID || event.user !== env.ACCOUNT_EMAIL ||
      !Number.isFinite(Date.parse(event.ts)) || vnDate(event.ts) !== env.RUN_DATE ||
      !['MAIN','MOBILE','DESKTOP'].includes(event.platform)) return null;
    const data=event.data, platform=event.platform.toLowerCase();
    if(event.title==='SEARCH-BING' && /^Searching \| search=\d+/.test(String(event.message||'')) &&
      ['mobile','desktop'].includes(platform)) state.searchExecution[platform]='attempted';
    if (data?.kind === 'activity') activity(data,platform);
    if (data?.kind === 'account-info' && Array.isArray(data.streaks)) {
      for (const streak of data.streaks) {
        const fresh = !streak.resetAt || Date.parse(streak.resetAt)>Date.parse(event.ts);
        if (!fresh || !/daily.?set/i.test(streak.label || '')) continue;
        if (streak.completedToday === true) state.tasks.dailySet='complete';
        else if (metric(streak.activitiesTotal)>0 && metric(streak.activitiesCompleted)!==null)
          state.tasks.dailySet=streak.activitiesCompleted>=streak.activitiesTotal?'complete':'missing';
      }
    }
    if (data?.kind === 'account') {
      // Final summaries can restore verified evidence even when earlier log entries were filtered.
      for (const list of ['completed','incomplete','unavailable','notApplicable'])
        for (const item of data.completion?.[list] || []) activity(item,item.platform);
      const fatal=['failed','skipped','cancelled'].includes(data.status) || data.status==='partial' &&
        /HTTP 40[13]|TOTP|password|authenticator|sign.in|login|service rate limit/i.test(String(data.reason||''));
      const known=data.pointsKnown === true && metric(data.initialPoints)!==null && metric(data.currentBalance)!==null;
      const gain=known?data.currentBalance-data.initialPoints:null;
      state.result={schema:1,accountId:id,date:env.RUN_DATE,status:fatal?'failed':'completed',finished:true,
        nativeStatus:['completed','partial','failed','skipped','cancelled'].includes(data.status)?data.status:null,
        initialBalance:known?data.initialPoints:null,finalBalance:known?data.currentBalance:null,
        pointsEarned:gain,searchQuota:'unknown',durationSeconds:metric(Math.round(data.durationSeconds)),
        errorCode:fatal?(data.status==='cancelled'?'CANCELLED':failure(data.reason)):null};
    }
    const title=typeof event.title==='string'&&/^[A-Z0-9-]{1,80}$/.test(event.title)?event.title:'V5';
    const level=['debug','info','warn','error'].includes(event.level)?event.level:'info';
    return {line:`[${level.toUpperCase()}] ${event.platform} [${title}] ${String(event.message||'').slice(0,12000)}`,state};
  }
  return {state,accept};
}
module.exports={collector,failure};

'use strict';
const fs = require('node:fs');
const path = require('node:path');
function verifiedSessionProbe(log, env, result) {
  if (result?.exitCode !== 0 || result.signal || result.errorCode === 'ACCOUNT_TIMEOUT' || result.errorCode === 'DAILY_WINDOW_EXPIRED') return false;
  const events = String(log).split('\n').flatMap(line => {
    const marker = '__REWARDS_EVENT__ ', at = line.indexOf(marker);
    if (at < 0 || line.length > 262144) return [];
    try {
      const e = JSON.parse(line.slice(at + marker.length)), ts = Date.parse(e.ts);
      return e.version === 2 && e.runId === `${env.RUN_DATE}:${env.ACCOUNT_SLOT}:${env.GITHUB_RUN_ID}` &&
        Number.isFinite(ts) && require('./rewards-schedule.cjs').dateVN(ts) === env.RUN_DATE ? [e] : [];
    } catch { return []; }
  });
  if (events.some(e => e.level === 'error' || e.data?.kind === 'activity' || e.data?.kind === 'account')) return false;
  const sessions = events.filter(e => e.title === 'SESSION-GENERATION' && e.data?.kind === 'session');
  return sessions.length === 4 && ['desktop','mobile'].every(platform => {
    const states = sessions.filter(e => e.data.platform === platform).map(e => e.data.status);
    return states.length === 2 && states[0] === 'running' && states[1] === 'completed';
  });
}
async function run(env = process.env) {
  const schedule = require('./rewards-schedule.cjs');
  if (env.RUN_MODE !== 'diagnostic' || env.RUN_DATE !== schedule.dateVN(Date.now()) ||
      !/^[1-6]$/.test(String(env.ACCOUNT_SLOT)) || !/^\d+$/.test(env.GITHUB_RUN_ID || '')) throw new Error('Invalid login probe scope');
  const cfg = JSON.parse(fs.readFileSync(path.join(env.BOT_DIR,'config.json'),'utf8'));
  if (cfg.rewardsMode !== 'api' || cfg.ensureStreakProtection !== false || cfg.autoClaimPunchcardRewards !== false ||
      !cfg.workers || !cfg.activities || Object.values(cfg.workers).some(Boolean) || Object.values(cfg.activities).some(Boolean) ||
      cfg.experimental?.edgeBrowsing === true) throw new Error('Login probe requires every earning activity disabled');
  // Native v5 session generation verifies Bing session evidence and captures cookies on both platforms.
  // It emits session events, not an account earning result. Never fabricate balances or points to make the adapter succeed.
  await require('./rewards-runner.cjs').runAccount({env,args:['dist/session/RegenerateSessions.js','--platform','both'],timeoutMs:10*60*1000});
  const log = fs.readFileSync(path.join(env.RUNNER_TEMP,'rewards-private',`account-${env.ACCOUNT_SLOT}.log`),'utf8');
  const result = JSON.parse(fs.readFileSync(env.REPORT_PATH,'utf8'));
  const verified = verifiedSessionProbe(log,env,result);
  console.log(verified ? 'Desktop and Mobile sessions verified; no earning activities ran.' : 'Session verification incomplete; redacted details remain private.');
  return verified ? 0 : 1;
}
module.exports = {verifiedSessionProbe,run};
if (require.main === module) run().then(code=>{process.exitCode=code}).catch(()=>{
  console.error('Login probe failed; details suppressed.');process.exitCode=1;
});

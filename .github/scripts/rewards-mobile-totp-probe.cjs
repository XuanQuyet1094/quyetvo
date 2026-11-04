'use strict';
const fs = require('node:fs');
const path = require('node:path');
const anchor = "        } catch {\n            throw new Error('Unable to submit TOTP code')\n        }";
const replacement = "        } catch (error) {\n            // Diagnostic checkout only. Do not change retry or submit behavior.\n            if (this.bot.isMobile && process.env.REWARDS_MOBILE_TOTP_DIAGNOSTIC === '1') {\n                const message = error instanceof Error ? error.message : ''\n                const indicators = {\n                    timeout: error instanceof Error && (error.name === 'TimeoutError' || /\\btimeout\\b|\\btimed out\\b/i.test(message)),\n                    intercepted: /intercepts pointer events|another element.*(?:receiv|intercept)/i.test(message),\n                    detached: /not attached|detached|removed from the DOM/i.test(message),\n                    disabled: /element is not enabled|element is disabled/i.test(message),\n                    hidden: /element is not visible|outside of the viewport/i.test(message),\n                    unstable: /element is not stable/i.test(message),\n                    closed: /target page.*closed|browser has been closed|page closed/i.test(message),\n                    strict: /strict mode violation/i.test(message)\n                }\n                const shape = await page.locator(TOTP_SUBMIT_SELECTOR).evaluateAll((elements, inputSelector) => {\n                    const shown = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'\n                    const visible = elements.filter(shown).slice(0, 12)\n                    const fields = Array.from(document.querySelectorAll(inputSelector)).filter(shown).slice(0, 12)\n                    const forms = new Set(fields.map(e => e.closest('form')).filter(Boolean))\n                    return {\n                        inputs: fields.length,\n                        visible: visible.length,\n                        disabled: visible.filter(e => e.matches(':disabled,[aria-disabled=\"true\"]')).length,\n                        sameForm: visible.filter(e => forms.has(e.closest('form'))).length,\n                        pointerBlocked: visible.filter(e => {\n                            const box = e.getBoundingClientRect()\n                            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)\n                            return hit !== null && hit !== e && !e.contains(hit)\n                        }).length\n                    }\n                }, TOTP_INPUT_SELECTOR).catch(() => null)\n                emitEvidence('MOBILE_TOTP_SUBMIT_DIAGNOSTIC', { indicators, shape })\n            }\n            throw new Error('Unable to submit TOTP code')\n        }";

function instrument(dir) {
  const file = path.join(dir,'src/browser/auth/methods/Totp2FALogin.ts');
  const source = fs.readFileSync(file,'utf8');
  if (source.split(anchor).length !== 2 || source.includes('MOBILE_TOTP_SUBMIT_DIAGNOSTIC'))
    throw Error('Unexpected diagnostic source layout');
  fs.writeFileSync(file, "import { emitEvidence } from '../../../automation/Compatibility'\n" +
    source.replace(anchor, () => replacement));
}

function verified(log, env, result) {
  if (result?.exitCode !== 0 || result.signal) return false;
  const run = env.RUN_DATE + ':2:' + env.GITHUB_RUN_ID;
  const events = log.split('\n').flatMap(line => {
    const marker = '__REWARDS_EVENT__ ', at = line.indexOf(marker);
    if (at < 0 || line.length > 262144) return [];
    try {
      const e = JSON.parse(line.slice(at + marker.length));
      return e.version === 2 && e.runId === run ? [e] : [];
    } catch { return []; }
  });
  if (events.some(e => e.level === 'error' || ['account','activity'].includes(e.data?.kind))) return false;
  const sessions = events.filter(e => e.title === 'SESSION-GENERATION' && e.data?.kind === 'session');
  return sessions.length === 2 && sessions.every(e => e.data.platform === 'mobile') &&
    sessions[0].data.status === 'running' && sessions[1].data.status === 'completed';
}

async function run(env) {
  const date = require('./rewards-schedule.cjs').dateVN(Date.now());
  if (date !== '2026-11-04' || env.RUN_DATE !== date) throw Error('Probe date expired');
  const cfg = JSON.parse(fs.readFileSync(path.join(env.BOT_DIR,'config.json'),'utf8'));
  if (cfg.rewardsMode !== 'api' || cfg.ensureStreakProtection !== false || cfg.autoClaimPunchcardRewards !== false ||
      !cfg.workers || !cfg.activities || Object.values(cfg.workers).some(Boolean) || Object.values(cfg.activities).some(Boolean) ||
      cfg.experimental?.edgeBrowsing === true || cfg.experimental?.browserSearchApiReport === true)
    throw Error('Only login-only mode is permitted');
  await require('./rewards-runner.cjs').runAccount({
    env:{...env,REWARDS_MOBILE_TOTP_DIAGNOSTIC:'1'},args:['dist/session/RegenerateSessions.js','--platform','mobile'],
    timeoutMs:7*60*1000
  });
  const log = fs.readFileSync(path.join(env.RUNNER_TEMP,'rewards-private','account-2.log'),'utf8');
  const result = JSON.parse(fs.readFileSync(env.REPORT_PATH,'utf8'));
  const ok = verified(log,env,result);
  console.log(ok ? 'Mobile login verified without earning activities.' : 'Mobile login not verified; redacted details remain private.');
  return ok ? 0 : 1;
}
module.exports={instrument,verified};
if(require.main===module) (async()=>{
  const e=process.env;
  if(e.RUN_MODE!=='diagnostic'||e.ACCOUNT_SLOT!=='2'||e.GITHUB_RUN_ATTEMPT!=='1'||!/^\d+$/.test(e.GITHUB_RUN_ID||'')||!e.BOT_DIR)
    throw Error('Invalid Mobile diagnostic context');
  if(process.argv[2]==='instrument') instrument(e.BOT_DIR);
  else if(process.argv[2]==='run') process.exitCode=await run(e);
  else throw Error('Unknown probe command');
})().catch(()=>{console.error('Mobile login diagnostic failed; details suppressed.');process.exitCode=1;});

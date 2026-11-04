'use strict';
const fs = require('node:fs');
const path = require('node:path');

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Expected exactly one probe insertion point');
  return source.replace(anchor, () => replacement);
}
function instrument(botDir, modulePath) {
  const search = path.join(botDir, 'src/rewards/shared/search');
  const ui = path.join(search, 'SearchQuotaUI.ts');
  const data = path.join(botDir, 'src/rewards/shared/data/AccountData.ts');
  const output = path.join(search, 'QuotaLayoutProbe.ts');
  if (fs.existsSync(output)) throw new Error('Probe module already exists');
  let rendered = fs.readFileSync(ui, 'utf8');
  rendered = "import { inspectQuotaPage, observeQuotaNetwork } from './QuotaLayoutProbe'\n" + rendered;
  rendered = replaceOnce(rendered, '    let task: BrowserTaskPage | undefined',
    '    let task: BrowserTaskPage | undefined\n    let finishNetwork: (() => Promise<void>) | undefined');
  rendered = replaceOnce(rendered, '        task = await BrowserTaskPage.create(source)',
    '        task = await BrowserTaskPage.create(source)\n        if (process.env.REWARDS_QUOTA_LAYOUT_OBSERVE === "1")\n            finishNetwork = observeQuotaNetwork(task.page, bot.isMobile)');
  rendered = replaceOnce(rendered, "            emitEvidence('SEARCH_UI_DIAGNOSTIC', {",
    "            if (process.env.REWARDS_QUOTA_LAYOUT_OBSERVE === '1')\n                await inspectQuotaPage(task.page, route, text, detailsClicked, bot.isMobile).catch(() => undefined)\n            emitEvidence('SEARCH_UI_DIAGNOSTIC', {");
  rendered = replaceOnce(rendered, '        await task?.close().catch(() => undefined)',
    '        await finishNetwork?.().catch(() => undefined)\n        await task?.close().catch(() => undefined)');
  let account = fs.readFileSync(data, 'utf8');
  account = "import { inspectPayload } from '../search/QuotaLayoutProbe'\n" + account;
  account = replaceOnce(account, "        if (inspectSearch)\n            emitEvidence('SEARCH_RESPONSE_SHAPE', {",
    "        if (inspectSearch && process.env.REWARDS_QUOTA_LAYOUT_OBSERVE === '1') emitEvidence('QUOTA_LAYOUT_API', {\n" +
    "            platform: this.bot.isMobile ? 'mobile' : 'desktop', via, status: response.status,\n" +
    "            source: url === URLs.rewards.userInfoApi ? 'rewards-api' : 'bing-flyout',\n" +
    "            shape: inspectPayload(response.data)\n        })\n\n" +
    "        if (inspectSearch)\n            emitEvidence('SEARCH_RESPONSE_SHAPE', {");
  fs.writeFileSync(output, fs.readFileSync(modulePath), {flag:'wx'});
  fs.writeFileSync(ui, rendered);
  fs.writeFileSync(data, account);
}
module.exports={instrument};
if (require.main === module) {
  if (process.env.RUN_MODE !== 'diagnostic' || process.env.ACCOUNT_SLOT !== '4' ||
      process.env.REWARDS_QUOTA_PROBE !== '1' || !process.env.BOT_DIR) throw new Error('Probe-only context required');
  instrument(process.env.BOT_DIR, path.join(__dirname, 'quota-layout-observation.ts'));
}

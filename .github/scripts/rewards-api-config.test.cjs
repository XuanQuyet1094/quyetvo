'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function configured(mode, {version = '5.0.0', readingComplete = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-api-config-'));
  try {
    const workers = Object.fromEntries([
      'doDailySet', 'doDailyCheckIn', 'doReadToEarn', 'doAppPromotions',
      'doMobileSearch', 'doDesktopSearch', 'doBonusSearches', 'doMorePromotions',
      'doPunchCards', 'doVisualSearch', 'doClaimBonusPoints'
    ].map(key => [key, true]));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({version}));
    fs.writeFileSync(path.join(dir, 'config.example.json'), JSON.stringify({
      workers, activities: {urlReward: true, searchOnBing: true},
      searchSettings: {parallelSearching: true, runOnZeroPoints: true},
      experimental: {apiSearch: true, apiSearchOnBing: true, edgeBrowsing: true},
      ensureStreakProtection: true, autoClaimPunchcardRewards: true,
      webhook: {telegram: {enabled: true}, discord: {enabled: true}}
    }));
    if (readingComplete) {
      fs.mkdirSync(path.join(dir, 'rewards-private'));
      fs.writeFileSync(path.join(dir, 'rewards-private', 'reading-budget.json'),
        JSON.stringify({date: '2026-11-02', accountId: 1, points: 0, verified: true}));
    }
    const run = spawnSync(process.execPath, [path.join(__dirname, 'rewards-runner.cjs'), 'configure'], {
      encoding: 'utf8', env: {...process.env, RUN_MODE: mode, RUN_DATE: '2026-11-02',
        ACCOUNT_SLOT: '1', BOT_DIR: dir, RUNNER_TEMP: dir}
    });
    assert.equal(run.status, 0, run.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), '');
    assert.equal(config.headless, true);
    assert.equal(config.clusters, 1);
    assert.deepEqual(config.accountDelay, {min: '100sec', max: '180sec'});
    assert.ok(Object.values(config.webhook).every(channel => channel.enabled === false));
    assert.equal(config.errorDiagnostics, false);
    assert.equal(config.debugLogs, false);
    return config;
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

for (const mode of ['morning', 'retry', 'reconcile']) {
  test(`v5 ${mode} selects API without broadening activity or privacy settings`, () => {
    const config = configured(mode);
    assert.equal(config.rewardsMode, 'api');
    assert.equal(config.workers.doVisualSearch, false);
    for (const key of ['doDailySet', 'doDailyCheckIn', 'doReadToEarn', 'doMobileSearch', 'doDesktopSearch'])
      assert.equal(config.workers[key], true);
    assert.equal(config.searchSettings.parallelSearching, false);
    assert.equal(config.searchSettings.runOnZeroPoints, false);
    assert.equal(config.experimental.apiSearch, undefined);
    assert.equal(config.experimental.apiSearchOnBing, undefined);
    assert.equal(config.experimental.browserSearchApiReport, false);
    assert.equal(config.experimental.edgeBrowsing, mode === 'morning');
    if (mode === 'reconcile') {
      assert.equal(config.workers.doClaimBonusPoints, false);
      assert.equal(config.workers.doMorePromotions, false);
      assert.equal(config.workers.doPunchCards, false);
      assert.equal(config.autoClaimPunchcardRewards, false);
      assert.equal(config.ensureStreakProtection, false);
    }
    assert.equal(configured(mode, {readingComplete: true}).workers.doReadToEarn, false);
  });
}

test('v5 isolated tests keep their activity boundaries in API mode', () => {
  for (const [mode, expected] of [
    ['test', ['doDailySet']], ['app-test', ['doDailyCheckIn']],
    ['app-read-test', ['doReadToEarn']], ['app-auth-probe', []]
  ]) {
    const config = configured(mode);
    assert.equal(config.rewardsMode, 'api');
    assert.deepEqual(Object.keys(config.workers).filter(key => config.workers[key]), expected);
    assert.equal(config.experimental.edgeBrowsing, false);
  }
});

test('legacy v4 configuration is not switched to an unsupported API mode', () => {
  for (const mode of ['morning', 'retry', 'reconcile', 'app-auth-probe']) {
    const config = configured(mode, {version: '4.0.0'});
    assert.equal(config.rewardsMode, undefined);
  }
});

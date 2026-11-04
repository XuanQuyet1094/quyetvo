'use strict';

const minute = 60000;
const BASE_MS = 35 * minute;
const MAX_MS = 60 * minute;
const NEXT_SLOT_RESERVE_MS = 43 * minute; // Baseline search, estimated setup and inter-account rest.
const REPORT_RESERVE_MS = 5 * minute;
const PROGRESS_FRESH_MS = 3 * minute;
const EXTENSION_STEP_MS = 5 * minute;
const platforms = ['mobile', 'desktop'];

function recordProgress(progress, previous, fresh, now) {
  for (const platform of platforms) {
    const before = previous[platform], after = fresh[platform];
    if (!after) continue;
    const oldPeak = progress[platform];
    if (oldPeak && oldPeak.max === after.max && after.earned <= oldPeak.earned) continue;
    const increased = before && before.max === after.max && after.earned > before.earned;
    progress[platform] = {max: after.max, earned: after.earned, at: increased ? now : null};
  }
}

function extraDelayMs({slot, remaining, started, now, evidence, progress}) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 6 || !Number.isFinite(remaining) ||
      !Number.isFinite(started) || !Number.isFinite(now) || now < started || evidence.limited) return 0;
  const hasProgress = platforms.some(platform => {
    const q = evidence[platform], last = progress[platform];
    return q && q.earned < q.max && last?.max === q.max && last.earned === q.earned &&
      Number.isFinite(last.at) && now >= last.at && now - last.at <= PROGRESS_FRESH_MS;
  });
  if (!hasProgress) return 0;
  const budget = Math.min(MAX_MS, remaining - (6 - slot) * NEXT_SLOT_RESERVE_MS - REPORT_RESERVE_MS);
  const extra = budget - (now - started);
  return extra >= minute ? Math.min(extra, EXTENSION_STEP_MS) : 0;
}

module.exports = {BASE_MS, recordProgress, extraDelayMs};

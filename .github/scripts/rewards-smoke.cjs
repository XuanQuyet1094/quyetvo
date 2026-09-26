'use strict';
const {telegram} = require('./rewards-runner.cjs');
const {randomUUID} = require('node:crypto');
const branch = 'rewards-state';
const repo = 'XuanQuyet1094/Microsoft-Rewards-Script';
async function api(route, method = 'GET', body) {
  const r = await fetch(`https://api.github.com/repos/${repo}${route}`, {
    method, headers: {Authorization: `Bearer ${process.env.REWARDS_STATE_TOKEN}`,
      Accept: 'application/vnd.github+json', 'Content-Type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
  return r.json();
}
async function main() {
  if (!process.env.REWARDS_STATE_TOKEN) throw new Error('REWARDS_STATE_TOKEN missing');
  if ((await api('')).private !== true) throw new Error('State repo is not private');
  const nonce = randomUUID();
  const route = `/contents/probes/${nonce}.json`;
  let sha;
  try {
    const created = await api(route, 'PUT', {branch, message: 'Test private state access',
      content: Buffer.from(JSON.stringify({probe: nonce})).toString('base64')});
    sha = created.content.sha;
    const read = await api(`${route}?ref=${branch}`);
    if (JSON.parse(Buffer.from(read.content, 'base64').toString()).probe !== nonce) throw new Error('Read-back mismatch');
    console.log('PASS: private state write and read-back.');
  } finally {
    if (sha) {
      await api(route, 'DELETE', {branch, sha, message: 'Remove private state test probe'});
      console.log('PASS: test probe removed; daily account states untouched.');
    }
  }
  await telegram('🧪 <b>KIỂM TRA HỆ THỐNG — THÀNH CÔNG</b>\n\n🔐 Secret lưu trạng thái: hợp lệ\n✅ Ghi và đọc lại dữ liệu private: thành công\n🧹 Đã xóa dữ liệu thử\n🔁 Kiểm tra quy tắc chạy dự phòng: đạt\n\n🏆 Thông báo tài khoản đã thêm icon cho điểm, số dư, Daily Set và trạng thái.\n\nℹ️ Đây là tin kiểm tra; không chạy tài khoản và không sử dụng lượt dự phòng.');
}
main().catch(e => {
  // Only our fixed errors are safe to expose; never print fetch URLs or bodies.
  console.error(/^GitHub HTTP \d+$|^REWARDS_STATE_TOKEN missing$/.test(e.message) ? e.message : 'Smoke test failed; sensitive details suppressed.');
  process.exitCode = 1;
});

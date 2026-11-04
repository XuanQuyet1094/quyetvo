'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {expiredWorkflowPaths, dateInVietnam} = require('./cleanup-dated-workflows.cjs');
const entry = path => ({path,type:'blob'});
test('Vietnam cutoff protects yesterday and today while removing older dated jobs', () => {
 const now = new Date('2026-11-04T12:01:00Z'); // 19:01 VN
 const tree = {tree: [
  '.github/workflows/morning-2026-11-02.yml',
  '.github/workflows/reconcile-2026-10-12.yml',
  '.github/workflows/login-resume-2026-11-03-account-2.yml',
  '.github/workflows/morning-all-2026-11-04.yml',
  '.github/workflows/run-rewards.yml',
  '.github/workflows/rewards-account.yml',
  '.github/scripts/morning-2026-10-12.yml',
  '.github/workflows/wrong-2026-13-40.yml',
 ].map(entry)};
 assert.deepEqual(expiredWorkflowPaths(tree,now),[
  '.github/workflows/morning-2026-11-02.yml',
  '.github/workflows/reconcile-2026-10-12.yml'
 ]);
});
test('date boundary & incomplete tree refusal',()=>{
 assert.equal(dateInVietnam(new Date('2026-11-04T17:01:00Z')),'2026-11-05');
 assert.throws(()=>expiredWorkflowPaths({truncated:true,tree:[]}),/Incomplete/);
 assert.throws(()=>expiredWorkflowPaths({tree:null}),/Incomplete/);
});

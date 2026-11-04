'use strict';

const dateInVietnam = now => new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
function expiredWorkflowPaths(tree, now = new Date()) {
  if (!Array.isArray(tree?.tree) || tree.truncated) throw new Error('Incomplete repository tree; refusing cleanup');
  // Protect yesterday and today's workflow files in Vietnam time.
  const today = dateInVietnam(now);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  return tree.tree.filter(entry => {
    if (entry.type !== 'blob') return false;
    const match = /^\.github\/workflows\/[a-z0-9][a-z0-9-]*-(\d{4}-\d{2}-\d{2})(?:-[a-z0-9-]+)?\.ya?ml$/.exec(entry.path);
    if (!match) return false;
    const date = match[1];
    const ms = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date && date < yesterday;
  }).map(entry => entry.path);
}

async function githubAPI(path, options = {}) {
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !/^[^/]+\/[^/]+$/.test(repo || '')) throw new Error('Missing GitHub execution context');
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? {'Content-Type': 'application/json'} : {})
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`GitHub operation failed: ${options.method || 'GET'} ${path} (HTTP ${response.status})`);
  return response.json();
}

async function cleanup() {
  if (process.env.GITHUB_REF_NAME !== 'main') throw new Error('Cleanup must run on main');
  const ref = await githubAPI('/git/ref/heads/main');
  const commit = await githubAPI(`/git/commits/${ref.object.sha}`);
  const tree = await githubAPI(`/git/trees/${commit.tree.sha}?recursive=1`);
  const paths = expiredWorkflowPaths(tree);
  if (paths.length === 0) {
    console.log('No expired dated workflow definitions.');
    return;
  }
  const newTree = await githubAPI('/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      base_tree: commit.tree.sha,
      tree: paths.map(path => ({path, mode: '100644', type: 'blob', sha: null}))
    })
  });
  const newCommit = await githubAPI('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: 'chore: expire dated Actions workflow definitions [skip ci]',
      parents: [ref.object.sha],
      tree: newTree.sha
    })
  });
  // A non-fast-forward update fails rather than overwriting another writer's branch.
  await githubAPI('/git/refs/heads/main', {
    method: 'PATCH',
    body: JSON.stringify({sha: newCommit.sha, force: false})
  });
  console.log(`Removed ${paths.length} expired date-specific workflow definitions.`);
}

module.exports = {expiredWorkflowPaths, dateInVietnam, cleanup};
if (require.main === module) {
  cleanup().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

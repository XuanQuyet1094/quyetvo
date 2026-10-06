'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const {spawn} = require('node:child_process');
const state = require('./rewards-state.cjs');
const decode = file => JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
const privateBranch = 'rewards-state';
const destination = () => createHash('sha256').update(String(process.env.TELEGRAM_CHAT_ID)).digest('hex');
function notificationRoute(key) {
  if (!/^(account-[1-6]|summary)$/.test(key)) throw new Error('Invalid notification key');
  const ctx = state.reportContext();
  return `/contents/notifications/${ctx.date}/run-${ctx.runId}-attempt-${ctx.attempt}/${key}.json`;
}
async function write(route, value, sha) {
  const result = await state.api(route, {method:'PUT',body:JSON.stringify({branch:privateBranch,sha,
    message:'Update private notification delivery', content:Buffer.from(JSON.stringify(value)).toString('base64')})});
  return result.content.sha;
}
async function enqueue(key, text) {
  if (typeof text !== 'string' || !text.length || text.length > 4096) throw new Error('Invalid notification');
  await state.requirePrivateReports();
  const route = notificationRoute(key);
  const old = await state.api(`${route}?ref=${privateBranch}`,{},true);
  if (!old) await write(route,{schema:1,text,status:'pending',attempts:0,destination:destination()});
}
async function deliverRoute(route, send) {
  const file = await state.api(`${route}?ref=${privateBranch}`,{},true);
  if (!file) return 'missing';
  const record = decode(file);
  if (record.schema !== 1 || record.destination !== destination() || typeof record.text !== 'string') throw new Error('Invalid saved notification');
  if (['sending','uncertain'].includes(record.status)) {
    console.warn('::warning::Saved notification has an uncertain outcome; verify Telegram before sending manually.');
    return record.status;
  }
  if (!['pending','failed'].includes(record.status) || record.attempts >= 3) return record.status;
  // A SHA conflict prevents concurrent senders from acquiring the same notification.
  const reserved = {...record,status:'sending',attempts:record.attempts+1,startedAt:new Date().toISOString()};
  const sha = await write(route,reserved,file.sha);
  try {
    await send(record.text);
  } catch (error) {
    const status = error?.definitelyNotDelivered === true ? 'failed' : 'uncertain';
    await write(route,{...reserved,status,finishedAt:new Date().toISOString()},sha);
    throw new Error(status === 'failed' ? 'Notification rejected; report-only retry is available' : 'Notification outcome uncertain; check Telegram before retrying');
  }
  // If this write fails after delivery, the reservation stays 'sending'; do not send twice.
  await write(route,{...reserved,status:'sent',finishedAt:new Date().toISOString()},sha);
  return 'sent';
}
async function deliver(key, send) {
  await state.requirePrivateReports();
  return deliverRoute(notificationRoute(key),send);
}
function required(name, env = process.env) {
  if (!String(env[name] || '').trim()) throw new Error(`Missing configuration: ${name}`);
}
async function preflight() {
  for (const name of ['ACCOUNT_EMAIL','REWARDS_PRIVATE_REPO','REWARDS_STATE_TOKEN','PRIVATE_REPO_TOKEN',
    'TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','AZDIGI_SSH_HOST','AZDIGI_SSH_USER','AZDIGI_SSH_PORT','AZDIGI_SSH_KEY','AZDIGI_KNOWN_HOSTS']) required(name);
  if (!process.env.ACCOUNT_PASSWORD && !process.env.ACCOUNT_TOTP_SECRET) throw new Error('Missing account authentication credentials');
  if (process.env.ACCOUNT_TOTP_SECRET && !/^[A-Z2-7]+=*$/.test(process.env.ACCOUNT_TOTP_SECRET.replace(/\s/g,'').toUpperCase())) throw new Error('Invalid TOTP setup key');
  const port = Number(process.env.AZDIGI_SSH_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port');
  await state.requirePrivateReports();
  const ctx = state.reportContext();
  const probe = `/contents/probes/preflight-${ctx.runId}-${ctx.attempt}-${randomUUID()}.json`;
  const written = await state.api(probe,{method:'PUT',body:JSON.stringify({branch:privateBranch,message:'Check private report write access',content:Buffer.from('{"probe":true}').toString('base64')})});
  await state.api(probe,{method:'DELETE',body:JSON.stringify({branch:privateBranch,sha:written.content.sha,message:'Remove report preflight probe'})});
  const source = await fetch(`https://api.github.com/repos/${process.env.REWARDS_PRIVATE_REPO}`,{headers:{Authorization:`Bearer ${process.env.PRIVATE_REPO_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20000)});
  if (!source.ok || (await source.json()).private !== true) throw new Error('Private source checkout access unavailable');
  for (const method of ['getMe','getChat']) {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(method === 'getChat' ? {chat_id:process.env.TELEGRAM_CHAT_ID} : {}),signal:AbortSignal.timeout(20000)});
    if (!response.ok || (await response.json()).ok !== true) throw new Error('Telegram configuration check failed');
  }
  console.log('Preflight passed; private storage, source and Telegram access verified.');
}
function expiredLogPaths(tree, now = new Date(), keepDays = 3) {
  if (tree.truncated) throw new Error('Incomplete private tree; cleanup refused');
  const vnToday = new Date(now.getTime()+7*3600000).toISOString().slice(0,10);
  const cutoff = new Date(Date.parse(vnToday+'T00:00:00Z')-(keepDays-1)*86400000).toISOString().slice(0,10);
  return tree.tree.filter(entry => {
    const match = /^(logs|diagnostics|setup-logs)\/(\d{4}-\d{2}-\d{2})\/.+\.log$/.exec(entry.path);
    return entry.type === 'blob' && match && match[2] < cutoff;
  }).map(entry=>entry.path);
}
async function cleanup() {
  await state.requirePrivateReports();
  const ref = await state.api(`/git/ref/heads/${privateBranch}`);
  const commit = await state.api(`/git/commits/${ref.object.sha}`);
  const tree = await state.api(`/git/trees/${commit.tree.sha}?recursive=1`);
  const expired = expiredLogPaths(tree);
  if (!expired.length) { console.log('Private log retention checked; no expired logs.'); return; }
  const updatedTree = await state.api('/git/trees',{method:'POST',body:JSON.stringify({base_tree:commit.tree.sha,
    tree:expired.map(p=>({path:p,mode:'100644',type:'blob',sha:null}))})});
  const updatedCommit = await state.api('/git/commits',{method:'POST',body:JSON.stringify({message:'Expire private logs after three Vietnam calendar days',tree:updatedTree.sha,parents:[ref.object.sha]})});
  await state.api(`/git/refs/heads/${privateBranch}`,{method:'PATCH',body:JSON.stringify({sha:updatedCommit.sha,force:false})});
  console.log(`Private retention completed: ${expired.length} expired log files removed from current branch.`);
}
async function resendPending(send) {
  await state.requirePrivateReports();
  const tree = await state.api(`/git/trees/${privateBranch}?recursive=1`);
  if (tree.truncated) throw new Error('Incomplete notification tree');
  const today = new Date(Date.now()+7*3600000).toISOString().slice(0,10);
  const cutoff = new Date(Date.parse(today+'T00:00:00Z')-2*86400000).toISOString().slice(0,10);
  let failed = false;
  for (const entry of tree.tree) {
    const match = /^notifications\/(\d{4}-\d{2}-\d{2})\/run-\d+-attempt-\d+\/(account-[1-6]|summary)\.json$/.exec(entry.path);
    if (entry.type !== 'blob' || !match || match[1] < cutoff || match[1] > today) continue;
    try { await deliverRoute('/contents/'+entry.path,send); }
    catch { failed = true; console.error('A private notification could not be delivered; bot was not run.'); }
  }
  if (failed) throw new Error('Report-only delivery needs attention');
  console.log('Report-only recovery completed; no earning tasks were launched.');
}
async function quietBuild(env = process.env, commands) {
  const id = Number(env.ACCOUNT_SLOT);
  if (![1,2,3,4,5,6].includes(id) || !env.RUNNER_TEMP || !env.BOT_DIR) throw new Error('Invalid build context');
  const folder = path.join(env.RUNNER_TEMP,'rewards-private');
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const file = path.join(folder,`setup-account-${id}.log`);
  fs.writeFileSync(file,'',{mode:0o600});
  const redact = require('./rewards-runner.cjs').redactLog;
  let bytes = 0;
  for (const [label, command, args] of commands || [
    ['Dependencies','npm',['ci','--include=dev']],
    ['Browser','npx',['--no-install','patchright','install','--with-deps','chromium']],
    ['Build','npm',['run','build']],
    ...(['app-test','app-auth-probe'].includes(env.RUN_MODE) ? [['App verification tests','node',['--test','scripts/main/appAuth.test.cjs']]] : []),
    ...(env.RUN_MODE === 'diagnostic' ? [['Authentication tests','npm',['run','test:auth']]] : [])
  ]) {
    const child = spawn(command,args,{cwd:env.BOT_DIR,env,stdio:['ignore','pipe','pipe']});
    for (const stream of [child.stdout,child.stderr]) {
      require('node:readline').createInterface({input:stream}).on('line',line=>{
        const safe = redact(line,env)+'\n';
        if (bytes + Buffer.byteLength(safe) <= 900*1024) {fs.appendFileSync(file,safe);bytes+=Buffer.byteLength(safe);}
      });
    }
    const code = await new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('close',resolve);});
    if (code !== 0) {console.error(`${label}: failed; detailed setup log remains private.`);throw new Error('Private setup failed');}
    console.log(`${label}: passed.`);
  }
  if (!commands && !fs.existsSync(path.join(env.BOT_DIR,'dist/index.js'))) throw new Error('Build output unavailable');
}
module.exports = {preflight,enqueue,deliver,deliverRoute,cleanup,expiredLogPaths,resendPending,quietBuild};
if (require.main === module) {
  const command = process.argv[2];
  const operation = {preflight,cleanup,build:quietBuild}[command];
  if (!operation) process.exitCode=1;
  else operation().catch(()=>{console.error('Automation operation failed; sensitive details suppressed.');process.exitCode=1;});
}

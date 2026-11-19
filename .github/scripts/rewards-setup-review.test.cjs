'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const review = require('./rewards-setup-review.cjs');
const {eligible, retryable, claim, finish} = require('./rewards-state.cjs');
const ctx = {date:'2026-11-19', slot:1, mode:'retry'};
const entry = {status:'failed', errorCode:'SETUP_FAILED', retryable:false, runId:'42', runAttempt:'1',
  startedAt:'2026-11-18T19:22:56Z', finishedAt:'2026-11-18T19:33:12Z'};
const job = {id:99, run_id:42, conclusion:'failure', steps:[
  {name:'Start verified AZDIGI SOCKS5 tunnel', conclusion:'failure'},
  {name:'Run selected activities within the configured time limit', conclusion:'skipped'}]};
const log = ['2026-11-18T19:22:45.870Z ##[group] Inputs',
  '2026-11-18T19:22:45.871Z   account: 1',
  '2026-11-18T19:22:45.872Z   run_mode: morning',
  '2026-11-18T19:22:45.873Z   run_date: 2026-11-19',
  '2026-11-18T19:22:45.874Z ##[endgroup]',
  '2026-11-18T19:33:09.061Z ssh: connect to host *** port ***: Connection timed out'].join('\n');
const env = {GITHUB_TOKEN:'fixture-token', GITHUB_REPOSITORY:'example/automation'};
const state = () => ({schema:1, date:ctx.date, accountId:1, morning:structuredClone(entry)});
const fetchEvidence = async url => url.endsWith('/logs') ? {ok:true, text:async()=>log} :
  {ok:true, json:async()=>({total_count:1, jobs:[job]})};

test('only a real SSH connection timeout is transient; auth, host-key, DNS and unknown setup failures are not',()=>{
  assert.equal(review.sshTimeout('ssh: connect to host secret.invalid port 2222: Connection timed out\n'), true);
  for (const text of ['Connection timed out', 'curl: (28) Connection timed out',
    'ssh: connect to host x port 22: Connection refused', 'Permission denied (publickey).',
    'Host key verification failed.', log,
    'ssh: connect to host x port 22: Connection timed out\nPermission denied (publickey).'])
    assert.equal(review.sshTimeout(text),false,text);
  assert.equal(retryable({status:'failed',errorCode:'SETUP_FAILED'}),false);
});
test('legacy evidence must match account, date, mode, original attempt, terminal step and no bot execution',()=>{
  assert.equal(review.confirmedSshTimeout(entry,job,log,ctx,'morning'),true);
  for(const [e,j,l,c] of [
    [{...entry,status:'running'},job,log,ctx], [{...entry,errorCode:'AUTH_REQUIRED'},job,log,ctx],
    [{...entry,logPath:'logs/existing-bot.log'},job,log,ctx],
    [entry,{...job,run_id:43},log,ctx], [entry,{...job,conclusion:'cancelled'},log,ctx],
    [entry,{...job,steps:[job.steps[0],{...job.steps[1],conclusion:'success'}]},log,ctx],
    [entry,{...job,steps:[...job.steps,{name:'Build',conclusion:'failure'}]},log,ctx],
    [entry,job,log.replace('account: 1','account: 2'),ctx],
    [entry,job,log.replace('run_mode: morning','run_mode: retry'),ctx],
    [entry,job,log.replace('run_date: 2026-11-19','run_date: 2026-11-18'),ctx],
    [entry,job,log.replace('19:33:09.061','20:33:09.061'),ctx],
    [entry,job,log.replace('Z ssh:','Z echo ssh:'),ctx],
    [entry,job,log,{...ctx,date:'2026-11-20'}], [entry,job,'',ctx]
  ]) assert.equal(review.confirmedSshTimeout(e,j,l,c,'morning'),false);
});
test('read-only correction allows one new daily retry without rewriting or reopening earlier claims',async()=>{
  const s=state(), original=JSON.stringify(s), calls=[];
  const view=await review.selectionView(s,ctx,async(url,options)=>{
    calls.push({url,options});return fetchEvidence(url);
  },env);
  assert.equal(view.morning.errorCode,'NETWORK_TIMEOUT');assert.equal(view.morning.setupNotStarted,true);
  assert.equal(eligible(view,ctx.date,1),true);assert.equal(JSON.stringify(s),original);
  assert.ok(calls[0].url.includes('/runs/42/attempts/1/jobs?per_page=100'));
  assert.ok(calls.every(c=>!c.options.method));
  for(const status of ['running','completed','failed','cancelled'])
    assert.equal(eligible({...view,retry:{status}},ctx.date,1),false);
  assert.equal(eligible({...view,test:{status:'failed',errorCode:'TOTP_REJECTED'}},ctx.date,1),false);
  for(const mode of ['morning','diagnostic'])
    assert.equal(await review.selectionView(s,{...ctx,mode},()=>{throw Error('must not fetch');},env),s);
  assert.equal(await review.selectionView({...s,retry:{status:'failed'}},ctx,()=>{throw Error('must not fetch');},env).then(v=>v.morning.errorCode),'SETUP_FAILED');
});
test('missing Actions access, missing logs, incomplete pagination and contradictory evidence fail closed',async()=>{
  const s=state();
  assert.equal(await review.selectionView(s,ctx,fetchEvidence,{}),s);
  for(const fetchFn of [async()=>({ok:false}),async()=>{throw Error('private failure');},
    async()=>({ok:true,json:async()=>({total_count:101,jobs:[job]})}),
    async url=>url.endsWith('/logs')?{ok:false}:fetchEvidence(url),
    async url=>url.endsWith('/logs')?{ok:true,text:async()=>log.replace('account: 1','account: 4')}:fetchEvidence(url)])
    assert.equal(await review.selectionView(s,ctx,fetchFn,env),s);
});
test('SSH failure receipt keeps logs private and distinguishes timeout from bad SSH credentials', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-receipt-')), lines=[];
  t.mock.method(console,'error',line=>lines.push(line));
  try {
    const e={ACCOUNT_SLOT:'1',RUN_DATE:ctx.date,RUNNER_TEMP:dir,REPORT_PATH:path.join(dir,'result.json'),
      AZDIGI_SSH_HOST:'private.example.invalid',AZDIGI_SSH_PORT:'2222',AZDIGI_SSH_USER:'private-user',PRIVATE_REPO_TOKEN:'fixture-sensitive-token'};
    const source=path.join(dir,'stderr');
    fs.writeFileSync(source,'ssh: connect to host private.example.invalid port 2222: Connection timed out\nfixture-sensitive-token');
    review.recordSshFailure(source,e);
    let receipt=JSON.parse(fs.readFileSync(e.REPORT_PATH));
    assert.equal(receipt.errorCode,'NETWORK_TIMEOUT');assert.equal(receipt.readingPoints,0);
    assert.equal(receipt.pointsEarned,null);assert.equal(retryable(receipt),true);
    const saved=fs.readFileSync(path.join(dir,'rewards-private/setup-account-1.log'),'utf8');
    for(const secret of ['private.example.invalid','2222','fixture-sensitive-token']) {
      assert.ok(!saved.includes(secret));assert.ok(!lines.join('\n').includes(secret));
    }
    assert.throws(()=>review.recordSshFailure(source,e),/EEXIST/);
    e.REPORT_PATH=path.join(dir,'auth-result.json');fs.writeFileSync(source,'Permission denied (publickey).');
    review.recordSshFailure(source,e);receipt=JSON.parse(fs.readFileSync(e.REPORT_PATH));
    assert.equal(receipt.errorCode,'SETUP_FAILED');assert.equal(retryable(receipt),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('legacy SSH recovery preserves original state, unused reading credit and a single SHA-leased retry claim',async t=>{
  t.mock.method(Date,'now',()=>Date.parse('2026-11-19T05:40:00Z'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-claim-')), prev={...process.env}, oldFetch=global.fetch;
  let s=state(),puts=0;
  try {
    Object.assign(process.env,{...env,RUN_DATE:ctx.date,ACCOUNT_SLOT:'1',RUN_MODE:'retry',
      REWARDS_PRIVATE_REPO:'example/private-state',REWARDS_STATE_TOKEN:'fixture',RUNNER_TEMP:dir,
      GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:path.join(dir,'output')});
    global.fetch=async(url,options={})=>{
      if(url.includes('/example/automation/actions/')) return fetchEvidence(url);
      let body;
      if(options.method==='PUT'){s=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));puts++;body={};}
      else if(url.endsWith('/example/private-state')) body={private:true};
      else if(url.includes('/branches/')) body={name:'rewards-state'};
      else if(url.includes('/state/')) body={sha:'fixture',content:Buffer.from(JSON.stringify(s)).toString('base64')};
      else return {ok:false,status:404};
      return {ok:true,status:200,json:async()=>body};
    };
    await claim();assert.equal(puts,1);assert.deepEqual(s.morning,entry);
    assert.equal(s.retry.status,'running');assert.equal(s.retry.readingPointsBudget,30);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'rewards-private/reading-budget.json'))).points,30);
    await claim();assert.equal(puts,1);
    s.retry.status='failed';await claim();assert.equal(puts,1);
    s.retry.status='completed';await claim();assert.equal(puts,1);
  } finally {
    global.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in prev))delete process.env[key];
    Object.assign(process.env,prev);fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('SSH timeout receipt is persisted as retryable while cancellation never becomes a timeout retry',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-finish-')), prev={...process.env},oldFetch=global.fetch;
  let s={...state(),retry:{status:'running',runId:'100',runAttempt:'1'}}, puts=0;
  t.mock.method(console,'error',()=>{});
  try {
    Object.assign(process.env,{RUN_DATE:ctx.date,ACCOUNT_SLOT:'1',RUN_MODE:'retry',STATE_STORED:'true',JOB_STATUS:'failure',
      REWARDS_PRIVATE_REPO:'example/private-state',REWARDS_STATE_TOKEN:'fixture',RUNNER_TEMP:dir,
      GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',REPORT_PATH:path.join(dir,'result.json')});
    const source=path.join(dir,'stderr');fs.writeFileSync(source,'ssh: connect to host example.invalid port 22: Connection timed out');
    review.recordSshFailure(source);
    global.fetch=async(url,options={})=>{
      let body;
      if(options.method==='PUT'){if(url.includes('/state/')){s=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));puts++;}body={};}
      else if(url.endsWith('/example/private-state'))body={private:true};
      else if(url.includes('/branches/'))body={name:'rewards-state'};
      else if(url.includes('/state/'))body={sha:'fixture',content:Buffer.from(JSON.stringify(s)).toString('base64')};
      else return {ok:false,status:404};
      return {ok:true,status:200,json:async()=>body};
    };
    await finish();assert.equal(puts,1);assert.equal(s.retry.errorCode,'NETWORK_TIMEOUT');assert.equal(s.retry.retryable,true);
    assert.deepEqual(s.morning,entry);assert.equal(eligible(s,ctx.date,1),false);
    fs.unlinkSync(process.env.REPORT_PATH);process.env.JOB_STATUS='cancelled';
    await finish();assert.equal(s.retry.errorCode,'CANCELLED');assert.equal(s.retry.retryable,false);
  } finally {global.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in prev))delete process.env[key];Object.assign(process.env,prev);fs.rmSync(dir,{recursive:true,force:true});}
});
test('workflow SSH wrapper preserves exit status, hides raw SSH errors and records only failures',()=>{
  const workflow=fs.readFileSync(path.join(__dirname,'../workflows/rewards-account.yml'),'utf8');
  const block=/          umask 077\n([\s\S]+?)          for url in/.exec(workflow);
  assert.ok(block);
  const script=block[1].replace(/^          /gm,'').replace(
    'node automation/.github/scripts/rewards-setup-review.cjs',
    'node '+JSON.stringify(path.join(__dirname,'rewards-setup-review.cjs')));
  assert.equal(spawnSync('bash',['-n'],{input:script}).status,0);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-workflow-'));
  try {
    const e={...process.env,ACCOUNT_SLOT:'1',RUN_DATE:ctx.date,RUNNER_TEMP:dir,REPORT_PATH:path.join(dir,'result.json'),
      AZDIGI_SSH_HOST:'synthetic.private.invalid',AZDIGI_SSH_USER:'fixture-user',AZDIGI_SSH_PORT:'2222'};
    const result=spawnSync('bash',['-e','-o','pipefail'],{env:e,encoding:'utf8',input:
      "ssh() { printf '%s\\n' 'ssh: connect to host synthetic.private.invalid port 2222: Connection timed out' >&2; return 255; }\n"+script});
    assert.equal(result.status,255);assert.ok(!result.stderr.includes('synthetic.private.invalid'));
    assert.equal(JSON.parse(fs.readFileSync(e.REPORT_PATH)).errorCode,'NETWORK_TIMEOUT');
    assert.equal(fs.existsSync(path.join(dir,'azdigi-ssh-error.log')),false);
    e.REPORT_PATH=path.join(dir,'success.json');
    const success=spawnSync('bash',['-e','-o','pipefail'],{env:e,encoding:'utf8',input:'ssh() { return 0; }\n'+script});
    assert.equal(success.status,0);assert.equal(fs.existsSync(e.REPORT_PATH),false);
    assert.equal(fs.existsSync(path.join(dir,'azdigi-ssh-error.log')),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('reusable worker inherits existing caller read permissions without breaking isolated test workflows',()=>{
  const dir=path.join(__dirname,'../workflows');
  const worker=fs.readFileSync(path.join(dir,'rewards-account.yml'),'utf8');
  assert.ok(!/^permissions:/m.test(worker));
  assert.match(worker,/GITHUB_TOKEN: \$\{\{ github.token \}\}/);
  for(const file of fs.readdirSync(dir)) {
    const source=fs.readFileSync(path.join(dir,file),'utf8');
    if(!source.includes('uses: ./.github/workflows/rewards-account.yml'))continue;
    assert.match(source,/permissions:\n  contents: read/,file);
    assert.ok(!/  (?:contents|actions): write/.test(source),file);
  }
  const main=fs.readFileSync(path.join(dir,'run-rewards.yml'),'utf8');
  assert.match(main,/actions: read/);assert.match(main,/group: rewards-accounts-1-6/);
  assert.match(main,/cancel-in-progress: false/);
  assert.match(worker,/ref:.*inputs.source_ref/);
  assert.match(fs.readFileSync(path.join(__dirname,'rewards-runner.cjs'),'utf8'),/min: '100sec', max: '180sec'/);
});

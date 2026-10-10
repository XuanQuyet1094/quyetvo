'use strict';
const targets = {mobile:60, desktop:90};
const platforms = Object.keys(targets);
const modes = ['morning','retry','reconcile','test','app-test','app-read-test'];
const points = (value, platform) => Number.isSafeInteger(value) && value >= 0 && value <= 10000 ? value : null;
function runPoints(value) {
  return Object.fromEntries(platforms.map(p => [p, points(value?.[p], p)]));
}
function progress(value) {
  return Object.fromEntries(platforms.map(p => [p, {
    points:points(value?.[p]?.points,p) ?? 0, target:targets[p],
    verified:value?.[p]?.verified === true && points(value?.[p]?.points,p) !== null
  }]));
}
function add(previous, credited) {
  const result=progress(previous), current=runPoints(credited);
  for(const p of platforms) {
    if(current[p] === null) result[p].verified=false;
    else result[p].points=Math.min(10000,result[p].points+current[p]);
  }
  return result;
}
function complete(value,p) { return progress(value)[p].points >= targets[p]; }
function needsReview(value,tasks={}) { return platforms.some(p=>tasks[p+'Search']!=='complete'); }
function applyTasks(tasks,value) {
  const result={...tasks};
  if(value) for(const p of platforms) {
    const key=p+'Search';
    // A partial receipt total is a lower bound, not proof of outstanding Microsoft quota.
    if(!['complete','missing'].includes(result[key])) result[key]='unknown';
  }
  return result;
}
function lines(value,tasks={}) {
  if(!value) return [];
  const ledger=progress(value);
  return platforms.map(p=>{
    const x=ledger[p];
    const label=p==='mobile'?'📱 <b>Mobile search:</b>':'🖥️ <b>Desktop search:</b>';
    return label+' '+(x.verified?'Đã ghi nhận ':'Ít nhất ')+x.points+' điểm · '+
      (tasks[p+'Search']==='complete'?'✅ Microsoft xác nhận hết quota':
        '❔ Chưa xác minh hoàn tất quota');
  });
}
function legacyRunEvidence(log) {
  const result={mobile:0,desktop:0},seen={mobile:false,desktop:false},uncertain={mobile:false,desktop:false};
  for(const line of String(log).split('\n')) {
    const match=/\b(MOBILE|DESKTOP) \[SEARCH-BING\] (.*)/.exec(line);
    if(!match) continue;
    const p=match[1].toLowerCase(),body=match[2];
    if(/Starting Bing searches|Completed Bing searches|no points \d+\//.test(body)) seen[p]=true;
    const gain=/^pointsGained=(\d+) \|/.exec(body);
    if(gain) {
      seen[p]=true;
      const n=Number(gain[1]);
      // Large delayed rewards are not search receipts. Do not count stage totals.
      if(n>0 && n<=3) result[p]=Math.min(10000,result[p]+n);
      else uncertain[p]=true;
    }
  }
  return Object.fromEntries(platforms.map(p=>[p,{points:result[p],verified:seen[p]&&!uncertain[p]}]));
}
function legacyRunPoints(log) {
  const evidence=legacyRunEvidence(log);
  return Object.fromEntries(platforms.map(p=>[p,evidence[p].verified?evidence[p].points:null]));
}
async function review(state,ctx,readReport,readLog) {
  let result={mobile:{points:0,verified:true},desktop:{points:0,verified:true}};
  const seen=new Set();
  for(const mode of modes) {
    const current=state[mode];
    for(const entry of [...(current?.history||[]),...(current?[current]:[])]) {
      if(!entry.finishedAt || !/^\d+$/.test(entry.runId||'') || !/^\d+$/.test(entry.runAttempt||'')) continue;
      const key=entry.runId+'/'+entry.runAttempt;
      if(seen.has(key))continue;
      seen.add(key);
      const report=await readReport(entry);
      if(!report || report.date!==ctx.date || report.accountId!==ctx.slot) {result=add(result,null);continue;}
      let credited=report.searchPoints;
      if(!credited && ['morning','retry','reconcile'].includes(mode)) {
        const log=await readLog(entry);
        const evidence=legacyRunEvidence(log);
        // An ambiguous bonus does not invalidate the smaller query receipts already observed.
        credited=Object.fromEntries(platforms.map(p=>[p,evidence[p].points]));
        for(const p of platforms) if(!evidence[p].verified) result[p].verified=false;
      } else if(!credited) credited={mobile:0,desktop:0};
      result=add(result,credited);
    }
  }
  return progress(result);
}
module.exports={targets,platforms,runPoints,progress,add,complete,needsReview,applyTasks,lines,legacyRunEvidence,legacyRunPoints,review};

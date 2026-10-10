'use strict';
const keys = ['dailySet','appCheckIn','readToEarn','mobileSearch','desktopSearch'];
function tasks(value) {
  return Object.fromEntries(keys.map(key => [key, ['complete','missing','unknown'].includes(value?.[key]) ? value[key] : 'unknown']));
}
function merge(previous, next) {
  const current=tasks(next), old=tasks(previous);
  // Same-day confirmed completion survives a later unavailable read.
  for(const key of keys) if(current[key]==='unknown' && old[key]==='complete') current[key]='complete';
  return current;
}
const labels={complete:'✅ Hoàn thành',missing:'⚠️ Còn thiếu',unknown:'❔ Chưa xác minh'};
const workerKeys={dailySet:'doDailySet',appCheckIn:'doDailyCheckIn',readToEarn:'doReadToEarn',mobileSearch:'doMobileSearch',desktopSearch:'doDesktopSearch'};
function required(mode,cfg) {
 const scoped={test:['dailySet'],'app-test':['appCheckIn'],'app-read-test':['readToEarn'],diagnostic:[],'app-auth-probe':[]};
 if(Object.hasOwn(scoped,mode))return scoped[mode];
 if(['morning','retry','reconcile'].includes(mode))return [...keys];
 return cfg?.workers ? keys.filter(k=>cfg.workers[workerKeys[k]]===true) : [...keys];
}
function completion(value,requested=keys) {
 const t=tasks(value),wanted=Array.isArray(requested)?[...new Set(requested.filter(k=>keys.includes(k)))]:keys;
 const missing=wanted.filter(k=>t[k]==='missing'),unknown=wanted.filter(k=>t[k]==='unknown');
 return {status:!wanted.length?'not_requested':missing.length?'incomplete':unknown.length?'unverified':'verified',required:wanted,missing,unknown};
}
const completionLabels={verified:'✅ Đã xác minh hoàn tất',incomplete:'⚠️ Còn nhiệm vụ chưa hoàn tất',unverified:'❔ Chưa đủ dữ liệu xác minh',not_requested:'Không yêu cầu nhiệm vụ kiếm điểm'};
function review(value,points,requested=keys) {
 const c=completion(value,requested);
 return {pointsWarning:!Number.isSafeInteger(points)||points<220,needsTaskReview:['incomplete','unverified'].includes(c.status),completion:c};
}
function lines(value,search,evidence,compact=false) {
  const t=tasks(value);
  return [
    '🔥 <b>Daily Set:</b> '+labels[t.dailySet],
    '📱 <b>App check-in:</b> '+labels[t.appCheckIn],
    '📰 <b>Read to Earn:</b> '+labels[t.readToEarn],
    ...(evidence ? require('./rewards-search-evidence.cjs').lines(evidence,search,compact) : search ? require('./rewards-search-ledger.cjs').lines(search,t) :
      ['🔎 <b>Tìm kiếm:</b> Điện thoại '+labels[t.mobileSearch]+' · Máy tính '+labels[t.desktopSearch]])
  ];
}
module.exports={keys,tasks,merge,lines,required,completion,completionLabels,review};

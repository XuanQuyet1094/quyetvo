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
function lines(value,search) {
  const t=tasks(value);
  return [
    '🔥 <b>Daily Set:</b> '+labels[t.dailySet],
    '📱 <b>App check-in:</b> '+labels[t.appCheckIn],
    '📰 <b>Read to Earn:</b> '+labels[t.readToEarn],
    ...(search ? require('./rewards-search-ledger.cjs').lines(search,t) :
      ['🔎 <b>Tìm kiếm:</b> Điện thoại '+labels[t.mobileSearch]+' · Máy tính '+labels[t.desktopSearch]])
  ];
}
module.exports={keys,tasks,merge,lines};


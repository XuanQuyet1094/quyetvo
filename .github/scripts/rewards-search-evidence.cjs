'use strict';
const metric = v => Number.isSafeInteger(v) && v >= 0 && v <= 100000 ? v : null;
function quota(v) {
  return metric(v?.earned) !== null && metric(v?.max) !== null && v.max > 0 && v.max <= 10000 &&
    v.earned <= v.max && ['api','ui'].includes(v.source) ? {earned:v.earned,max:v.max,source:v.source} : null;
}
function normalize(v) {
  return {mobile:quota(v?.mobile),desktop:quota(v?.desktop),shared:quota(v?.shared),
    pending:Object.fromEntries(['total','mobile','desktop','shared'].map(p=>[p,metric(v?.pending?.[p])])),
    pendingBefore:Object.fromEntries(['total','mobile','desktop','shared'].map(p=>[p,metric(v?.pendingBefore?.[p])])),
    limited:v?.limited===true,claimReceived:metric(v?.claimReceived)};
}
function applyTasks(tasks,value) {
  const out={...tasks},e=normalize(value);
  for(const p of ['mobile','desktop']) {
    const q=e[p] || e.shared;
    if(q) out[p+'Search']=q.earned>=q.max?'complete':'missing';
  }
  return out;
}
function lines(value,receipts,compact=false) {
  const e=normalize(value),out=[];
  if(compact) {
    for(const p of ['mobile','desktop']) {
      const q=e[p]||e.shared,n=metric(receipts?.[p]?.points);
      out.push((p==='mobile'?'📱 Mobile':'🖥️ Desktop')+': '+(n===null?'điểm chưa rõ':(receipts?.[p]?.verified===false?'≥':'')+n+' điểm quan sát')+
        (q?' · '+(e.shared?'quota chung ':'quota ')+q.earned+'/'+q.max+' '+(q.earned===q.max?'✅':'⚠️'):' · quota ❔'));
    }
    if(e.pending.total!==null) out.push('🎁 Chờ nhận (tổng): '+e.pending.total+' điểm');
    if(e.claimReceived!==null) out.push('📥 Claim: +'+e.claimReceived+' điểm · chưa phân bổ search');
    if(e.limited) out.push('⏳ Search đang bị giới hạn');
    return out;
  }
  if(e.shared) out.push('🔎 <b>Quota search chung:</b> '+e.shared.earned+'/'+e.shared.max+' điểm · '+(e.shared.earned>=e.shared.max?'✅ Hoàn thành':'⚠️ Còn '+(e.shared.max-e.shared.earned)+' điểm'));
  for(const p of ['mobile','desktop']) {
    const q=e[p],recorded=metric(receipts?.[p]?.points),label=p==='mobile'?'📱 <b>Mobile search:</b>':'🖥️ <b>Desktop search:</b>';
    out.push(label+' '+(recorded===null?'Điểm ghi nhận chưa rõ':(receipts?.[p]?.verified===false?'Ít nhất ':'Đã ghi nhận ')+recorded+' điểm')+
      (q?' · Microsoft: '+q.earned+'/'+q.max+' · '+(q.earned>=q.max?'✅ Hoàn thành':'⚠️ Còn '+(q.max-q.earned)+' điểm'):
        e.shared?' · Dùng quota chung':' · ❔ Chưa xác minh quota'));
  }
  if(e.pending.total!==null) out.push('🎁 <b>Điểm chờ nhận:</b> '+e.pending.total+' điểm (tất cả hoạt động)');
  for(const p of ['mobile','desktop','shared']) if(e.pending[p]!==null)
    out.push('🎁 <b>Search chờ nhận ('+p+'):</b> '+e.pending[p]+' điểm');
  if(e.pendingBefore.total!==null) out.push('🎁 <b>Trước claim:</b> '+e.pendingBefore.total+' điểm chờ nhận (tất cả hoạt động)');
  if(e.claimReceived!==null) out.push('📥 <b>Claim trong lượt:</b> +'+e.claimReceived+' điểm · chưa phân bổ cho mobile/desktop');
  if(e.limited) out.push('⏳ Microsoft đang giới hạn search; đã dừng lượt tìm kiếm.');
  if(!e.mobile || !e.desktop) out.push('ℹ️ Điểm search ghi nhận là phần tăng số dư quan sát được; quota lấy từ Microsoft, không mặc định 60/90.');
  return out;
}
module.exports={metric,quota,normalize,applyTasks,lines};

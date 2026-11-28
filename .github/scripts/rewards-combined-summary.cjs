'use strict';
function combinedSummary(jobs,env,summaryMessage,accountMessage) {
  const base=summaryMessage(jobs,env);
  const marker=base.indexOf('\n<b>1.');
  const header=marker<0?base:base.slice(0,marker);
  const period={morning:'sáng',retry:'trưa · dự phòng',reconcile:'tối · chạy bù'}[env.RUN_MODE]||env.RUN_MODE||'chưa xác định';
  const clock=new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
  const parts=[header,'👥 <b>'+ (env.REWARDS_GROUP_LABEL==='group2'?'NHÓM 2 · voquyet':'NHÓM 1 · quyetvo')+'</b>','🕒 <b>Lượt '+period+'</b> · '+clock+' · Giờ Việt Nam'];
  for(let id=1;id<=6;id++){
    let r;
    try{r=JSON.parse(jobs['account_'+id]?.outputs?.result||'null');}catch{}
    if(!r){parts.push('<b>Báo cáo tài khoản '+id+'/6</b>\nKhông chạy hoặc chưa có kết quả của lượt này.');continue;}
    let detail=accountMessage(r,env['ACCOUNT_'+id+'_EMAIL']);
    if(!detail.includes('Keep earning:')) detail+='\n🎯 <b>Keep earning:</b> ❔ Chưa xác minh';
    detail+='\n🔥 <b>Visual Search:</b> ❔ Chưa có dữ liệu xác minh riêng';
    parts.push(detail.split('\n').slice(1).join('\n'));
  }
  return parts.join('\n\n');
}
module.exports={combinedSummary};

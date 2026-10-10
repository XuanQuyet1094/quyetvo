'use strict';
const stages=['login','daily_set','mobile_search','desktop_search','read_to_earn','quota_api','quota_ui','claim'];
const labels={login:'Đăng nhập',daily_set:'Daily Set',mobile_search:'Mobile',desktop_search:'Desktop',read_to_earn:'Đọc báo',quota_api:'Quota API',quota_ui:'Quota UI',claim:'Claim'};
const valid=n=>Number.isSafeInteger(n)&&n>=0&&n<=86400000;
function normalize(rows) {
 return (Array.isArray(rows)?rows:[]).filter(x=>stages.includes(x?.stage)&&valid(x.durationMs)&&Number.isSafeInteger(x.calls)&&x.calls>0&&x.calls<=10000)
  .slice(0,stages.length).map(x=>({stage:x.stage,durationMs:x.durationMs,calls:x.calls,failed:Number.isSafeInteger(x.failed)&&x.failed>=0?Math.min(x.failed,x.calls):0,interrupted:x.interrupted===true}));
}
function collector(now=Date.now) {
 const active=new Map(),done=new Set(),totals=new Map();
 function add(stage,durationMs,status,interrupted=false) {
  const old=totals.get(stage)||{stage,durationMs:0,calls:0,failed:0,interrupted:false};
  old.durationMs=Math.min(86400000,old.durationMs+durationMs);old.calls++;old.failed+=status==='failed'?1:0;old.interrupted||=interrupted;totals.set(stage,old);
 }
 return {
  accept(e){
   if(!stages.includes(e?.stage)||!Number.isSafeInteger(e.id)||e.id<1||e.id>10000||done.has(e.id)) return;
   if(e.phase==='start'&&!active.has(e.id)&&active.size<32) active.set(e.id,{stage:e.stage,at:now()});
   else if(e.phase==='end'&&active.get(e.id)?.stage===e.stage&&valid(e.durationMs)&&['ok','failed'].includes(e.status)) {
    active.delete(e.id);done.add(e.id);add(e.stage,e.durationMs,e.status);
   }
  },
  snapshot(){const result=new Map([...totals].map(([k,v])=>[k,{...v}]));
   for(const a of active.values()) {const row=result.get(a.stage)||{stage:a.stage,durationMs:0,calls:0,failed:0,interrupted:false};row.durationMs=Math.min(86400000,row.durationMs+Math.max(0,Math.round(now()-a.at)));row.calls++;row.interrupted=true;result.set(a.stage,row);}
   return normalize([...result.values()]);}
 };
}
function lines(rows) {
 const safe=normalize(rows);if(!safe.length)return [];
 const primary=safe.filter(x=>!['quota_api','quota_ui'].includes(x.stage));
 const text=primary.map(x=>labels[x.stage]+': '+(x.durationMs/60000).toFixed(1)+'p'+(x.interrupted?' (dở dang)':'')).join(' · ');
 const quota=safe.filter(x=>['quota_api','quota_ui'].includes(x.stage)).map(x=>labels[x.stage]+': '+(x.durationMs/1000).toFixed(1)+'s / '+x.calls+' lượt đọc').join(' · ');
 return [...(text?['⏱️ <b>Từng bước:</b> '+text]:[]),...(quota?['📋 '+quota+' (nằm trong thời gian các bước)']:[])];
}
module.exports={stages,normalize,collector,lines};

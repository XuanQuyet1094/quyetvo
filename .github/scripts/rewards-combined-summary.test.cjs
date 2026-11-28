'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {combinedSummary}=require('./rewards-combined-summary.cjs');
const {summaryMessage,accountMessage,telegram}=require('./rewards-runner.cjs');
test('combined session report retains six account blocks, unknown results and escaped identity',()=>{
 const jobs={account_1:{outputs:{result:JSON.stringify({accountId:1,date:'2026-11-28',status:'completed',pointsEarned:80,initialBalance:0,finalBalance:80,tasks:{dailySet:'complete'}})}}};
 const text=combinedSummary(jobs,{RUN_MODE:'retry',RUN_DATE:'2026-11-28',ACCOUNT_1_EMAIL:'a<b@example.com'},summaryMessage,accountMessage);
 assert.ok(text.includes('a&lt;b@example.com'));
 assert.ok(text.includes('80'));
 assert.ok(text.includes('trưa'));
 for(let id=1;id<=6;id++)assert.ok(text.includes('Báo cáo tài khoản '+id+'/6'));
 assert.equal((text.match(/Không chạy hoặc chưa có kết quả của lượt này/g)||[]).length,5);
});
test('short and oversized reports each make only one Telegram request with full content',async()=>{
 for(const size of [100,6000]){
  const calls=[],text='x'.repeat(size);
  await telegram(text,{TELEGRAM_BOT_TOKEN:'test',TELEGRAM_CHAT_ID:'test'},async(url,options)=>{
   calls.push(url);
   if(size>4096){assert.ok(url.endsWith('/sendDocument'));assert.equal(await options.body.get('document').text(),text);}
   else {assert.ok(url.endsWith('/sendMessage'));assert.equal(JSON.parse(options.body).text,text);}
   return {ok:true,json:async()=>({ok:true})};
  });
  assert.equal(calls.length,1);
 }
});

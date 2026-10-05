'use strict';
function notificationFor(target){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(target.month_key)||!/^[0-9a-f-]{36}$/i.test(target.store_id))throw Error('Invalid reminder target');
  return {title:'매니 · '+Number(target.month_key.slice(5))+'월 보고서 비용 확인',body:target.name+' 사장님, 빠진 비용이 없는지 확인해 주세요. 이미 입력한 지출은 다시 입력하지 않아도 돼요.',url:'/?view=monthly-costs&store='+encodeURIComponent(target.store_id)+'&month='+target.month_key,tag:'monthly-cost-'+target.store_id+'-'+target.month_key};
}
async function sendClaimedReminders(db,webpush){
  const claim=await db.rpc('manee_claim_cost_reminders');if(claim.error)throw Error('Unable to claim cost reminders');
  let sent=0,failed=0,expired=0;
  // Bounded batches finish within the scheduled-function time budget.
  const targets=claim.data||[];
  for(let start=0;start<targets.length;start+=10){
    await Promise.all(targets.slice(start,start+10).map(async target=>{
      let status='sent';
      try{await webpush.sendNotification({endpoint:target.endpoint,keys:{p256dh:target.p256dh,auth:target.auth}},JSON.stringify(notificationFor(target)),{TTL:86400,timeout:5000});sent++;}
      catch(e){status=[404,410].includes(e.statusCode)?'expired':'failed';status==='expired'?expired++:failed++;}
      const result=await db.rpc('manee_finish_cost_reminder',{p_store_id:target.store_id,p_month_key:target.month_key,p_subscription_id:target.subscription_id,p_send_date:target.send_date,p_status:status});
      if(result.error)throw Error('Unable to record reminder result');
    }));
  }
  return {sent,failed,expired};
}
module.exports={notificationFor,sendClaimedReminders};

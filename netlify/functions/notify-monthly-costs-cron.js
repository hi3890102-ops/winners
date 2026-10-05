// Scheduled only; Netlify does not expose a URL for scheduled functions.
// 10:00 KST. The database selects D-7, D-3, month end, and owner-requested snoozes.
const {blockExternalService}=require('./lib/manee-environment.cjs');
const {createClient}=require('@supabase/supabase-js');
const webpush=require('web-push');
const {sendClaimedReminders}=require('./lib/monthly-cost-reminders.cjs');
exports.handler=async()=>{
  const blocked=blockExternalService();if(blocked)return blocked;
  try{
    const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
    webpush.setVapidDetails('mailto:admin@example.com',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
    return {statusCode:200,body:JSON.stringify(await sendClaimedReminders(db,webpush))};
  }catch(e){return {statusCode:500,body:JSON.stringify({error:'monthly_cost_reminder_failed'})};}
};

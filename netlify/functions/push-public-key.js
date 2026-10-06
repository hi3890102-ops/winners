const {blockExternalService}=require('./lib/manee-environment.cjs');
const {getVapidDetails}=require('./lib/push-vapid.cjs');

exports.handler=async(event)=>{
  const blocked=blockExternalService();if(blocked)return blocked;
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
  if(event.httpMethod!=='GET')return {statusCode:405,headers,body:JSON.stringify({error:'method_not_allowed'})};
  try{
    const {publicKey}=getVapidDetails();
    // The browser needs only the public application-server key.
    return {statusCode:200,headers,body:JSON.stringify({publicKey})};
  }catch{return {statusCode:503,headers,body:JSON.stringify({error:'push_key_unavailable'})};}
};

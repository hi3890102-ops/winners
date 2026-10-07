window.MANEE_CONFIG={environment:'production',projectRef:'aaaaaaaaaaaaaaaaaaaa',supabaseUrl:'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',publishableKey:'sb_publishable_fixture_only'};
window.__mock={calls:[],tables:{},delay:0,fail:null,rpcResults:{},session:{user:{id:'qa-user'},access_token:'fixture-not-a-real-token'}};
window.supabase={createClient(){
 const mock=window.__mock;
 function query(table){
  const filters=[];let action='select',payload,single=false;
  const q=new Proxy({}, {get(_,name){
   if(name==='then')return (resolve,reject)=>new Promise(done=>setTimeout(()=>{
    mock.calls.push({table,action,payload,filters});
    if(mock.fail===table||mock.fail==='all')return done({data:null,error:{message:'연결이 불안정해요. 다시 시도해 주세요.'}});
    if(mock.zero===table)return done({data:null,error:null});
    let data=structuredClone(mock.tables[table]||[]);
    for(const [kind,key,value] of filters){if(kind==='eq')data=data.filter(r=>r[key]===value);if(kind==='in')data=data.filter(r=>value.includes(r[key]));if(kind==='gte')data=data.filter(r=>r[key]>=value);if(kind==='lte')data=data.filter(r=>r[key]<=value);}
    if(action==='insert'||action==='upsert')data=(Array.isArray(payload)?payload:[payload]).map((p,i)=>({id:'qa-new-'+i,...p}));
    if(action==='update')data=data.map(r=>({...r,...payload}));
    done({data:single?(data[0]||null):data,error:null});
   },mock.delay)).then(resolve,reject);
   if(name==='single'||name==='maybeSingle')return ()=>{single=true;return q;};
   if(['insert','upsert','update','delete'].includes(name))return p=>{action=name;payload=p;return q;};
   return (...args)=>{if(['eq','in','gte','lte'].includes(name))filters.push([name,...args]);return q;};
  }});return q;
 }
 return {from:query,rpc:async(name,args)=>{mock.calls.push({rpc:name,args});await new Promise(r=>setTimeout(r,mock.delay));return mock.fail===name||mock.fail==='all'?{data:null,error:{message:'연결이 불안정해요. 다시 시도해 주세요.'}}:{data:mock.rpcResults[name]??(name==='manee_cost_review'?{checks:[],templates:[],review:{}}:null),error:null};},
 auth:{onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}};},getSession:async()=>({data:{session:mock.session}}),setSession:async()=>({data:{session:mock.session}}),signOut:async()=>({error:null})},
 storage:{from:()=>({getPublicUrl:()=>({data:{publicUrl:''}})})}};
}};
window.fetch=async(url,options)=>{window.__mock.calls.push({fetch:String(url),body:options?.body});return {ok:false,status:503,json:async()=>({error:'가상 검사: 원격 요청 차단'}),text:async()=>''};};

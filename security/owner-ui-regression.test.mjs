import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Script,createContext} from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const hashes=JSON.parse(readFileSync(new URL('fixtures/owner-preserved-functions.json',import.meta.url),'utf8'));
for(const [name,hash] of Object.entries(hashes))test('Preserve original business contract: '+name,()=>{
  const pattern=new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?(?=^  (?:async )?function |^  // |^  [a-zA-Z].*=|$$(?![\\s\\S]))','m');
  const body=html.match(pattern)?.[0];assert.ok(body,name);
  assert.equal(createHash('sha256').update(body).digest('hex'),hash);
});
function fn(name){const start=html.indexOf('  function '+name+'(');const asyncStart=html.indexOf('  async function '+name+'(');const a=start>=0?start:asyncStart;assert.ok(a>=0);const b=html.indexOf('\n  }',a)+4;return html.slice(a,b);}
test('Owner navigation classifies payroll under employees and notices/reservations under operations',()=>{
  const state={section:'sales',salesSectionTab:'pay'};const c=createContext({state});new Script(fn('ownerRouteGroup')).runInContext(c);
  assert.equal(c.ownerRouteGroup(),'people');state.salesSectionTab='expenses';assert.equal(c.ownerRouteGroup(),'sales');
  for(const section of ['checklist','announce','reservations']){state.section=section;assert.equal(c.ownerRouteGroup(),'operations');}
});
test('Approval refresh cannot put one store employee list into a different store',async()=>{
  let resolveRows;const state={role:'storeOwner',store:'A'};const c=createContext({state,currentStoreId:()=>state.store,loadCrewRaw:()=>new Promise(r=>{resolveRows=r}),showToast(){},render(){throw new Error('Must not render stale store');},setTimeout(){}});
  new Script(fn('openApprovedEmployee')).runInContext(c);const waiting=c.openApprovedEmployee('new','A');state.store='B';resolveRows([{id:'new'}]);await waiting;assert.equal(state.crew,undefined);
});
test('Saving new employee conditions requires a salary; existing records never receive new-cohort fields',async()=>{
  async function run(cohort,amount){const calls=[];const c={id:'id',name:'Original',phone:'original-phone',position:'홀',wage:0,selfServiceProfile:cohort,employmentSetupRequired:cohort};
    const state={crew:[c]},inputs={editname:{value:'Edited'},editposition:{value:'주방'},editwage:{value:String(amount)},editphone:{value:'edited-phone'}};
    const context=createContext({state,app:{querySelector:selector=>inputs[Object.keys(inputs).find(k=>selector.includes(k))]},render(){},showToast:message=>calls.push({toast:message}),updateCrewRow:async(id,patch)=>{calls.push({patch});return true;}});
    new Script(fn('saveCrewInfo')).runInContext(context);await context.saveCrewInfo('id');return {calls,c};
  }
  assert.equal((await run(true,0)).calls.some(x=>x.patch),false);
  const fresh=await run(true,13000),patch=fresh.calls.find(x=>x.patch).patch;assert.equal(patch.employment_setup_required,false);assert.equal(Object.hasOwn(patch,'name'),false);assert.equal(Object.hasOwn(patch,'phone'),false);
  const old=(await run(false,13000)).calls.find(x=>x.patch).patch;assert.equal(old.name,'Edited');assert.equal(Object.hasOwn(old,'employment_setup_required'),false);
});
test('A failed new-employee condition save does not clear its setup-required state',async()=>{
  const crew={id:'id',name:'Name',phone:'',position:'홀',wage:0,employmentSetupRequired:true};const state={crew:[crew]};
  const c=createContext({state,app:{querySelector:s=>s.includes('editwage')?{value:'13000'}:null},render(){},showToast(){},updateCrewRow:async()=>false});
  new Script(fn('saveCrewInfo')).runInContext(c);await c.saveCrewInfo('id');assert.equal(crew.wage,0);assert.equal(crew.employmentSetupRequired,true);
});

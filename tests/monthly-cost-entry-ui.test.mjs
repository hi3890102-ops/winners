import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('  function monthlyCostItems(');
const end=html.indexOf('  let monthlyCostRouteHandled=',start);
assert.ok(start>=0&&end>start);
const utilities=['electricity','water','gas'];
function setup(){
  const data={checks:[{key:'electricity',status:'skipped'}],templates:[{id:'template-internet',name:'인터넷',mode:'variable',start_month:'2026-09'}]};
  const state={monthYear:2026,monthNum:9,costEditKey:null,costLinkKey:null,expenseEntries:[],fixedExpenses:[]};
  const calls=[],controls={},adds=[...utilities,'template-internet'].map(key=>({dataset:{costAdd:key}}));
  const links=utilities.map(key=>({dataset:{costLink:key}}));
  let output='',request=0;
  const byId=id=>{
    if(!output.includes('id="'+id+'"'))return null;
    return controls[id]??=(id==='cost-entry'?{scrollIntoView:options=>calls.push({scroll:id,options})}:
      id==='cost-entry-title'?{focus:options=>calls.push({focus:id,options})}:{value:'',checked:false});
  };
  const ctx=vm.createContext({
    state,console,Date,Object,Number,JSON,
    currentCostReview:()=>data,monthKey:()=>'2026-09',currentStoreId:()=>'store-a',
    ownerDateKeyKst:()=>'2026-10-06',pad:n=>String(n).padStart(2,'0'),daysInMonth:()=>30,
    escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    canManageBusinessData:()=>true,crypto:{randomUUID:()=>`request-${++request}`},
    app:{querySelectorAll:s=>s==='[data-cost-add]'?adds:s==='[data-cost-link]'?links:[]},
    document:{getElementById:byId},
    showToast:message=>calls.push({toast:message}),
    render(){output=ctx.renderMonthlyCostReview();ctx.bindMonthlyCostEvents();},
  });
  vm.runInContext(html.slice(start,end),ctx);
  ctx.saveMonthlyCost=(action,payload)=>calls.push({action,payload});
  ctx.render();
  return {ctx,state,calls,adds,links,byId,get output(){return output;}};
}

test('one tap reveals the editor inside the selected cost item and moves it into view',()=>{
  const a=setup();
  for(const button of a.adds){
    a.calls.length=0;
    button.onclick();
    assert.equal(a.state.costEditKey,button.dataset.costAdd);
    const section=a.output.match(/<section class="cost-item">[\s\S]*?<\/section>/g)
      .find(s=>s.includes('data-cost-add="'+button.dataset.costAdd+'"'));
    assert.ok(section.includes('id="cost-amount"'),'editor must be next to the pressed item, not below all other costs');
    assert.match(section,/aria-expanded="true"/);
    assert.equal((a.output.match(/id="cost-amount"/g)||[]).length,1);
    assert.deepEqual(a.calls.map(x=>x.focus||x.scroll),['cost-entry-title','cost-entry']);
    assert.equal(a.calls[1].options.block,'start');
    assert.match(section,/id="cost-date"[^>]*value="2026-09-30"/);
  }
});

test('extra costs, existing-expense links and cancel switch without leaving duplicate editors',()=>{
  const a=setup();a.adds[0].onclick();
  a.state.costAddRequest={id:'old-attempt'};
  a.byId('cost-add-extra').onclick();
  assert.equal(a.state.costEditKey,'');assert.equal(a.state.costAddRequest,null);
  assert.ok(a.output.indexOf('id="cost-add-extra"')<a.output.indexOf('id="cost-entry"'));
  assert.match(a.output,/id="cost-name"[^>]*value=""/);
  assert.equal((a.output.match(/id="cost-amount"/g)||[]).length,1);
  a.byId('cost-add-cancel').onclick();assert.doesNotMatch(a.output,/id="cost-amount"/);
  a.adds[1].onclick();a.links[1].onclick();
  assert.equal(a.state.costEditKey,null);assert.doesNotMatch(a.output,/id="cost-amount"/);
  assert.match(a.output,/id="cost-existing"/);
  a.adds[2].onclick();assert.equal(a.state.costLinkKey,null);assert.doesNotMatch(a.output,/id="cost-existing"/);
});

test('entry buttons keep validation, cost association and retry-safe save payloads',()=>{
  const a=setup();a.adds[1].onclick();
  const values={'cost-date':'2026-09-30','cost-name':'수도요금','cost-memo':'9월 사용분','cost-amount':'0','cost-category':'utilities','cost-recurrence-mode':'variable'};
  for(const [id,value] of Object.entries(values))a.byId(id).value=value;
  a.byId('cost-recurring').checked=true;
  a.byId('cost-add-save').onclick();assert.equal(a.calls.filter(x=>x.action).length,0);
  a.byId('cost-amount').value='35000';
  a.ctx.bindMonthlyCostEvents();a.ctx.bindMonthlyCostEvents();
  a.byId('cost-add-save').onclick();a.byId('cost-add-save').onclick();
  const saves=a.calls.filter(x=>x.action);
  assert.equal(saves.length,2);assert.equal(saves[0].action,'add');
  assert.deepEqual(JSON.parse(JSON.stringify(saves[0].payload)),{key:'water',date:'2026-09-30',name:'수도요금',memo:'9월 사용분',amount:35000,category:'utilities',recurrence:'variable',request_id:'request-1'});
  assert.equal(saves[1].payload.request_id,saves[0].payload.request_id);
});

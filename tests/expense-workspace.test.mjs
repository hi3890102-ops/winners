import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fn(name){const re=new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?^  }','m');const m=html.match(re);assert.ok(m,name);return m[0];}
function context(extra={}){const c={state:{},EXPENSE_CATEGORIES:[{value:'food',label:'식자재'}],render(){},showToast(){},...extra};vm.createContext(c);return c;}
const rows=[{id:'1',date:'2026-09-24',description:'A',amount:100},{id:'2',date:'2026-09-18',description:'A',amount:80},{id:'3',date:'2026-09-24',description:'B',amount:50}];
test('vendor totals and daily totals derive from the same rows after edits',()=>{
 const c=context();vm.runInContext(fn('expenseViewGroups'),c);
 assert.deepEqual(Array.from(c.expenseViewGroups(rows,'vendor'),x=>[x.key,x.total,x.entries.length]),[['A',180,2],['B',50,1]]);
 assert.deepEqual(Array.from(c.expenseViewGroups(rows,'date'),x=>[x.key,x.total]),[['2026-09-24',150],['2026-09-18',80]]);
 const edited=rows.map(x=>x.id==='1'?{...x,description:'B',date:'2026-09-18',amount:120}:x);
 assert.deepEqual(Array.from(c.expenseViewGroups(edited,'vendor'),x=>[x.key,x.total]),[['B',170],['A',80]]);
 assert.deepEqual(Array.from(c.expenseViewGroups(edited,'date'),x=>[x.key,x.total]),[['2026-09-24',50],['2026-09-18',200]]);
 assert.equal(c.expenseViewGroups([], 'date').length,0);
 assert.equal(c.expenseViewGroups([{...rows[0],description:'__proto__'}],'vendor')[0].total,100);
});
test('expense input rejects invalid dates, blank/negative/fractional/overflow amounts and invalid category',()=>{
 const c=context();vm.runInContext(fn('expenseEditValid'),c);const good={date:'2026-09-24',description:'A',amount:'100',category:'food',memo:''};
 assert.equal(c.expenseEditValid(good),'');
 for(const change of [{date:'2026-02-30'},{date:''},{amount:''},{amount:'-1'},{amount:'1.5'},{amount:'Infinity'},{amount:'2147483648'},{category:'unknown'},{memo:'a'.repeat(1001)}])assert.ok(c.expenseEditValid({...good,...change}));
});
function saveContext(){
 const entry={...rows[0],category:null,memo:''},state={expenseEntries:[entry],editingExpenseEntryId:'1',expenseEditDraft:{date:'2026-10-02',description:'B',amount:'120',category:'food',memo:'배송'},ownerWork:{loadedOnce:true}};
 const calls=[],toasts=[];let respond,live=true;const query={update(p){calls.push(['update',p]);return this;},eq(...a){calls.push(['eq',...a]);return this;},select(){return new Promise(resolve=>respond=resolve);}};
 const c=context({state,MANEE_STAFF_AUTH_ENABLED:true,canManageBusinessData:()=>true,currentStoreId:()=> 'storeA',monthKey:()=> '2026-09',vendorMutationGuard:()=>()=>live,db:{from:()=>query},checkedBusinessMutation:async q=>{const r=await q;if(r.error)throw r.error;if(r.data.length!==1)throw Error('not saved');return r.data[0];},showToast:m=>toasts.push(m),businessError:e=>toasts.push(e.message),notifyOwnerOfExpenseChange(){}});
 vm.runInContext(fn('expenseEditValid')+'\n'+fn('saveExpenseEntry'),c);
 return {c,state,entry,calls,toasts,finish:r=>respond(r),stale:()=>live=false};
}
test('save is store scoped, blocks duplicate submissions and moves an edited date out of the old month',async()=>{
 const x=saveContext(),p=x.c.saveExpenseEntry('1');await x.c.saveExpenseEntry('1');assert.equal(x.calls.filter(x=>x[0]==='update').length,1);assert.ok(x.calls.some(x=>x[0]==='eq'&&x[1]==='store_id'&&x[2]==='storeA'));
 x.finish({data:[{id:'1',date:'2026-10-02',description:'B',amount:120,category:'food',memo:'배송'}]});await p;
 assert.equal(x.state.expenseEntries.length,0);assert.equal(x.state.expenseEditDraft,null);assert.equal(x.state.dashboardData,null);assert.equal(x.state.ownerWork.loadedOnce,false);assert.equal(x.state.expenseSaving,false);
});
test('failed or zero-row saves retain data and entered draft for retry',async()=>{
 for(const reply of [{error:Error('network'),data:[]},{data:[]}]){const x=saveContext(),p=x.c.saveExpenseEntry('1');x.finish(reply);await p;assert.equal(x.entry.amount,100);assert.equal(x.state.expenseEditDraft.amount,'120');assert.equal(x.state.expenseSaving,false);assert.ok(x.toasts.length);}
});
test('a late response after changing context never mutates the next store UI',async()=>{
 const x=saveContext(),p=x.c.saveExpenseEntry('1');x.stale();x.finish({data:[{id:'1',date:'2026-09-24',description:'B',amount:120}]});await p;assert.equal(x.entry.amount,100);assert.equal(x.state.expenseEntries.length,1);
});
test('users without update permission cannot start or submit an expense edit',async()=>{
 const x=saveContext();x.c.canManageBusinessData=()=>false;vm.runInContext(fn('startEditExpenseEntry'),x.c);await x.c.saveExpenseEntry('1');assert.equal(x.calls.length,0);x.state.expenseEditDraft=null;x.c.startEditExpenseEntry('1');assert.equal(x.state.expenseEditDraft,null);
});
test('memo migration is additive and preserves preexisting amounts and descriptions',async()=>{
 const db=new PGlite();await db.exec("create table expense_entries(id integer,date date,description text,amount integer); insert into expense_entries values(1,'2026-09-24','A',100);");
 const sql=fs.readFileSync(new URL('../supabase/migrations/20260926071849_expense_entry_memo.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
 const r=await db.query('select description,amount,memo from expense_entries');assert.deepEqual(r.rows,[{description:'A',amount:100,memo:null}]);await db.close();
});

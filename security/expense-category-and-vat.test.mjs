import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// Covers the 2026-09-22 monthly-report redesign: expense category split (식자재/주류·음료/소모품/기타, NOT a tax
// classification), the extended food-ratio verdict (adds "pending" when unclassified expense remains), and the
// VAT (부가세) simple-estimate math. See renderMonthlyReport / renderVatDetail in index.html for the UI that
// consumes these. Net-profit formula and calcCrewPay/calcCrewPayFrom are untouched by this change (not retested here).
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fnText(name){const a=html.indexOf('  function '+name+'(');const b=html.indexOf('  async function '+name+'(');const s=a>=0?a:b;if(s<0)throw new Error('missing '+name);const e=html.indexOf('\n  }\n',s);return html.slice(s,e+5);}
function line(re){const m=html.match(re);if(!m)throw new Error('missing '+re);return m[0];}
function constBlock(name){const a=html.indexOf('  const '+name);if(a<0)throw new Error('missing const '+name);const e=html.indexOf(';\n',a);return html.slice(a,e+2);}
const plain=v=>JSON.parse(JSON.stringify(v)); // vm-context objects aren't reference-equal to this realm's Object.prototype

function harness(){
  const state={storeFoodLimitMap:{}};
  const ctx=vm.createContext({state,console});
  vm.runInContext([
    constBlock('EXPENSE_CATEGORIES'),
    constBlock('FOOD_RATIO_CATEGORY_SET'),
    fnText('expenseCategoryLabel'),
    fnText('splitExpenseByCategory'),
    constBlock('DEFAULT_LABOR_RATIO_LIMIT'),
    fnText('foodRatioLimit'),
    fnText('foodRatioVerdict'),
    fnText('vatOutputEstimate'),
    fnText('vatPeriodMeta'),
    fnText('vatDefaultPeriod'),
    ';this.api={expenseCategoryLabel,splitExpenseByCategory,foodRatioVerdict,vatOutputEstimate,vatPeriodMeta,vatDefaultPeriod,setLimit:(s,v)=>{state.storeFoodLimitMap[s]=v;}};'
  ].join('\n'),ctx);
  return {state,api:ctx.api};
}

test('EXPENSE_CATEGORIES: exactly the four operating-cost buckets, no tax wording',()=>{
  assert.match(html,/const EXPENSE_CATEGORIES = \[/);
  assert.match(html,/value:"food", label:"식자재"/);
  assert.match(html,/value:"beverage", label:"주류·음료"/);
  assert.match(html,/value:"supplies", label:"소모품"/);
  assert.match(html,/value:"other", label:"기타"/);
});

test('splitExpenseByCategory: food = food+beverage only; unclassified = null-category only; supplies/other count in total but neither bucket; total is unaffected by classification',()=>{
  const r=harness();
  const entries=[
    {amount:1800000,category:'food'},
    {amount:700000,category:'beverage'},
    {amount:200000,category:'supplies'},
    {amount:50000,category:'other'},
    {amount:300000,category:null},
    {amount:'not-a-number',category:'food'}, // NaN-safe
  ];
  const s=r.api.splitExpenseByCategory(entries);
  assert.equal(s.food,2500000);
  assert.equal(s.unclassified,300000);
  assert.equal(s.total,1800000+700000+200000+50000+300000);
});
test('splitExpenseByCategory: empty/missing input never throws',()=>{
  const r=harness();
  assert.deepEqual(plain(r.api.splitExpenseByCategory([])),{total:0,food:0,unclassified:0});
  assert.deepEqual(plain(r.api.splitExpenseByCategory(undefined)),{total:0,food:0,unclassified:0});
});

test('foodRatioVerdict: null ratio -> none; unreadable limit -> unknown regardless of ratio',()=>{
  const r=harness();
  assert.equal(r.api.foodRatioVerdict('A',null,false).state,'none');
  r.api.setLimit('A',false); // unreadable
  assert.equal(r.api.foodRatioVerdict('A',10,false).state,'unknown');
});
test('foodRatioVerdict: strictly over the limit is "over" even with unclassified expense present (can only go higher once classified)',()=>{
  const r=harness(); r.api.setLimit('A',35);
  assert.equal(r.api.foodRatioVerdict('A',35.1,true).state,'over');
  assert.equal(r.api.foodRatioVerdict('A',35.1,false).state,'over');
});
test('foodRatioVerdict: exactly at the limit is NOT over',()=>{
  const r=harness(); r.api.setLimit('A',35);
  assert.equal(r.api.foodRatioVerdict('A',35,false).state,'ok');
});
test('foodRatioVerdict: at/under the limit but some expense is unclassified -> "pending", never "ok" (안정 는 아님)',()=>{
  const r=harness(); r.api.setLimit('A',35);
  assert.equal(r.api.foodRatioVerdict('A',20,true).state,'pending');
  assert.equal(r.api.foodRatioVerdict('A',35,true).state,'pending');
});
test('foodRatioVerdict: at/under the limit and fully classified -> "ok"',()=>{
  const r=harness(); r.api.setLimit('A',35);
  assert.equal(r.api.foodRatioVerdict('A',20,false).state,'ok');
  assert.equal(r.api.foodRatioVerdict('A',20,undefined).state,'ok');
});

test('vatOutputEstimate: sales/11 rounded to the nearest won; zero and negative handled without throwing',()=>{
  const r=harness();
  assert.equal(r.api.vatOutputEstimate(33000000),3000000);
  assert.equal(r.api.vatOutputEstimate(0),0);
  assert.equal(r.api.vatOutputEstimate(null),0);
  assert.equal(r.api.vatOutputEstimate(-1100000),Math.round(-1100000/11));
  assert.equal(r.api.vatOutputEstimate(10),1); // round(10/11)=round(0.909)=1
});

test('vatPeriodMeta: quarter and half boundaries',()=>{
  const r=harness();
  assert.deepEqual(plain(r.api.vatPeriodMeta('quarter',1,2026)),{size:3,start:1,end:3,name:'1분기',title:'2026년 1분기 · 1~3월'});
  assert.deepEqual(plain(r.api.vatPeriodMeta('quarter',3,2026)),{size:3,start:7,end:9,name:'3분기',title:'2026년 3분기 · 7~9월'});
  assert.deepEqual(plain(r.api.vatPeriodMeta('half',1,2026)),{size:6,start:1,end:6,name:'상반기',title:'2026년 상반기 · 1~6월'});
  assert.deepEqual(plain(r.api.vatPeriodMeta('half',2,2026)),{size:6,start:7,end:12,name:'하반기',title:'2026년 하반기 · 7~12월'});
});
test('vatDefaultPeriod: month -> quarter/half, including boundaries',()=>{
  const r=harness();
  assert.equal(r.api.vatDefaultPeriod('quarter',1),1); assert.equal(r.api.vatDefaultPeriod('quarter',3),1);
  assert.equal(r.api.vatDefaultPeriod('quarter',4),2); assert.equal(r.api.vatDefaultPeriod('quarter',9),3);
  assert.equal(r.api.vatDefaultPeriod('quarter',12),4);
  assert.equal(r.api.vatDefaultPeriod('half',6),1); assert.equal(r.api.vatDefaultPeriod('half',7),2);
});

test('VAT screen never treats expense category as a tax classification (design guard, read from source)',()=>{
  assert.match(html,/NOT a tax classification -\n\s*\/\/ it must never be used to decide what's VAT-deductible/);
  assert.match(html,/입력 자료 기준 단순 예상액으로 실제 신고·납부액과 다를 수 있어요/);
  assert.match(html,/기납부세액 차감 전/);
});

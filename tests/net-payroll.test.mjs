import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=name=>html.match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))[0];
const context=vm.createContext({});vm.runInContext(fn('payrollAdjustmentSnapshot')+'\n'+fn('settleNetPayroll'),context);
const crew={id:'c1',wageType:'monthly',wage:3000000,hireDate:'2026-01-01'},base={pay:3000000,hours:160,days:30};
const settle=(adjustments=[],record=null,c=crew,b=base,today='2026-10-31')=>context.settleNetPayroll(c,b,2900000,adjustments,record,2026,10,today);
test('advance reduces final transfer, never total monthly net wage expense',()=>{
 const result=settle([{id:'a1',crewId:'c1',type:'가불',amount:-500000}]);
 assert.equal(result.netPay,2900000);assert.equal(result.advance,500000);assert.equal(result.balance,2400000);
});
test('actual net confirmation includes advances and does not reapply unpaid deductions',()=>{
 const adjustments=[{id:'a1',crewId:'c1',type:'무급휴가',amount:-100000,unpaidDate:'2026-10-02'},{id:'a2',crewId:'c1',type:'가불',amount:-500000}];
 const record={netPay:2700000,adjustmentSnapshot:[['a1','무급휴가',-100000,'2026-10-02']]};
 const result=settle(adjustments,record);assert.equal(result.confirmed,true);assert.equal(result.netPay,2700000);assert.equal(result.balance,2200000);
});
test('changing/removing nonadvance adjustments invalidates confirmation; advance alone does not',()=>{
 const record={netPay:2800000,adjustmentSnapshot:[]};
 assert.equal(settle([{id:'a1',crewId:'c1',type:'기타',amount:100000}],record).unknown,true);
 assert.equal(settle([{id:'a1',crewId:'c1',type:'가불',amount:-100000}],record).confirmed,true);
 assert.equal(settle([],{netPay:2800000,adjustmentSnapshot:[['a1','기타',100000,null]]}).unknown,true);
});
test('missing hire date permits a monthly estimate, and actual wage still overrides it',()=>{
 const c={...crew,hireDate:null},b={pay:3000000,hours:0,days:31};
 const estimate=settle([],null,c,b,'2026-11-01');assert.equal(estimate.unknown,false);assert.equal(estimate.confirmed,false);assert.equal(estimate.netPay,2900000);assert.ok(estimate.reasons.some(r=>r.includes('1일부터')));
 const result=settle([],{netPay:2400000,adjustmentSnapshot:[]},c,b,'2026-11-01');assert.equal(result.unknown,false);assert.equal(result.netPay,2400000);
});
test('unpaid hourly leave with zero adjustment never deducts another daily wage',()=>{
 const result=settle([{id:'a1',crewId:'c1',type:'무급휴가',amount:0,unpaidDate:'2026-10-02'}],null,{...crew,wageType:'hourly'},base);
 assert.equal(result.netPay,2900000);
});
test('future unpaid day does not reduce accrued wages before it occurs',()=>{
 const result=settle([{id:'a1',crewId:'c1',type:'무급휴가',amount:-100000,unpaidDate:'2026-10-20'}],null,crew,base,'2026-10-10');assert.equal(result.netPay,2900000);
});
test('legacy half-day adjustments remain accounted for and excessive advances surface negative balance',()=>{
 const result=settle([{id:'a1',crewId:'c1',type:'반차',amount:-50000},{id:'a2',crewId:'c1',type:'가불',amount:-3000000}]);
 assert.equal(result.netPay,2850000);assert.equal(result.balance,-150000);assert.equal(result.unknown,false);
});
test('invalid legacy positive advance leaves salary intact and flags settlement balance as unknown',()=>{
 const result=settle([{id:'a1',crewId:'c1',type:'가불',amount:500000}]);assert.equal(result.netPay,2900000);assert.equal(result.balance,null);assert.ok(result.reasons.length);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);require('../report-assets/monthly-report.js');
const PDFLib=require('../report-assets/pdf-lib.min.js'),fontkit=require('../report-assets/fontkit.umd.min.js');
const R=globalThis.MANEE_REPORTS,options={PDFLib,fontkit,fontBytes:fs.readFileSync(new URL('../report-assets/NanumGothic-Regular.ttf',import.meta.url))};
const fixture=(n=22)=>{
 const expenses=Array.from({length:n},(_,i)=>({date:'2026-09-'+String((n===22?Math.floor(i*5/n)*7+1:Math.floor(i*30/n)+1)).padStart(2,'0'),description:'거래처 '+(i%15+1),memo:'구매내역 '+String(i+1).padStart(4,'0'),category:i%3?'food':null,amount:i%17===0?-1000:10000}));
 const total=expenses.reduce((s,e)=>s+e.amount,0);
 return {status:'provisional',month_key:'2026-09',closed_at:'2026-09-30T13:00:00Z',snapshot:{store_name:'검증용 매장',month_key:'2026-09',gross_sales:50000000,discount:600000,refund:0,net_sales:49400000,net_payroll:11000000,expenses_total:total,fixed_total:3500000,profit:49400000-11000000-total-3500000,payroll_status:{estimated_count:2,unknown_count:0},operating_days:30,missing_sales_days:0,invalid_sales_count:0,sales:[{date:'2026-09-30',gross:50000000,discount:600000,refund:0}],expenses,fixed:[{name:'월세',amount:3500000}]}};
};
test('daily, category and vendor groups reconcile, including signed uncategorized expenses',()=>{
 const r=fixture(250),g=R.groupExpenses(r.snapshot.expenses),rows=R.excelRows(r);
 for(const list of [g.days,g.vendors])assert.equal(list.reduce((s,e)=>s+e.amount,0),r.snapshot.expenses_total);
 assert.equal(g.categories.reduce((s,e)=>s+e[1],0),r.snapshot.expenses_total);
 assert.equal(rows.expenses.length,251);assert.ok(rows.summary.some(r=>r[1]?.includes?.('실제 순이익과 차이')));
});
test('drafts label estimated payroll; unknown payroll never becomes an invented zero or profit',()=>{
 const r=fixture();r.snapshot.net_payroll=null;r.snapshot.profit=null;r.snapshot.payroll_status.unknown_count=1;assert.equal(R.validate(r).profit,null);
 delete r.status;assert.throws(()=>R.validate(r),/unconfirmed/);
});
test('PDF starts with three sections and dynamically paginates every expense without dropping text',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'manee-report-'));
 for(const n of [22,250]){
  const r=fixture(n);if(n===250)r.snapshot.expenses[10].memo='긴 내용 '.repeat(260)+'내용끝';
  const bytes=await R.pdfBytes(r,options),pdf=await PDFLib.PDFDocument.load(bytes),file=path.join(dir,'report-'+n+'.pdf');fs.writeFileSync(file,bytes);
  assert.ok(pdf.getPageCount()>=3);if(n===22)assert.equal(pdf.getPageCount(),3);if(n===250)assert.ok(pdf.getPageCount()>6);
  const text=execFileSync('pdftotext',['-layout',file,'-'],{encoding:'utf8'});
  for(let i=0;i<n;i++){if(n===250&&i===10)continue;assert.ok(text.includes('구매내역 '+String(i+1).padStart(4,'0')),'missing row '+i);}
  for(const phrase of ['지출 기준 예상 수익','날짜별 지출 상세','거래처별 지출 요약','실제 순이익과 차이가 날 수 있습니다'])assert.ok(text.includes(phrase),phrase);
  if(n===250)assert.ok(text.includes('내용끝'));
  console.log('PDF '+n+' entries: '+pdf.getPageCount()+' pages, '+file);
 }
});

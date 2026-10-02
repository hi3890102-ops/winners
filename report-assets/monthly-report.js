(function(root){
  'use strict';
  const categories={food:'식자재',beverage:'주류·음료',supplies:'소모품',insurance:'보험료 납부',payroll_tax:'급여 원천세 납부',utilities:'공과금',fees:'수수료',tax:'기타 세금',other:'기타'};
  const won=n=>n===null||n===undefined?'미입력':Number(n).toLocaleString('ko-KR')+'원';
  function validate(closing){
    const r=closing?.snapshot;
    if(!r||r.profit===null||r.invalid_sales_count||r.payroll_status?.unknown_count||r.payroll_status?.estimated_count)throw Error('Report has unconfirmed inputs');
    for(const key of ['gross_sales','discount','refund','net_sales','net_payroll','expenses_total','fixed_total','profit'])if(!Number.isSafeInteger(r[key]))throw Error('Invalid report amount');
    if(r.gross_sales-r.discount-r.refund!==r.net_sales||r.net_sales-r.net_payroll-r.expenses_total-r.fixed_total!==r.profit)throw Error('Report totals do not reconcile');
    if(r.expenses.reduce((s,e)=>s+e.amount,0)!==r.expenses_total||r.fixed.reduce((s,e)=>s+e.amount,0)!==r.fixed_total)throw Error('Report details do not reconcile');
    if(r.sales.reduce((s,e)=>s+e.gross,0)!==r.gross_sales||r.sales.reduce((s,e)=>s+(e.discount||0),0)!==r.discount||r.sales.reduce((s,e)=>s+(e.refund||0),0)!==r.refund)throw Error('Sales detail does not reconcile');
    return r;
  }
  function summaryRows(closing){
    const r=validate(closing);
    return [['매니 월말 리포트',r.store_name],['귀속 월',r.month_key],['마감 버전',closing.revision],['마감 시각',closing.closed_at],[],['항목','금액'],['총매출',r.gross_sales],['할인',r.discount],['반품',r.refund],['실매출',r.net_sales],['세후급여 · 가불 포함',r.net_payroll],['지출',r.expenses_total],['고정비',r.fixed_total],['예상 순수익',r.profit],[],['영업 보고 일수',r.operating_days],['인건비율 (%)',r.labor_ratio],['식자재비율 (%)',r.food_ratio],['전체 지출비율 (%)',r.expense_ratio],['순이익률 (%)',r.profit_ratio],[],['계산 기준','실매출 - 세후급여 - 지출 - 고정비'],['가불','전체 세후급여에 포함. 남은 지급액에서만 차감'],['보험료·원천세','실제 납부 지출로 차감'],['비율 분모','할인 전 총매출'],['주의','은행잔액이 아닌 월 귀속 예상 순수익']];
  }
  function excelRows(closing){
    const r=validate(closing);
    return {summary:summaryRows(closing),sales:[['날짜','총매출','할인','반품','실매출','카드','현금','기타 결제','배민','쿠팡','요기요'],...r.sales.map(d=>[d.date,d.gross,d.discount,d.refund,d.net,d.card,d.cash,d.emoney,d.delivery_baemin,d.delivery_coupang,d.delivery_yogiyo])],expenses:[['날짜','지출 항목','분류','금액'],...r.expenses.map(e=>[e.date,e.description||'',categories[e.category]||'미분류',e.amount])],fixed:[['고정비','금액'],...r.fixed.map(e=>[e.name,e.amount])]};
  }
  async function pdfBytes(closing,options){
    const r=validate(closing),lib=options.PDFLib,doc=await lib.PDFDocument.create();doc.registerFontkit(options.fontkit);
    const font=await doc.embedFont(options.fontBytes,{subset:true});
    const green=lib.rgb(15/255,61/255,46/255),light=lib.rgb(242/255,247/255,243/255),ink=lib.rgb(.12,.18,.15),gray=lib.rgb(.36,.42,.39),white=lib.rgb(1,1,1);
    const chars=new Set(font.getCharacterSet()),clean=t=>Array.from(String(t)).map(c=>chars.has(c.codePointAt(0))?c:'?').join('');
    let page,y,pages=[];
    function text(t,x,at,size=11,color=ink){page.drawText(clean(t),{x,y:at,size,font,color});}
    function next(){page=doc.addPage([595.28,841.89]);pages.push(page);page.drawRectangle({x:0,y:773,width:595.28,height:69,color:green});text('MANEE  매니 월말 리포트',42,805,17,white);text(r.month_key+'  |  마감 버전 '+closing.revision,42,785,10,white);y=747;}
    function ensure(h){if(y-h<58)next();}
    function wrapped(t,max=500,size=11){const result=[];let line='';for(const ch of clean(t)){if(ch==='\n'||font.widthOfTextAtSize(line+ch,size)>max){result.push(line);line=ch==='\n'?'':ch;}else line+=ch;}if(line)result.push(line);return result;}
    function paragraph(t,size=10,color=gray){const lines=wrapped(t,511,size);for(const l of lines){ensure(size+9);text(l,42,y,size,color);y-=size+7;}y-=5;}
    function section(t){ensure(48);y-=10;page.drawRectangle({x:42,y:y-8,width:511,height:27,color:light});text(t,52,y,12,green);y-=34;}
    function amount(label,value){const lines=wrapped(label,320,11);ensure(lines.length*18+10);text(won(value),553-font.widthOfTextAtSize(clean(won(value)),11),y,11,ink);lines.forEach(l=>{text(l,50,y,11);y-=18;});page.drawLine({start:{x:50,y:y+7},end:{x:553,y:y+7},thickness:.4,color:light});y-=5;}
    next();paragraph(r.store_name,17,green);paragraph('마감 시각 '+new Date(closing.closed_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+' KST · 단위 원',9);
    section('이번 달 얼마나 남았나요?');
    [['총매출','gross_sales'],['할인','discount'],['반품','refund'],['실매출','net_sales'],['세후급여 · 가불 포함','net_payroll'],['지출','expenses_total'],['고정비','fixed_total']].forEach(([l,k])=>amount(l,r[k]));
    ensure(65);page.drawRectangle({x:42,y:y-37,width:511,height:48,color:green});text('예상 순수익',54,y-8,14,white);const profit=won(r.profit);text(profit,541-font.widthOfTextAtSize(clean(profit),18),y-11,18,white);y-=63;
    paragraph('실매출 '+won(r.net_sales)+' - 세후급여 '+won(r.net_payroll)+' - 지출 '+won(r.expenses_total)+' - 고정비 '+won(r.fixed_total)+' = '+won(r.profit),10);
    paragraph('영업 보고 '+r.operating_days+'일. 비율은 할인 전 총매출 기준입니다. 실제 통장 잔액과 다릅니다.',9);
    const ratio=(n)=>n===null?'미확정':Number(n).toFixed(1)+'%';paragraph('인건비 '+ratio(r.labor_ratio)+' · 식자재 '+ratio(r.food_ratio)+' · 지출 '+ratio(r.expense_ratio)+' · 순이익 '+ratio(r.profit_ratio),10);
    section('인건비와 납부 지출');amount('월 전체 세후급여 · 가불 포함',r.net_payroll);paragraph('가불을 비용에서 다시 빼지 않습니다. 보험료와 급여 원천세는 아래 실제 납부 지출에 포함됩니다.',10);
    section('지출 상세');if(!r.expenses.length)paragraph('등록된 지출이 없습니다.');
    const grouped={};r.expenses.forEach(e=>grouped[categories[e.category]||'미분류']=(grouped[categories[e.category]||'미분류']||0)+e.amount);Object.entries(grouped).forEach(([l,n])=>amount(l,n));
    r.expenses.forEach(e=>amount(e.date+' · '+(e.description?(e.description+' · '+(categories[e.category]||'미분류')):(categories[e.category]||'미분류')),e.amount));
    section('고정비 상세');if(!r.fixed.length)paragraph('등록된 고정비가 없습니다.');r.fixed.forEach(e=>amount(e.name,e.amount));
    section('일별 매출과 결제');if(!r.sales.length)paragraph('등록된 매출보고가 없습니다.');
    r.sales.forEach(d=>{ensure(110);amount(d.date+' · 총매출',d.gross);paragraph('할인 '+won(d.discount)+' · 반품 '+won(d.refund)+' · 실매출 '+won(d.net),10);paragraph('카드 '+won(d.card)+' · 현금 '+won(d.cash)+' · 기타 결제 '+won(d.emoney),9);paragraph('배민 '+won(d.delivery_baemin)+' · 쿠팡 '+won(d.delivery_coupang)+' · 요기요 '+won(d.delivery_yogiyo)+' (판매경로 정보, 총매출에 중복 합산하지 않음)',9);});
    section('계산 기준');paragraph('급여는 귀속월, 보험료·원천세·일반 지출은 등록된 지출 날짜 기준으로 계산합니다. 매출보고의 결제수단별 금액과 배달 경로 금액은 별도 정보이며 비용으로 다시 차감하지 않습니다. 과거 보고서는 해당 마감 버전을 보존합니다. 수정 후에는 정정 마감으로 새 버전을 만듭니다.',9);
    pages.forEach((p,i)=>{p.drawText(clean('MANEE · 우리가게 매니저'),{x:42,y:30,size:9,font,color:gray});p.drawText((i+1)+' / '+pages.length,{x:510,y:30,size:9,font,color:gray});});
    return doc.save();
  }
  root.MANEE_REPORTS={validate,summaryRows,excelRows,pdfBytes};
})(typeof window==='undefined'?globalThis:window);

(function(root){
  'use strict';
  const categories={food:'식자재',beverage:'주류·음료',supplies:'소모품',insurance:'보험료 납부',payroll_tax:'급여 원천세 납부',utilities:'공과금',fees:'수수료',tax:'기타 세금',other:'기타'};
  const disclaimer=['이 보고서는 입력된 매출·지출, 인건비·고정비를 기준으로 계산한 참고자료입니다.','입력 누락, 재고 및 비용 반영 시점 등에 따라 실제 순이익과 차이가 날 수 있습니다.'];
  const won=n=>n===null||n===undefined?'계산 보류':Number(n).toLocaleString('ko-KR')+'원';
  const category=e=>categories[e.category]||'미분류';
  function validate(closing){
    const r=closing?.snapshot,draft=closing?.status==='provisional';
    if(!r||r.invalid_sales_count||(!draft&&(r.profit===null||r.payroll_status?.unknown_count||r.payroll_status?.estimated_count)))throw Error('Report has unconfirmed inputs');
    for(const key of ['gross_sales','discount','refund','net_sales','net_payroll','expenses_total','fixed_total','profit']){
      if(draft&&['net_payroll','profit'].includes(key)&&r[key]===null)continue;
      if(!Number.isSafeInteger(r[key]))throw Error('Invalid report amount');
    }
    if(!Array.isArray(r.expenses)||!Array.isArray(r.fixed)||!Array.isArray(r.sales))throw Error('Report details missing');
    if(r.expenses.some(e=>!Number.isSafeInteger(e.amount))||r.fixed.some(e=>!Number.isSafeInteger(e.amount)))throw Error('Invalid detail amount');
    if(r.gross_sales-r.discount-r.refund!==r.net_sales||(r.net_payroll===null?r.profit!==null:r.net_sales-r.net_payroll-r.expenses_total-r.fixed_total!==r.profit))throw Error('Report totals do not reconcile');
    if(r.expenses.reduce((s,e)=>s+e.amount,0)!==r.expenses_total||r.fixed.reduce((s,e)=>s+e.amount,0)!==r.fixed_total)throw Error('Report details do not reconcile');
    if(r.sales.reduce((s,e)=>s+e.gross,0)!==r.gross_sales||r.sales.reduce((s,e)=>s+(e.discount||0),0)!==r.discount||r.sales.reduce((s,e)=>s+(e.refund||0),0)!==r.refund)throw Error('Sales detail does not reconcile');
    return r;
  }
  function groupExpenses(expenses){
    const days=new Map(),vendors=new Map(),byCategory=new Map();
    [...expenses].sort((a,b)=>a.date.localeCompare(b.date)).forEach(e=>{
      if(!days.has(e.date))days.set(e.date,{date:e.date,entries:[],amount:0});const day=days.get(e.date);day.entries.push(e);day.amount+=e.amount;
      const name=e.description||'거래처 미기재';if(!vendors.has(name))vendors.set(name,{name,amount:0,count:0,first:e.date,last:e.date});
      const vendor=vendors.get(name);vendor.amount+=e.amount;vendor.count++;vendor.last=e.date;
      const key=category(e);byCategory.set(key,(byCategory.get(key)||0)+e.amount);
    });
    return {days:[...days.values()],vendors:[...vendors.values()].sort((a,b)=>b.amount-a.amount||a.name.localeCompare(b.name,'ko')),categories:[...byCategory],uncategorized:expenses.filter(e=>!categories[e.category]).reduce((s,e)=>s+e.amount,0)};
  }
  function summaryRows(closing){
    const r=validate(closing),g=groupExpenses(r.expenses);
    return [['매니 월간 보고서',r.store_name],['귀속 월',r.month_key],['상태',closing.status==='provisional'?'잠정 보고서':'마감 버전 '+closing.revision],['기준 시각',closing.closed_at||r.generated_at],[],['항목','금액'],['총매출',r.gross_sales],['할인',r.discount],['반품',r.refund],['실매출',r.net_sales],['세후급여 · 가불 포함',r.net_payroll],['지출',r.expenses_total],['미분류 지출 (지출 합계에 포함)',g.uncategorized],['고정비',r.fixed_total],['지출 기준 예상 수익',r.profit],[],['영업 보고 일수',r.operating_days],['미입력 영업일',r.missing_sales_days||0],['급여 추정 인원',r.payroll_status?.estimated_count||0],['급여 계산 보류 인원',r.payroll_status?.unknown_count||0],['비용 확인',r.cost_review_complete?'확인 완료':'추가 확인 필요'],[],['계산 기준','실매출 - 세후급여 - 지출 - 고정비'],['가불','전체 세후급여에 포함. 남은 지급액에서만 차감'],['집계 기준','날짜별·거래처별 내역은 같은 지출을 재정리한 것이며 중복 합산하지 않습니다.'],...disclaimer.map(s=>['안내',s])];
  }
  function excelRows(closing){
    const r=validate(closing),g=groupExpenses(r.expenses);
    return {summary:summaryRows(closing),sales:[['날짜','총매출','할인','반품','실매출','카드','현금','기타 결제','배민','쿠팡','요기요'],...r.sales.map(d=>[d.date,d.gross,d.discount,d.refund,d.net,d.card,d.cash,d.emoney,d.delivery_baemin,d.delivery_coupang,d.delivery_yogiyo])],expenses:[['날짜','거래처','분류','금액','내용'],...g.days.flatMap(d=>d.entries.map(e=>[e.date,e.description||'',category(e),e.amount,e.memo||'']))],daily:[['날짜','건수','합계'],...g.days.map(d=>[d.date,d.entries.length,d.amount])],vendors:[['거래처','건수','첫 지출일','마지막 지출일','합계'],...g.vendors.map(v=>[v.name,v.count,v.first,v.last,v.amount])],fixed:[['고정비','금액'],...r.fixed.map(e=>[e.name,e.amount])]};
  }
  async function pdfBytes(closing,options){
    const r=validate(closing),g=groupExpenses(r.expenses),lib=options.PDFLib,doc=await lib.PDFDocument.create();doc.registerFontkit(options.fontkit);
    const font=await doc.embedFont(options.fontBytes,{subset:false});
    const rgb=h=>lib.rgb(parseInt(h.slice(0,2),16)/255,parseInt(h.slice(2,4),16)/255,parseInt(h.slice(4,6),16)/255);
    const ink=rgb('242B29'),muted=rgb('6B7570'),green=rgb('557567'),line=rgb('DDE2DE'),wash=rgb('F0F4F1');
    const chars=new Set(font.getCharacterSet()),clean=t=>Array.from(String(t??'')).map(c=>chars.has(c.codePointAt(0))?c:'?').join('');
    let page,y,pages=[];
    const text=(t,x,at,size=10,color=ink)=>page.drawText(clean(t),{x,y:at,size,font,color});
    const right=(t,at,size=10,color=ink)=>text(t,561-font.widthOfTextAtSize(clean(t),size),at,size,color);
    const rule=at=>page.drawLine({start:{x:34,y:at},end:{x:561,y:at},thickness:.5,color:line});
    function wrap(t,max,size=10){let lines=[],s='';for(const ch of clean(t)){if(ch==='\n'||font.widthOfTextAtSize(s+ch,size)>max){lines.push(s);s=ch==='\n'?'':ch;}else s+=ch;}lines.push(s);return lines;}
    function next(title){page=doc.addPage([595.28,841.89]);pages.push(page);text('MANEE  /  MONTHLY REPORT',34,808,9,green);right(r.month_key,808,9,muted);text(title,34,769,23);y=746;for(const l of wrap(r.store_name,520,10)){text(l,34,y,10,muted);y-=14;}rule(y-4);y-=27;}
    function ensure(h,title){if(y-h<85){next(title);return true;}return false;}
    function paragraph(t,size=9,color=muted,title='계산 기준'){for(const l of wrap(t,527,size)){ensure(size+7,title);text(l,34,y,size,color);y-=size+6;}y-=6;}
    function band(label,title='거래처별 지출 요약'){ensure(40,title);page.drawRectangle({x:34,y:y-7,width:527,height:25,color:wash});text(label,43,y,11,green);y-=32;}
    function amount(label,value,title='거래처별 지출 요약'){const ls=wrap(label,350,10);ensure(ls.length*15+8,title);right(won(value),y);ls.forEach(l=>{text(l,42,y);y-=15;});rule(y+7);y-=8;}
    next('월간 매출·지출 보고서');
    text(closing.status==='provisional'?'잠정 보고서 · 입력된 자료 기준':'마감 보고서 · 버전 '+closing.revision,34,y,10,green);y-=33;
    text('지출 기준 예상 수익',34,y,12,green);right(won(r.profit),y-6,26,ink);y-=45;rule(y);y-=25;
    for(const [label,value] of [['총매출',r.gross_sales],['할인·반품',-(r.discount+r.refund)],['실매출',r.net_sales]])amount(label,value,'월간 매출·지출 보고서');
    band('비용 구성 · 항목별 합계','월간 매출·지출 보고서');
    for(const [label,value] of g.categories.filter(([label])=>label!=='미분류'))amount(label,value,'월간 매출·지출 보고서');
    amount('미분류 지출 · 합계에 포함',g.uncategorized,'월간 매출·지출 보고서');
    amount('인건비 · 세후급여 (가불 포함)',r.net_payroll,'월간 매출·지출 보고서');
    amount('고정비',r.fixed_total,'월간 매출·지출 보고서');
    amount('전체 비용',r.net_payroll===null?null:r.expenses_total+r.net_payroll+r.fixed_total,'월간 매출·지출 보고서');
    paragraph('실매출 - 지출 - 인건비 - 고정비 = 지출 기준 예상 수익',9,green);
    paragraph('매출보고 '+r.operating_days+'일 · 미입력 영업일 '+(r.missing_sales_days||0)+'일 · 급여 추정 '+(r.payroll_status?.estimated_count||0)+'명 · 급여 계산 보류 '+(r.payroll_status?.unknown_count||0)+'명',8);
    paragraph(r.cost_review_complete?'비용 확인 완료 · 미분류 금액도 합계에 포함됩니다.':'비용 확인 전 · 입력되지 않은 비용은 합계에 반영되지 않았습니다. 미분류 금액은 포함됩니다.',8);
    // Daily ledger starts on a separate page. Every row is emitted, including long memos.
    next('날짜별 지출 상세');
    paragraph('총 '+r.expenses.length+'건 · '+won(r.expenses_total)+'  /  미분류 포함 · 날짜순',10,green);
    const tableHead=()=>{text('거래처',42,y,9,muted);text('내용',180,y,9,muted);text('분류',416,y,9,muted);right('금액',y,9,muted);y-=16;rule(y);y-=17;};
    tableHead();
    const detailNext=(date)=>{next('날짜별 지출 상세 · 계속');tableHead();text(date+' · 계속',42,y,10,green);y-=23;};
    if(!g.days.length)paragraph('등록된 지출이 없습니다.');
    for(const day of g.days){
      if(ensure(66,'날짜별 지출 상세 · 계속'))tableHead();
      page.drawRectangle({x:34,y:y-6,width:527,height:21,color:wash});text(day.date+' · '+day.entries.length+'건',42,y,9,green);right('일 합계 '+won(day.amount),y,9,green);y-=23;
      for(const e of day.entries){
        const cols=[wrap(e.description||'거래처 미기재',128,9),wrap(e.memo||'—',225,9),wrap(category(e),62,8)];
        const n=Math.max(...cols.map(c=>c.length));
        for(let i=0;i<n;i++){
          if(y-15<85)detailNext(day.date);
          cols.forEach((ls,j)=>{if(ls[i])text(ls[i],[42,180,416][j],y,j===2?8:9,j===2?muted:ink);});
          if(i===0)right(won(e.amount),y,9);
          y-=14;
        }
        rule(y+7);y-=4;
      }
      y-=7;
    }
    if(y>=113)amount('지출 합계 · 요약과 동일',r.expenses_total,'날짜별 지출 상세 · 계속');
    // Vendor totals are a different view of the same expenses; never added to costs again.
    next('거래처별 지출 요약');
    paragraph('같은 지출을 거래처별로 정리했습니다. 날짜별 내역과 중복 합산하지 않습니다.',9);
    for(const v of g.vendors){
      const ls=wrap(v.name,200,10);ensure(ls.length*14+10,'거래처별 지출 요약 · 계속');
      right(won(v.amount),y,10);text(v.count+'건',253,y,8,muted);text(v.first+' ~ '+v.last,297,y,7,muted);
      for(const l of ls){text(l,42,y,10);y-=14;}rule(y+5);y-=8;
    }
    if(!g.vendors.length)paragraph('등록된 거래처 지출이 없습니다.');
    amount('거래처 합계 · 지출 합계와 동일',r.expenses_total);
    if(r.fixed.length){band('고정비 상세');for(const f of r.fixed)amount(f.name,f.amount);}
    band('계산 기준 및 확인 사항');
    paragraph('보험료·원천세는 실제 납부 지출에 포함됩니다. 가불은 인건비에 포함되며 다시 차감하지 않습니다.');
    paragraph('미분류 지출 '+won(g.uncategorized)+'도 전체 지출에 포함됩니다. 분류를 바꿔도 금액은 한 번만 계산합니다.');
    paragraph('기준 시각 '+new Date(closing.closed_at||r.generated_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+' KST. 과거 마감 버전은 보존됩니다.');
    pages.forEach((p,i)=>{page=p;rule(70);text(disclaimer[0],34,56,7,muted);text(disclaimer[1],34,44,7,muted);text('MANEE · 우리가게 매니저',34,24,8,green);right((i+1)+' / '+pages.length,24,8,muted);});
    return doc.save();
  }
  root.MANEE_REPORTS={validate,summaryRows,excelRows,pdfBytes,groupExpenses,disclaimer};
})(typeof window==='undefined'?globalThis:window);

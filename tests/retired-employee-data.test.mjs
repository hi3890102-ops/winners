import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start);return html.slice(start,end);}
const escapeHtml=s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;');
const profile=section('  const TP_FIELDS =','  function bindTeamProfileEvents(');
const make=new Function('state','escapeHtml','teamInfoRow','renderAvatarBadge',profile+';return {tpBuildEdit,tpCheck,tpStoreChanges,teamPersonalPage,teamEditPage};');
test('Personal profile edit ignores retired bank fields from a stale API response',()=>{
 const f=make({},escapeHtml,()=>'',()=>''), ed=f.tpBuildEdit({profile:{person_name:'Test',phone:'',bank_name:'retired',bank_account:'retired-account',account_holder:'retired-holder'},stores:[]});
 assert.deepEqual(Object.keys(ed.form),['name','phone']);assert.deepEqual(f.tpCheck(ed.form),{});
 const view=make({teamEdit:ed},escapeHtml,()=>'',()=>'').teamEditPage({},false);
 assert.ok(view.includes('연락처 (선택)'));assert.ok(!view.includes('retired'));assert.ok(!/tp-bank|tp-account|tp-holder/.test(view));
});
test('Name and phone store confirmation remains intact',()=>{
 const f=make({},escapeHtml,()=>'',()=>''),ed=f.tpBuildEdit({profile:{person_name:'New',phone:'010-1234-5678'},stores:[{crew_id:'c',name:'Old',phone:'010-0000-0000',bank_text:'ignored',adopted:{}}]});
 const changes=f.tpStoreChanges(ed);assert.equal(changes[0].needsConfirm,true);assert.deepEqual(changes[0].diffs.map(x=>x.field),['name','phone']);
});
test('Employee form retains work conditions but removes retired and custom input fields',()=>{
 const fn=new Function('escapeHtml',section('  function renderExtraCrewFields(', '  function infoModalContent(')+';return renderExtraCrewFields;')(escapeHtml);
 for(const c of [null,{id:'c',residentNumber:'retired',bankAccount:'retired',customFields:[{label:'retired',value:'retired'}]}]){
  const out=fn(c);assert.ok(out.includes('주당 근무시간'));assert.ok(!/resident|bank|customfield|retired|추가 항목/.test(out));
 }
});
test('Canonical app has no remaining retired field reads or writes',()=>{
 assert.ok(!/resident_number|residentNumber|bank_account|bankAccount|bank_name|account_holder|custom_fields|customFields/.test(html));
});

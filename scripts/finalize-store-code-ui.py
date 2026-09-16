from pathlib import Path
import re
p=Path('index.html'); text=p.read_text(encoding='utf-8')
def replace(old,new):
    global text
    assert text.count(old)==1, (old[:100],text.count(old))
    text=text.replace(old,new,1)
start=text.index('  function renderOwnerStaffAccess(){')
end=text.index('  async function refreshOwnerStaffAccess(){',start)
text=text[:start]+'''  function renderOwnerStaffAccess(){
    const access=state.ownerStaffAccess;
    let html='<div class="day-panel"><h3>스텝 계정 연결</h3><p class="crew-code-hint">1. 매장코드를 직원에게 전달 → 2. 직원이 가입 요청 → 3. 직원기록 선택 후 승인</p>'+staffAuthButton('owner-refresh','매장코드·요청 불러오기')+' '+staffAuthButton('account','내 계정·매장 연결');
    if(!access || access.storeId!==currentStoreId()) return html+'<p>매장코드는 자동으로 발급됩니다. 위 버튼을 눌러 확인해 주세요.</p></div>';
    html+='<div class="day-panel" style="margin-top:12px;"><strong>매장 연결코드</strong><div class="crew-code-row"><span class="crew-code">'+escapeHtml(access.store_join_code||'--------')+'</span>'+staffAuthButton('copy-store-code','복사')+' '+staffAuthButton('regenerate-store-code','재발급')+'</div><p class="crew-code-hint">여러 직원이 같은 코드를 사용합니다. 재발급해도 연결된 직원과 접수된 요청은 유지되며, 이전 코드로는 새 요청을 보낼 수 없습니다.</p></div>';
    if(!(access.requests||[]).length) html+='<p>대기 중인 가입 요청이 없어요.</p>';
    for(const r of access.requests||[]){
      const available=(access.available_crew||[]).filter(c=>
        (!c.linked_user_id || c.linked_user_id===r.requester_user_id) &&
        (!r.existing_crew_id || r.existing_crew_id===c.crew_id) && (!r.crew_id || r.crew_id===c.crew_id));
      let options='<option value="">연결할 직원을 선택해 주세요</option>';
      for(const c of available) options+='<option value="'+escapeHtml(c.crew_id)+'">'+escapeHtml(c.crew_name)+(c.position?' · '+escapeHtml(c.position):'')+'</option>';
      html+='<div class="day-panel"><strong>'+escapeHtml(r.display_name||r.username)+'</strong><p>가입 아이디: '+escapeHtml(r.username)+'</p><label class="field-label" for="staff-link-crew-'+escapeHtml(r.id)+'">기존 직원기록 선택</label><select class="field-input" id="staff-link-crew-'+escapeHtml(r.id)+'">'+options+'</select>';
      if(!available.length) html+='<p class="crew-code-hint">연결 가능한 직원기록이 없습니다. 아래 직원 추가에서 먼저 등록하거나 기존 계정 연결을 확인해 주세요.</p>';
      html+=staffAuthButton('approve','연결 승인','data-request-id="'+escapeHtml(r.id)+'"'+(!available.length?' disabled':''))+' '+staffAuthButton('reject','거절','data-request-id="'+escapeHtml(r.id)+'"')+'</div>';
    }
    for(const m of access.links||[]) html+='<div class="day-panel">'+escapeHtml(m.crew_name)+' · '+escapeHtml(m.username)+' · '+(m.status==='active'?'연결됨':'연결 해제됨')+' '+(m.status==='active'?staffAuthButton('revoke','연결 해제','data-membership-id="'+escapeHtml(m.id)+'"'):'')+'</div>';
    for(const r of access.attendance_edits||[]) html+='<div class="day-panel"><strong>근무 시간 수정 요청</strong><p>'+escapeHtml(r.crew_name)+' · '+escapeHtml(r.date)+'<br>'+escapeHtml((r.requested_check_in||'').slice(0,5))+' ~ '+escapeHtml((r.requested_check_out||'').slice(0,5))+'</p>'+staffAuthButton('approve-edit','수정 승인','data-request-id="'+escapeHtml(r.id)+'"')+' '+staffAuthButton('reject-edit','거절','data-request-id="'+escapeHtml(r.id)+'"')+'</div>';
    return html+'</div>'+renderPasswordResetRequests('직원 비밀번호 재설정 요청');
  }
''' + text[end:]
replace("    const action=button.dataset.staffAuthAction;", """    const action=button.dataset.staffAuthAction;
    const ownerMutation=['approve','reject','revoke','regenerate-store-code','approve-edit','reject-edit'].includes(action);
    if(ownerMutation && button.dataset.confirmed!=='yes'){
      button.dataset.reviewStoreId=currentStoreId();
      if(action==='approve'){
        const select=document.getElementById('staff-link-crew-'+button.dataset.requestId);
        if(!select || !select.value){showToast('연결할 직원을 먼저 선택해 주세요.');return;}
        // Confirmation rendering may replace the select. Pin the reviewed record now.
        button.dataset.selectedCrewId=select.value;
      }
    }
    if(ownerMutation && button.dataset.confirmed==='yes' && button.dataset.reviewStoreId!==currentStoreId()){
      delete button.dataset.confirmed;showToast('선택한 매장이 바뀌었어요. 요청을 다시 확인해 주세요.');return;
    }""")
replace("          const select=document.getElementById('staff-link-crew-'+button.dataset.requestId);\n          const crewId=(select&&select.value)||'';", "          const crewId=button.dataset.selectedCrewId||'';")
replace("      else if(action==='regenerate-store-code'){", """      else if(action==='copy-store-code'){
        const access=state.ownerStaffAccess;
        if(!access || access.storeId!==currentStoreId() || !access.store_join_code) throw new Error('매장코드를 먼저 불러와 주세요.');
        if(!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('코드를 길게 눌러 복사해 주세요.');
        await navigator.clipboard.writeText(access.store_join_code);showToast('매장코드를 복사했어요. 직원에게 전달해 주세요.');
      }else if(action==='regenerate-store-code'){""")
# Allow formatted clipboard input, normalize before validation, never persist the code.
text=text.replace(".replace(/\\s+/g,'').toUpperCase()", ".replace(/[\\s-]+/g,'').toUpperCase()")
replace('id="staff-link-code" maxlength="8"', 'id="staff-link-code" maxlength="16"')
replace("매장명은 입력하지 않아도 돼요. 사장님에게 받은 매장 연결코드를 입력해 주세요.", "매장명은 입력하지 않아도 돼요. 사장님께 매장코드를 받아 입력해 주세요. 사장님은 스텝 관리의 ‘스텝 계정 연결’에서 코드를 확인할 수 있어요.")
replace("    const preview=state.staffLinkPreview;", """    if((state.staffLinkRequests||[]).some(r=>r.status==='pending')) html+='<div class="day-panel"><strong>사장님 승인 대기 중</strong><p>이미 가입 요청을 보냈습니다. 다시 요청할 필요 없이, 승인 후 아래에서 연결 상태를 확인해 주세요.</p></div>';
    const preview=state.staffLinkPreview;""")
replace("  async function regenCode(id){", """  async function regenCode(id){
    if(MANEE_STAFF_AUTH_ENABLED){showToast('직원별 코드 대신 위의 매장 연결코드를 이용해 주세요.');return;}""")
replace("'<div class=\"wage\">코드 '+(c.joinCode||\"사용됨\")+'</div>", "'<div class=\"wage\">'+(MANEE_STAFF_AUTH_ENABLED?'매장코드로 계정 연결':'코드 '+(c.joinCode||\"------\"))+'</div>") if "'<div class=\"wage\">코드 '+(c.joinCode||\"사용됨\")+'</div>" in text else None
# The crew header is part of a longer HTML literal. Cover that exact inline form too.
text=text.replace('<div class="wage">코드 \'+(c.joinCode||"사용됨")+\'</div>', '<div class="wage">\'+(MANEE_STAFF_AUTH_ENABLED?"매장코드로 계정 연결":"코드 "+(c.joinCode||"------"))+\'</div>')
p.write_text(text,encoding='utf-8')
# Historical one-time UI assertions are superseded; the old DB-stage tests remain.
Path('security/staff-link-one-time-code-ui.test.mjs').unlink(missing_ok=True)
ui=Path('security/store-staff-link-code-ui.test.mjs')
t=ui.read_text(encoding='utf-8').replace('maxlength="8"','maxlength="16"')
ui.write_text(t,encoding='utf-8')
# Existing generic approval test must now select a record before opening confirmation.
test=Path('security/staff-auth-ui.test.mjs')
t=test.read_text(encoding='utf-8')
t=t.replace("const h=harness();const button={dataset:{staffAuthAction:'approve',requestId:'request'}", "const h=harness({inputs:{'staff-link-crew-request':'crew-self'}});const button={dataset:{staffAuthAction:'approve',requestId:'request'}")
test.write_text(t,encoding='utf-8')
print('Store code UI finalized; codes never leave staging during tests.')

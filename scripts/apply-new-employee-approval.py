from pathlib import Path
p=Path('index.html')
text=p.read_text(encoding='utf-8')

def replace_once(old,new,label):
    global text
    count=text.count(old)
    if count!=1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    text=text.replace(old,new,1)

old_owner='''  function renderOwnerStaffAccess(){
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
  }'''
new_owner='''  function renderOwnerStaffAccess(){
    const access=state.ownerStaffAccess;
    let html='<div class="day-panel"><h3>스텝 계정 연결</h3><p class="crew-code-hint">1. 매장코드를 직원에게 전달 → 2. 직원이 가입 요청 → 3. 신규 직원 승인 또는 기존 직원기록 연결</p>'+staffAuthButton('owner-refresh','매장코드·요청 불러오기')+' '+staffAuthButton('account','내 계정·매장 연결');
    if(!access || access.storeId!==currentStoreId()) return html+'<p>매장코드는 자동으로 발급됩니다. 위 버튼을 눌러 확인해 주세요.</p></div>';
    html+='<div class="day-panel" style="margin-top:12px;"><strong>매장 연결코드</strong><div class="crew-code-row"><span class="crew-code">'+escapeHtml(access.store_join_code||'--------')+'</span>'+staffAuthButton('copy-store-code','복사')+' '+staffAuthButton('regenerate-store-code','재발급')+'</div><p class="crew-code-hint">여러 직원이 같은 코드를 사용합니다. 재발급해도 연결된 직원과 접수된 요청은 유지되며, 이전 코드로는 새 요청을 보낼 수 없습니다.</p></div>';
    if(!(access.requests||[]).length) html+='<p>대기 중인 가입 요청이 없어요.</p>';
    for(const r of access.requests||[]){
      const available=(access.available_crew||[]).filter(c=>
        (!c.linked_user_id || c.linked_user_id===r.requester_user_id) &&
        (!r.existing_crew_id || r.existing_crew_id===c.crew_id) && (!r.crew_id || r.crew_id===c.crew_id));
      let options='<option value="">연결할 기존 직원을 선택해 주세요</option>';
      for(const c of available) options+='<option value="'+escapeHtml(c.crew_id)+'">'+escapeHtml(c.crew_name)+(c.position?' · '+escapeHtml(c.position):'')+'</option>';
      html+='<div class="day-panel"><strong>'+escapeHtml(r.display_name||r.username)+'</strong><p>가입 아이디: '+escapeHtml(r.username)+'</p>'+
        '<div style="margin-top:10px;">'+staffAuthButton('approve-new','신규 직원으로 승인','data-request-id="'+escapeHtml(r.id)+'"')+'</div>'+
        '<p class="crew-code-hint">신규 직원은 직원기록을 새로 생성해 바로 연결합니다. 급여·근무파트 등은 승인 후 직원관리에서 입력해 주세요.</p>'+
        '<details style="margin-top:12px;"><summary style="cursor:pointer;font-size:13px;font-weight:700;">기존 직원기록 연결 <span style="font-weight:500;color:var(--ink-soft);">(기존 직원 전환용)</span></summary>'+
        '<div style="margin-top:10px;"><label class="field-label" for="staff-link-crew-'+escapeHtml(r.id)+'">기존 직원 선택</label><select class="field-input" id="staff-link-crew-'+escapeHtml(r.id)+'">'+options+'</select>';
      if(!available.length) html+='<p class="crew-code-hint">연결 가능한 기존 직원기록이 없습니다. 신규 직원이면 위의 신규 직원으로 승인을 눌러 주세요.</p>';
      html+=staffAuthButton('approve','기존 기록 연결','data-request-id="'+escapeHtml(r.id)+'"'+(!available.length?' disabled':''))+'</div></details> '+staffAuthButton('reject','거절','data-request-id="'+escapeHtml(r.id)+'"')+'</div>';
    }
    for(const m of access.links||[]) html+='<div class="day-panel">'+escapeHtml(m.crew_name)+' · '+escapeHtml(m.username)+' · '+(m.status==='active'?'연결됨':'연결 해제됨')+' '+(m.status==='active'?staffAuthButton('revoke','연결 해제','data-membership-id="'+escapeHtml(m.id)+'"'):'')+'</div>';
    for(const r of access.attendance_edits||[]) html+='<div class="day-panel"><strong>근무 시간 수정 요청</strong><p>'+escapeHtml(r.crew_name)+' · '+escapeHtml(r.date)+'<br>'+escapeHtml((r.requested_check_in||'').slice(0,5))+' ~ '+escapeHtml((r.requested_check_out||'').slice(0,5))+'</p>'+staffAuthButton('approve-edit','수정 승인','data-request-id="'+escapeHtml(r.id)+'"')+' '+staffAuthButton('reject-edit','거절','data-request-id="'+escapeHtml(r.id)+'"')+'</div>';
    return html+'</div>'+renderPasswordResetRequests('직원 비밀번호 재설정 요청');
  }'''
replace_once(old_owner,new_owner,'owner approval UI')
replace_once('사장님이 요청을 확인하고 기존 직원 기록을 선택해 승인하면 출퇴근·급여·근무 기록이 이 계정에 연결돼요.','사장님이 승인하면 신규 직원으로 등록되거나 기존 직원기록과 연결돼요. 기존 기록을 연결하는 경우 출퇴근·급여·근무 기록이 그대로 이어집니다.','staff approval copy')
replace_once("const ownerMutation=['approve','reject','revoke','regenerate-store-code','approve-edit','reject-edit'].includes(action);","const ownerMutation=['approve','approve-new','reject','revoke','regenerate-store-code','approve-edit','reject-edit'].includes(action);",'mutation list')
replace_once("if(['approve','reject','revoke','regenerate-store-code','approve-edit','reject-edit'].includes(action) && button.dataset.confirmed!=='yes'){
      const message=action==='regenerate-store-code'?'매장 연결코드를 새로 발급할까요? 이전 코드는 즉시 사용할 수 없어요.':action==='revoke'?'이 계정의 매장 접근을 해제할까요? 직원·근무 기록은 보존돼요.':action==='approve'?'선택한 직원 기록을 이 가입 계정에 연결할까요?':'이 요청을 처리할까요?';","if(['approve','approve-new','reject','revoke','regenerate-store-code','approve-edit','reject-edit'].includes(action) && button.dataset.confirmed!=='yes'){
      const message=action==='regenerate-store-code'?'매장 연결코드를 새로 발급할까요? 이전 코드는 즉시 사용할 수 없어요.':action==='revoke'?'이 계정의 매장 접근을 해제할까요? 직원·근무 기록은 보존돼요.':action==='approve-new'?'신규 직원으로 등록하고 승인할까요? 새 직원기록이 생성됩니다.':action==='approve'?'선택한 기존 직원기록을 이 가입 계정에 연결할까요?':'이 요청을 처리할까요?';",'confirmation message')
replace_once("if(!select || !select.value){showToast('연결할 직원을 먼저 선택해 주세요.');return;}","if(!select || !select.value){showToast('연결할 기존 직원을 먼저 선택해 주세요.');return;}",'selection message')
replace_once("      }else if(['approve','reject','revoke'].includes(action)){
        const payload={request_id:button.dataset.requestId,membership_id:button.dataset.membershipId};","      }else if(action==='approve-new'){
        await staffPortal('approve_new',{request_id:button.dataset.requestId});
        await refreshOwnerStaffAccess(); showToast('신규 직원으로 승인했어요. 직원정보를 확인해 주세요.');
      }else if(['approve','reject','revoke'].includes(action)){
        const payload={request_id:button.dataset.requestId,membership_id:button.dataset.membershipId};",'approve new action')
p.write_text(text,encoding='utf-8')
print('new employee approval UI patch applied')

from pathlib import Path
import re

path=Path('index.html')
text=path.read_text(encoding='utf-8')

def sub_once(pattern,repl,label):
    global text
    text2,count=re.subn(pattern,repl,text,count=1,flags=re.S)
    if count!=1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    text=text2

def replace_once(old,new,label):
    global text
    count=text.count(old)
    if count!=1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    text=text.replace(old,new,1)

new_views=r'''  function renderStaffAuthAccount(){
    const p=state.authProfile||{};
    let html='<h2>내 매장 연결</h2><p>'+escapeHtml(p.display_name||p.username||'')+' · '+escapeHtml(p.username||'')+'</p>';
    for(const m of state.authMemberships||[]) html+='<div class="day-panel"><strong>'+escapeHtml(m.store_name)+'</strong> · '+(m.role==='owner'?'사장님':'스텝')+' '+staffAuthButton('open-store','매장 들어가기','data-store-id="'+escapeHtml(m.store_id)+'"')+'</div>';
    const preview=state.staffLinkPreview;
    if(preview){
      html+='<div class="code-box"><h3 style="margin-top:0;">매장을 확인해 주세요</h3>'+
        '<div class="day-panel" style="margin:10px 0;"><strong>'+escapeHtml(preview.store_name||'')+'</strong><br><span>이 매장으로 가입 요청을 보냅니다.</span></div>'+
        '<p>사장님이 요청을 확인하고 기존 직원 기록을 선택해 승인하면 출퇴근·급여·근무 기록이 이 계정에 연결돼요.</p>'+
        staffAuthButton('request','가입 요청 보내기')+' '+staffAuthButton('link-code-change','다른 코드 입력')+'</div>';
    }else{
      html+='<div class="code-box"><label for="staff-link-code">매장 연결코드</label>'+
        '<input id="staff-link-code" maxlength="8" autocomplete="one-time-code" autocapitalize="characters" placeholder="8자리 매장코드" style="text-transform:uppercase;">'+
        staffAuthButton('preview-link','매장 확인')+'<p>매장명은 입력하지 않아도 돼요. 사장님에게 받은 매장 연결코드를 입력해 주세요.</p></div>';
    }
    const statuses={pending:'승인 대기',approved:'승인 완료',rejected:'거절됨',cancelled:'취소됨',expired:'기간 만료'};
    for(const r of state.staffLinkRequests||[]) html+='<div class="day-panel">'+escapeHtml(r.store_name)+' · '+(statuses[r.status]||'확인 필요')+' '+
      (r.status==='pending'?staffAuthButton('cancel','요청 취소','data-request-id="'+escapeHtml(r.id)+'"'):'')+'</div>';
    html+='<div class="day-panel"><h3>계정 보안</h3><p>현재 비밀번호를 확인한 뒤 새 비밀번호로 변경할 수 있어요.</p>'+staffAuthButton('recovery-change','비밀번호 변경')+'</div>';
    html+=staffAuthButton('refresh-account','연결 상태 새로 확인')+' '+staffAuthButton('logout','로그아웃');
    return html;
  }
  function renderOwnerStaffAccess(){
    const access=state.ownerStaffAccess;
    let html='<div class="day-panel"><h3>스텝 계정 연결</h3><p class="crew-code-hint">직원은 이 매장의 고유코드로 가입 요청을 보내고, 사장님은 기존 직원 기록을 선택해 연결합니다.</p>'+staffAuthButton('owner-refresh','요청·연결 새로 확인')+' '+staffAuthButton('account','내 계정·매장 연결');
    if(!access || access.storeId!==currentStoreId()) return html+'<p>새로 확인을 누르면 이 매장의 코드와 요청을 불러와요.</p></div>';
    html+='<div class="day-panel" style="margin-top:12px;"><strong>매장 연결코드</strong><div class="crew-code-row"><span class="crew-code">'+escapeHtml(access.store_join_code||'--------')+'</span>'+staffAuthButton('regenerate-store-code','코드 재발급')+'</div><p class="crew-code-hint">이 코드는 여러 직원이 사용할 수 있어요. 재발급하면 이전 코드는 즉시 사용할 수 없어요.</p></div>';
    if(!access.requests.length) html+='<p>대기 중인 가입 요청이 없어요.</p>';
    const available=access.available_crew||[];
    for(const r of access.requests){
      let options='<option value="">연결할 직원을 선택해 주세요</option>';
      for(const c of available) options+='<option value="'+escapeHtml(c.crew_id)+'">'+escapeHtml(c.crew_name)+(c.position?' · '+escapeHtml(c.position):'')+'</option>';
      html+='<div class="day-panel"><strong>'+escapeHtml(r.display_name||r.username)+'</strong><p>가입 아이디: '+escapeHtml(r.username)+'</p><label class="field-label" for="staff-link-crew-'+escapeHtml(r.id)+'">연결할 직원</label><select class="field-input" id="staff-link-crew-'+escapeHtml(r.id)+'">'+options+'</select>'+
        staffAuthButton('approve','연결 승인','data-request-id="'+escapeHtml(r.id)+'"')+' '+staffAuthButton('reject','거절','data-request-id="'+escapeHtml(r.id)+'"')+'</div>';
    }
    for(const m of access.links) html+='<div class="day-panel">'+escapeHtml(m.crew_name)+' · '+escapeHtml(m.username)+' · '+(m.status==='active'?'연결됨':'연결 해제됨')+' '+(m.status==='active'?staffAuthButton('revoke','연결 해제','data-membership-id="'+escapeHtml(m.id)+'"'):'')+'</div>';
    for(const r of access.attendance_edits||[]) html+='<div class="day-panel"><strong>근무 시간 수정 요청</strong><p>'+escapeHtml(r.crew_name)+' · '+escapeHtml(r.date)+'<br>'+escapeHtml((r.requested_check_in||'').slice(0,5))+' ~ '+escapeHtml((r.requested_check_out||'').slice(0,5))+'</p>'+staffAuthButton('approve-edit','수정 승인','data-request-id="'+escapeHtml(r.id)+'"')+' '+staffAuthButton('reject-edit','거절','data-request-id="'+escapeHtml(r.id)+'"')+'</div>';
    return html+'</div>'+renderPasswordResetRequests('직원 비밀번호 재설정 요청');
  }
  async function refreshOwnerStaffAccess(){'''
sub_once(r"  function renderStaffAuthAccount\(\)\{.*?\n  async function refreshOwnerStaffAccess\(\)\{",new_views,'replace staff and owner connection views')

replace_once(
"    if(['approve','reject','revoke','approve-edit','reject-edit'].includes(action) && button.dataset.confirmed!=='yes'){\n      const message=action==='revoke'?'이 계정의 매장 접근을 해제할까요? 직원·근무 기록은 보존돼요.':action==='approve'?'직원의 실제 가입 아이디를 확인했나요? 이 계정에 기존 직원 기록을 연결할까요?':'이 요청을 처리할까요?';",
"    if(['approve','reject','revoke','regenerate-store-code','approve-edit','reject-edit'].includes(action) && button.dataset.confirmed!=='yes'){\n      const message=action==='regenerate-store-code'?'매장 연결코드를 새로 발급할까요? 이전 코드는 즉시 사용할 수 없어요.':action==='revoke'?'이 계정의 매장 접근을 해제할까요? 직원·근무 기록은 보존돼요.':action==='approve'?'선택한 직원 기록을 이 가입 계정에 연결할까요?':'이 요청을 처리할까요?';",
'confirmation actions')

sub_once(
r"      \}else if\(action==='preview-link'\)\{.*?(?=      \}else if\(action==='cancel'\)\{)",
r'''      }else if(action==='preview-link'){
        const code=((document.getElementById('staff-link-code')||{}).value||'').replace(/\s+/g,'').toUpperCase();
        if(!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new Error('8자리 매장 연결코드를 입력해 주세요.');
        const preview=await staffPortal('preview',{code});
        state.staffLinkCode=code;state.staffLinkPreview={store_name:preview.store_name};render();
      }else if(action==='link-code-change'){
        state.staffLinkCode=null;state.staffLinkPreview=null;render();
      }else if(action==='request'){
        const code=String(state.staffLinkCode||'').replace(/\s+/g,'').toUpperCase();
        if(!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new Error('매장 연결코드를 다시 확인해 주세요.');
        await staffPortal('request',{code}); state.staffLinkCode=null;state.staffLinkPreview=null;
        await restoreManeeAuthIdentity(null,true); showToast('가입 요청을 보냈어요. 사장님 승인 후 직원 기록이 연결됩니다.');
''',
'store code request actions')

sub_once(
r"      else if\(\['approve','reject','revoke'\]\.includes\(action\)\)\{.*?(?=      \}else if\(action==='approve-edit')",
r'''      else if(action==='regenerate-store-code'){
        await staffPortal('regenerate_store_code',{store_id:currentStoreId()});
        await refreshOwnerStaffAccess(); showToast('새 매장 연결코드를 발급했어요.');
      }else if(['approve','reject','revoke'].includes(action)){
        const payload={request_id:button.dataset.requestId,membership_id:button.dataset.membershipId};
        if(action==='approve'){
          const select=document.getElementById('staff-link-crew-'+button.dataset.requestId);
          const crewId=(select&&select.value)||'';
          if(!crewId) throw new Error('연결할 직원을 선택해 주세요.');
          payload.crew_id=crewId;
        }
        await staffPortal(action,payload);
        await refreshOwnerStaffAccess(); showToast('처리했어요. 직원 화면에서 연결 상태를 새로 확인해 주세요.');
''',
'owner approval action')

replace_once(
"    const uniqueJoinCode = await genUniqueCode();",
"    const uniqueJoinCode = MANEE_STAFF_AUTH_ENABLED ? null : await genUniqueCode();",
'no per-crew auth code')

replace_once(
"              html += '<div class=\"crew-code-row\"><span class=\"crew-code\">'+(c.joinCode||\"사용됨\")+'</span>'+(c.joinCode?'<button class=\"crew-code-btn\" data-copycode=\"'+c.joinCode+'\">복사</button>':'')+'<button class=\"crew-code-btn\" data-regencode=\"'+c.id+'\">'+(c.joinCode?'재발급':'새 코드 발급')+'</button></div>';",
"              if(!MANEE_STAFF_AUTH_ENABLED) html += '<div class=\"crew-code-row\"><span class=\"crew-code\">'+(c.joinCode||\"------\")+'</span><button class=\"crew-code-btn\" data-copycode=\"'+c.joinCode+'\">복사</button><button class=\"crew-code-btn\" data-regencode=\"'+c.id+'\">재발급</button></div>';",
'hide legacy crew code in auth mode')

text=text.replace("showToast('스텝 계정을 만들었어요. 매장 연결을 요청해 주세요.');","showToast('스텝 계정을 만들었어요. 매장 연결코드를 입력해 주세요.');",1)
path.write_text(text,encoding='utf-8')
print('store-level staff connection UI patch applied')

from pathlib import Path
import re

p = Path('index.html')
s = p.read_text(encoding='utf-8')

# Back button clears the old password kept only in memory.
if 'if(state.landingMode === "legacy-password-upgrade")' not in s:
    old = '''  function landingBack(){
    if(state.landingMode === "password-reset-request"){
      state.landingMode = "store-login";'''
    new = '''  function landingBack(){
    if(state.landingMode === "legacy-password-upgrade"){
      state.legacyPasswordUpgrade = null;
      state.landingMode = "store-login";
    }else if(state.landingMode === "password-reset-request"){
      state.landingMode = "store-login";'''
    assert old in s
    s = s.replace(old, new, 1)

# Patch only loginStoreOwner, avoiding fragile whole-file string matching.
login_start = s.index('  async function loginStoreOwner(){')
login_end = s.index('  async function submitPasswordResetRequest(){', login_start)
login_block = s[login_start:login_end]
if 'legacy_password_upgrade_required' not in login_block:
    pattern = re.compile(r'}\s*catch\s*\(e\)\s*\{\s*authError\s*=\s*e;\s*\}')
    replacement = '''}catch(e){
      if(e && e.code === "legacy_password_upgrade_required"){
        state.legacyPasswordUpgrade = { username, oldPassword: pw };
        state.landingMode = "legacy-password-upgrade";
        render();
        return;
      }
      authError = e;
    }'''
    login_block, n = pattern.subn(replacement, login_block, count=1)
    assert n == 1, 'login catch block not found'
    s = s[:login_start] + login_block + s[login_end:]

# Submit new password to the server, where the old password is verified again.
if 'async function submitLegacyPasswordUpgrade()' not in s:
    marker = '  async function submitPasswordResetRequest(){'
    fn = '''  async function submitLegacyPasswordUpgrade(){
    const pending = state.legacyPasswordUpgrade;
    if(!pending || !pending.username || !pending.oldPassword){
      state.legacyPasswordUpgrade = null;
      state.landingMode = "store-login";
      render();
      return;
    }
    const pwInput = document.getElementById("legacy-new-password-input");
    const confirmInput = document.getElementById("legacy-new-password-confirm-input");
    const newPw = pwInput ? (pwInput.value||"") : "";
    const confirmPw = confirmInput ? (confirmInput.value||"") : "";
    if(newPw.length < 8){ showToast("새 비밀번호는 8자 이상으로 만들어 주세요."); return; }
    if(newPw.length > 72){ showToast("새 비밀번호는 72자 이하로 입력해 주세요."); return; }
    if(newPw !== confirmPw){ showToast("새 비밀번호가 서로 달라요."); return; }
    showToast("보안 로그인을 전환하는 중이에요…");
    try{
      const data = await callManeeAuthApi("manee-login", {
        username: pending.username,
        password: pending.oldPassword,
        new_password: newPw
      });
      await applyManeeAuthSession(data.session);
      const username = data.user.username;
      state.legacyPasswordUpgrade = null;
      await enterAuthenticatedOwner(username, null);
      showToast("보안 로그인 전환이 완료됐어요");
    }catch(e){
      showToast((e && e.message) ? e.message : "비밀번호 변경에 실패했어요.");
    }
  }

'''
    assert marker in s
    s = s.replace(marker, fn + marker, 1)

# Upgrade screen.
if 'id="legacy-new-password-input"' not in s:
    old = '''    }else if(state.landingMode === "password-reset-request"){
      html += '<p>아이디와 매장명을 입력하면 본사에 재설정 요청을 보내드려요.</p>';'''
    new = '''    }else if(state.landingMode === "legacy-password-upgrade"){
      html += '<p>기존 비밀번호를 확인했어요. 앞으로 안전하게 로그인할 새 비밀번호를 만들어 주세요.</p>';
      html += '<div class="code-box">';
      html += '<label>새 비밀번호</label>';
      html += '<input id="legacy-new-password-input" type="password" autocomplete="new-password" placeholder="8자 이상" style="text-align:left;letter-spacing:normal;font-weight:500;">';
      html += '<label style="margin-top:8px;">새 비밀번호 확인</label>';
      html += '<input id="legacy-new-password-confirm-input" type="password" autocomplete="new-password" placeholder="새 비밀번호 확인" style="text-align:left;letter-spacing:normal;font-weight:500;">';
      html += '<button id="legacy-password-upgrade-submit-btn">변경하고 계속하기</button>';
      html += '</div>';
      html += '<button class="switch-link" id="landing-back-btn">‹ 뒤로</button>';
    }else if(state.landingMode === "password-reset-request"){
      html += '<p>아이디와 매장명을 입력하면 본사에 재설정 요청을 보내드려요.</p>';'''
    assert old in s
    s = s.replace(old, new, 1)

# Delegated event survives render() replacing app.innerHTML.
if '#legacy-password-upgrade-submit-btn' not in s:
    old = '  const toastEl = document.getElementById("toast");'
    new = '''  const toastEl = document.getElementById("toast");
  app.addEventListener("click", (e)=>{
    const target = e.target && e.target.closest ? e.target.closest("#legacy-password-upgrade-submit-btn") : null;
    if(target){ e.preventDefault(); submitLegacyPasswordUpgrade(); }
  });'''
    assert old in s
    s = s.replace(old, new, 1)

# Critical: once migrated, the old SHA-256 fallback must no longer accept the legacy password.
cred_start = s.index('  async function findOwnerRequestByCredentials(')
cred_end = s.index('  async function findAnyOwnerRequestByUsername(', cred_start)
cred_block = s[cred_start:cred_end]
if ".is('auth_migrated_at', null)" not in cred_block:
    old_query = ".ilike('username', username).eq('password_hash', passwordHash).order('requested_at', { ascending:false }).limit(1)"
    new_query = ".ilike('username', username).eq('password_hash', passwordHash).is('auth_migrated_at', null).order('requested_at', { ascending:false }).limit(1)"
    assert old_query in cred_block, 'legacy credential query not found'
    cred_block = cred_block.replace(old_query, new_query, 1)
    s = s[:cred_start] + cred_block + s[cred_end:]

p.write_text(s, encoding='utf-8')

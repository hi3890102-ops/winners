from pathlib import Path
import re

ROOT = Path('.')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


def sub_once(text, pattern, repl, label):
    updated, count = re.subn(pattern, repl, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one regex match, found {count}')
    return updated

# ----- index.html -----
path = ROOT / 'index.html'
text = path.read_text(encoding='utf-8')

old_gen = '''  function genCode(){ return String(Math.floor(100000 + Math.random()*900000)); }
  async function genUniqueCode(){
    for(let i=0;i<10;i++){
      const code = genCode();
      try{
        const { data } = await db.from('crew').select('id').eq('join_code', code).maybeSingle();
        if(!data) return code;
      }catch(e){ return code; }
    }
    return genCode()+String(Math.floor(Math.random()*10));
  }'''
new_gen = '''  const STAFF_LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function genCode(){
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b=>STAFF_LINK_CODE_ALPHABET[b % STAFF_LINK_CODE_ALPHABET.length]).join("");
  }
  async function genUniqueCode(){
    for(let i=0;i<20;i++){
      const code = genCode();
      try{
        const { data } = await db.from('crew').select('id').eq('join_code', code).maybeSingle();
        if(!data) return code;
      }catch(e){ return code; }
    }
    throw new Error("직원 연결코드를 만들지 못했어요. 다시 시도해 주세요.");
  }'''
text = replace_once(text, old_gen, new_gen, 'secure 8-char code generator')

old_clear = "    state.accountRecoveryKey=null;state.passwordResetRequests=[];state.revealedResetCode=null;"
new_clear = "    state.accountRecoveryKey=null;state.passwordResetRequests=[];state.revealedResetCode=null;state.staffLinkPreview=null;state.staffLinkCode=null;"
text = replace_once(text, old_clear, new_clear, 'clear staff link preview state')

render_pattern = r"  function renderStaffAuthAccount\(\)\{.*?\n  \}\n  function renderOwnerStaffAccess\(\)\{"
new_render = '''  function renderStaffAuthAccount(){
    const p=state.authProfile||{};
    let html='<h2>내 매장 연결</h2><p>'+escapeHtml(p.display_name||p.username||'')+' · '+escapeHtml(p.username||'')+'</p>';
    for(const m of state.authMemberships||[]) html+='<div class="day-panel"><strong>'+escapeHtml(m.store_name)+'</strong> · '+(m.role==='owner'?'사장님':'스텝')+' '+staffAuthButton('open-store','매장 들어가기','data-store-id="'+escapeHtml(m.store_id)+'"')+'</div>';
    const preview=state.staffLinkPreview;
    if(preview){
      html+='<div class="code-box"><h3 style="margin-top:0;">연결 정보를 확인해 주세요</h3>'+
        '<div class="day-panel" style="margin:10px 0;"><strong>'+escapeHtml(preview.store_name||'')+'</strong><br><span>'+escapeHtml(preview.crew_name||'')+' 직원으로 연결을 요청합니다.</span></div>'+
        '<p>사장님이 승인하면 기존 출퇴근·급여·근무 기록이 이 계정에 연결돼요.</p>'+
        staffAuthButton('request','연결 요청하기')+' '+staffAuthButton('link-code-change','다른 코드 입력')+'</div>';
    }else{
      html+='<div class="code-box"><label for="staff-link-code">사장님께 받은 직원 연결코드</label>'+
        '<input id="staff-link-code" maxlength="8" autocomplete="one-time-code" autocapitalize="characters" placeholder="8자리 연결코드" style="text-transform:uppercase;">'+
        staffAuthButton('preview-link','확인')+'<p>매장명은 입력하지 않아도 돼요. 연결코드 하나로 매장과 직원 기록을 자동으로 찾습니다.</p></div>';
    }
    const statuses={pending:'승인 대기',approved:'승인 완료',rejected:'거절됨',cancelled:'취소됨',expired:'기간 만료'};
    for(const r of state.staffLinkRequests||[]) html+='<div class="day-panel">'+escapeHtml(r.store_name)+' · '+(statuses[r.status]||'확인 필요')+' '+
      (r.status==='pending'?staffAuthButton('cancel','요청 취소','data-request-id="'+escapeHtml(r.id)+'"'):'')+'</div>';
    html+='<div class="day-panel"><h3>계정 보안</h3><p>현재 비밀번호를 확인한 뒤 새 비밀번호로 변경할 수 있어요.</p>'+staffAuthButton('recovery-change','비밀번호 변경')+'</div>';
    html+=staffAuthButton('refresh-account','연결 상태 새로 확인')+' '+staffAuthButton('logout','로그아웃');
    return html;
  }
  function renderOwnerStaffAccess(){'''
text = sub_once(text, render_pattern, new_render, 'staff link account UI')

old_request = '''      }else if(action==='request'){
        const code=(document.getElementById('staff-link-code').value||'').trim();
        await staffPortal('request',{code}); await restoreManeeAuthIdentity(null,true); showToast('사장님께 연결 승인을 요청했어요.');'''
new_request = '''      }else if(action==='preview-link'){
        const code=((document.getElementById('staff-link-code')||{}).value||'').replace(/\\s+/g,'').toUpperCase();
        if(!/^[A-Z0-9]{8}$/.test(code)) throw new Error('8자리 직원 연결코드를 입력해 주세요.');
        const preview=await staffPortal('preview',{code});
        state.staffLinkCode=code;state.staffLinkPreview={store_name:preview.store_name,crew_name:preview.crew_name};render();
      }else if(action==='link-code-change'){
        state.staffLinkCode=null;state.staffLinkPreview=null;render();
      }else if(action==='request'){
        const code=String(state.staffLinkCode||'').trim().toUpperCase();
        if(!/^[A-Z0-9]{8}$/.test(code)) throw new Error('연결코드를 다시 확인해 주세요.');
        await staffPortal('request',{code}); state.staffLinkCode=null;state.staffLinkPreview=null;
        await restoreManeeAuthIdentity(null,true); showToast('사장님께 연결 승인을 요청했어요. 이 연결코드는 사용 완료됐어요.');'''
text = replace_once(text, old_request, new_request, 'preview then request action')

text = text.replace('(c.joinCode||"------")', '(c.joinCode||"사용됨")')
old_code_row = '''              html += '<div class="crew-code-row"><span class="crew-code">'+(c.joinCode||"사용됨")+'</span><button class="crew-code-btn" data-copycode="'+c.joinCode+'">복사</button><button class="crew-code-btn" data-regencode="'+c.id+'">재발급</button></div>';'''
new_code_row = '''              html += '<div class="crew-code-row"><span class="crew-code">'+(c.joinCode||"사용됨")+'</span>'+(c.joinCode?'<button class="crew-code-btn" data-copycode="'+c.joinCode+'">복사</button>':'')+'<button class="crew-code-btn" data-regencode="'+c.id+'">'+(c.joinCode?'재발급':'새 코드 발급')+'</button></div>';'''
text = replace_once(text, old_code_row, new_code_row, 'used code owner UI')

path.write_text(text, encoding='utf-8')

# ----- staff portal SQL (fresh staging and production foundation) -----
new_portal_branch = '''  elsif p_action='preview' then
    if not public.consume_auth_rate_limit('staff_link_preview',md5(actor::text),300,20) then
      return jsonb_build_object('ok',false,'error','rate_limited'); end if;
    code := upper(btrim(coalesce(p_payload->>'code','')));
    if code !~ '^[A-Z0-9]{8}$' then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into person from public.crew where join_code=code;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into st from public.stores where id=person.store_id and archived_at is null for share;
    if not found or (person.resign_date is not null and person.resign_date <= (now() at time zone 'Asia/Seoul')::date) then
      return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    if exists(select 1 from public.store_memberships where crew_id=person.id and user_id<>actor) then
      return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    return jsonb_build_object('ok',true,'store_name',st.name,'crew_name',person.name);
  elsif p_action='request' then
    if not public.consume_auth_rate_limit('staff_link_request',md5(actor::text),300,10) then
      return jsonb_build_object('ok',false,'error','rate_limited'); end if;
    code := upper(btrim(coalesce(p_payload->>'code','')));
    if code !~ '^[A-Z0-9]{8}$' then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into person from public.crew where join_code=code for update;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into st from public.stores where id=person.store_id and archived_at is null for share;
    if not found or (person.resign_date is not null and person.resign_date <= (now() at time zone 'Asia/Seoul')::date) then
      return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into member from public.store_memberships where user_id=actor and store_id=st.id;
    if found and (member.role='owner' or member.crew_id is distinct from person.id) then
      return jsonb_build_object('ok',false,'error','store_account_conflict'); end if;
    if member.id is not null and member.status='active' then return jsonb_build_object('ok',false,'error','already_linked'); end if;
    if exists(select 1 from public.store_memberships where crew_id=person.id and user_id<>actor) then
      return jsonb_build_object('ok',false,'error','record_already_linked'); end if;
    update private.staff_link_requests set status='expired',reviewed_at=now() where requester_user_id=actor and status='pending' and expires_at<=now();
    select id into rid from private.staff_link_requests where requester_user_id=actor and crew_id=person.id and status='pending';
    if rid is not null then
      update public.crew set join_code=null where id=person.id and join_code=code;
      return jsonb_build_object('ok',true,'request_id',rid); end if;
    if (select count(*) from private.staff_link_requests where requester_user_id=actor and status='pending')>=10 then
      return jsonb_build_object('ok',false,'error','too_many_pending'); end if;
    update public.crew set join_code=null where id=person.id and join_code=code;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    insert into private.staff_link_requests(requester_user_id,store_id,crew_id) values(actor,st.id,person.id) returning id into rid;
    return jsonb_build_object('ok',true,'request_id',rid);
'''

for sql_name in ['security/staff-auth.sql','security/staff-auth-production-foundation.sql']:
    p = ROOT / sql_name
    sql = p.read_text(encoding='utf-8')
    sql = sub_once(
        sql,
        r"  elsif p_action='request' then.*?(?=  elsif p_action='cancel' then)",
        new_portal_branch,
        f'{sql_name} portal request branch'
    )
    p.write_text(sql, encoding='utf-8')

# ----- already-applied environment migration -----
prod = (ROOT / 'security/staff-auth-production-foundation.sql').read_text(encoding='utf-8')
start = prod.index('create function private.manee_staff_portal')
end = prod.index('\n$$;', start) + len('\n$$;')
portal_def = prod[start:end].replace('create function private.manee_staff_portal','create or replace function private.manee_staff_portal',1)
migration = '''-- Cutover migration for one-time 8-character staff connection codes.\n-- Apply to staging now; production only immediately before the security-v2 app cutover.\nbegin;\nset local lock_timeout='5s';\nset local statement_timeout='60s';\n\ncreate table if not exists private.staff_link_code_rollout_backup (\n  crew_id uuid primary key references public.crew(id) on delete cascade,\n  old_join_code text,\n  backed_up_at timestamptz not null default now()\n);\nrevoke all on private.staff_link_code_rollout_backup from public,anon,authenticated;\ninsert into private.staff_link_code_rollout_backup(crew_id,old_join_code)\nselect id,join_code from public.crew where join_code is not null\non conflict (crew_id) do nothing;\n\ndo $manee_codes$\ndeclare r record; candidate text;\nbegin\n  for r in select id from public.crew where join_code is not null and join_code !~ '^[A-Z0-9]{8}$' loop\n    loop\n      candidate := upper(substr(md5(gen_random_uuid()::text || r.id::text || clock_timestamp()::text),1,8));\n      begin\n        update public.crew set join_code=candidate where id=r.id;\n        exit;\n      exception when unique_violation then\n        null;\n      end;\n    end loop;\n  end loop;\nend\n$manee_codes$;\n\n''' + portal_def + '''\n\ncommit;\n'''
(ROOT / 'security/staff-link-one-time-codes.sql').write_text(migration, encoding='utf-8')

rollback = '''-- Emergency code-format rollback only. Does not undo memberships or business data.\n-- Consumed one-time codes (join_code is null) stay consumed and are never restored.\nbegin;\nupdate public.crew c\nset join_code=b.old_join_code\nfrom private.staff_link_code_rollout_backup b\nwhere c.id=b.crew_id and c.join_code is not null and b.old_join_code is not null;\ncommit;\n'''
(ROOT / 'security/staff-link-one-time-codes-rollback.sql').write_text(rollback, encoding='utf-8')

# ----- database tests -----
p = ROOT / 'security/staff-auth-database.test.mjs'
t = p.read_text(encoding='utf-8')
for old,new in [('120001','A2B3C4D5'),('120002','E6F7G8H9'),('120003','J2K3L4M5')]:
    t=t.replace(old,new)

code_scenario_pattern = r"scenario\('Code creates a pending request without revealing staff details or granting access'.*?(?=\nscenario\('Repeated requests)"
code_scenario = '''scenario('Code preview reveals only store and employee names, then request consumes the code without granting access',async()=>{
  await role(worker);
  const preview=await portal('preview',{code:'A2B3C4D5'});
  assert.deepEqual(Object.keys(preview).sort(),['crew_name','ok','store_name']);
  assert.equal(preview.store_name,'Synthetic A');assert.equal(preview.crew_name,'Synthetic Crew A');
  await postgres();assert.equal(await scalar('select join_code from public.crew where id=$1',[crew]),'A2B3C4D5');
  await role(worker);const r=await portal('request',{code:'A2B3C4D5',user_id:owner,role:'owner',store_id:otherStore});
  assert.deepEqual(Object.keys(r).sort(),['ok','request_id']);
  assert.equal((await portal('session')).memberships.length,0);
  await postgres();assert.equal(await scalar('select requester_user_id from private.staff_link_requests where id=$1',[r.request_id]),worker);
  assert.equal(await scalar('select join_code is null from public.crew where id=$1',[crew]),true);
});'''
t = sub_once(t, code_scenario_pattern, code_scenario, 'database preview/consume scenario')

repeat_pattern = r"scenario\('Repeated requests are idempotent and failed guesses remain rate limited'.*?(?=\nscenario\('Only requester)"
repeat_scenario = '''scenario('A consumed code cannot be reused and invalid previews are rate limited',async()=>{
  await role(worker);const first=await portal('request',{code:'A2B3C4D5'});assert.equal(first.ok,true);
  assert.equal((await portal('request',{code:'A2B3C4D5'})).error,'invalid_code');
  for(let i=0;i<20;i++) await portal('preview',{code:'ZZZZZZZZ'});
  assert.equal((await portal('preview',{code:'ZZZZZZZZ'})).error,'rate_limited');
});'''
t = sub_once(t, repeat_pattern, repeat_scenario, 'database one-time/rate-limit scenario')

compete_pattern = r"scenario\('Competing pending requests cannot claim the same crew after one approval'.*?(?=\nscenario\('Two crew records)"
compete_scenario = '''scenario('One-time code prevents a competing pending request for the same crew',async()=>{
  const a=await request(worker);assert.ok(a);
  await role(otherWorker);assert.equal((await portal('request',{code:'A2B3C4D5'})).error,'invalid_code');
  await postgres();assert.equal(await scalar('select count(*)::int from private.staff_link_requests where crew_id=$1 and status=\'pending\'',[crew]),1);
});'''
t = sub_once(t, compete_pattern, compete_scenario, 'database competing request scenario')

old_approval_pattern = r"scenario\('Old approval cannot undo revoke; a fresh request may reactivate only the same account'.*?(?=\nscenario\('Staff cannot select raw coworker payroll)"
old_approval_scenario = '''scenario('Old approval cannot undo revoke; a newly issued code may reactivate only the same account',async()=>{
  const linked=await connect();await portal('revoke',{membership_id:linked.membership});
  await portal('approve',{request_id:linked.request});await role(worker);
  assert.equal((await portal('session')).memberships.length,0);
  await postgres();await db.query("update public.crew set join_code='N2P3Q4R5' where id=$1",[crew]);
  await role(otherWorker);assert.equal((await portal('request',{code:'N2P3Q4R5'})).error,'record_already_linked');
  await role(worker);const nextRequest=await portal('request',{code:'N2P3Q4R5'});assert.equal(nextRequest.ok,true);
  await role(owner);const approved=await portal('approve',{request_id:nextRequest.request_id});assert.equal(approved.membership_id,linked.membership);
  await postgres();assert.equal(await scalar("select count(*)::int from private.staff_access_events where action='reactivated'"),1);
});'''
t = sub_once(t, old_approval_pattern, old_approval_scenario, 'database reactivation scenario')

# This assertion used a consumed code after two requests; make it exercise a fresh code instead.
t=t.replace("await role(owner);assert.equal((await portal('request',{code:'A2B3C4D5'})).error,'store_account_conflict');",
            "await postgres();await db.query(\"update public.crew set join_code='P2Q3R4S5' where id=$1\",[crew]);await role(owner);assert.equal((await portal('request',{code:'P2Q3R4S5'})).error,'store_account_conflict');")

p.write_text(t, encoding='utf-8')

# ----- focused UI regression test -----
ui_test = '''import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\n\nconst html=readFileSync(new URL('../index.html',import.meta.url),'utf8');\n\ntest('staff connection UI uses code only with an eight-character one-time code',()=>{\n  const start=html.indexOf('  function renderStaffAuthAccount(){');\n  const end=html.indexOf('  function renderOwnerStaffAccess(){',start);\n  const body=html.slice(start,end);\n  assert.ok(body.includes('직원 연결코드'));\n  assert.ok(body.includes('maxlength="8"'));\n  assert.ok(body.includes('매장명은 입력하지 않아도 돼요'));\n  assert.ok(body.includes("staffAuthButton('preview-link','확인')"));\n  assert.equal(body.includes('maxlength="6"'),false);\n});\n\ntest('staff connection previews identity before request and request clears preview state',()=>{\n  assert.ok(html.includes("staffPortal('preview',{code})"));\n  assert.ok(html.includes("state.staffLinkPreview={store_name:preview.store_name,crew_name:preview.crew_name}"));\n  assert.ok(html.includes("staffPortal('request',{code})"));\n  assert.ok(html.includes("state.staffLinkCode=null;state.staffLinkPreview=null"));\n});\n\ntest('new employee link codes use cryptographic random bytes and eight characters',()=>{\n  assert.ok(html.includes('crypto.getRandomValues(bytes)'));\n  assert.ok(html.includes('new Uint8Array(8)'));\n  assert.ok(html.includes('STAFF_LINK_CODE_ALPHABET'));\n});\n'''
(ROOT / 'security/staff-link-one-time-code-ui.test.mjs').write_text(ui_test, encoding='utf-8')

# ----- rollout note -----
rollout = ROOT / 'security/production-rollout.md'
if rollout.exists():
    r = rollout.read_text(encoding='utf-8')
    marker = '## Phase B'
    if marker in r and 'staff-link-one-time-codes.sql' not in r:
        r = r.replace(marker, "## Phase B\n\nBefore the security-v2 user-app cutover, apply `security/staff-link-one-time-codes.sql`. It converts still-unused legacy staff codes to 8-character codes and enables preview + one-time consumption. Consumed codes are cleared immediately when a connection request is created. `security/staff-link-one-time-codes-rollback.sql` restores only unconsumed legacy codes during an emergency rollback.\n\n", 1)
        rollout.write_text(r, encoding='utf-8')

print('one-time staff link code patch applied')

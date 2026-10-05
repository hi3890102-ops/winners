-- Additive month-end workflow. Existing entries and historical closings are not rewritten.
create table public.monthly_cost_reviews (
 store_id uuid not null references public.stores(id), month_key text not null check(month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 completed_at timestamptz, completed_by uuid references auth.users(id), remind_after date,
 primary key(store_id,month_key)
);
create table public.recurring_cost_templates (
 id uuid primary key default gen_random_uuid(),store_id uuid not null references public.stores(id),
 name text not null check(length(trim(name)) between 1 and 120),category text,
 mode text not null check(mode in ('fixed','variable')),amount integer,
 start_month text not null check(start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),active boolean not null default true,
 check((mode='fixed' and amount is not null and amount<>0) or (mode='variable' and amount is null))
);
create index recurring_cost_store_idx on public.recurring_cost_templates(store_id);
alter table public.fixed_expenses add column cost_template_id uuid references public.recurring_cost_templates(id);
create unique index fixed_expenses_template_month on public.fixed_expenses(store_id,month_key,cost_template_id) where cost_template_id is not null;
create table public.monthly_cost_checks (
 store_id uuid not null references public.stores(id),month_key text not null check(month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),item_key text not null,
 status text not null check(status in ('linked','not_applicable')),expense_id uuid references public.expense_entries(id) on delete set null,
 fixed_id uuid references public.fixed_expenses(id) on delete set null,updated_at timestamptz not null default now(),
 primary key(store_id,month_key,item_key)
);
create index monthly_cost_checks_expense_idx on public.monthly_cost_checks(expense_id);
create index monthly_cost_checks_fixed_idx on public.monthly_cost_checks(fixed_id);
create table private.monthly_cost_requests (
 store_id uuid not null references public.stores(id),request_id uuid not null,payload jsonb not null,primary key(store_id,request_id)
);
create table private.monthly_cost_push_deliveries (
 store_id uuid not null,month_key text not null,subscription_id bigint not null,send_date date not null,
 status text not null default 'claimed' check(status in ('claimed','sent','failed','expired')),
 created_at timestamptz not null default now(),primary key(store_id,month_key,subscription_id,send_date)
);
-- New reminders require a subscription bound by an authenticated owner. Legacy devices are not guessed.
alter table public.push_subscriptions add column user_id uuid references auth.users(id);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id);

do $$declare t text;begin
 foreach t in array array['monthly_cost_reviews','recurring_cost_templates','monthly_cost_checks'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy cost_owner_read on public.%I for select to authenticated using ((select private.is_live_manee_session()) and private.can_manage_store(store_id))',t);
 end loop;
end $$;
revoke all on private.monthly_cost_requests,private.monthly_cost_push_deliveries from public,anon,authenticated;

create function private.assert_cost_access(p_store uuid,p_month text) returns void
language plpgsql stable security definer set search_path='' as $$begin
 if auth.uid() is null or not private.is_live_manee_session() or not private.can_manage_store(p_store) then raise exception 'Cost access denied' using errcode='42501';end if;
 if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Invalid month' using errcode='22023';end if;
 if not exists(select 1 from public.stores where id=p_store and archived_at is null) then raise exception 'Store unavailable';end if;
end $$;
revoke all on function private.assert_cost_access(uuid,text) from public,anon,authenticated;

-- Serialize legacy carry-forward and template materialization; loading twice never duplicates costs.
create function private.manee_prepare_fixed_costs(p_store_id uuid,p_month_key text) returns void
language plpgsql security definer set search_path='' as $$declare previous_month text;begin
 perform private.assert_cost_access(p_store_id,p_month_key);
 if p_month_key>to_char(now() at time zone 'Asia/Seoul','YYYY-MM') then return;end if;
 perform pg_advisory_xact_lock(hashtextextended('fixed:'||p_store_id::text||p_month_key,0));
 previous_month:=to_char(to_date(p_month_key||'-01','YYYY-MM-DD')-interval '1 month','YYYY-MM');
 -- Keep the existing legacy carry-forward behavior, excluding explicitly managed templates.
 if not exists(select 1 from public.fixed_expenses where store_id=p_store_id and month_key=p_month_key) then
  insert into public.fixed_expenses(store_id,month_key,name,amount)
  select p_store_id,p_month_key,name,amount from public.fixed_expenses where store_id=p_store_id and month_key=previous_month and cost_template_id is null;
 end if;
 insert into public.fixed_expenses(store_id,month_key,name,amount,cost_template_id)
 select p_store_id,p_month_key,t.name,t.amount,t.id from public.recurring_cost_templates t
 where t.store_id=p_store_id and t.active and t.mode='fixed' and t.start_month<=p_month_key
 on conflict(store_id,month_key,cost_template_id) where cost_template_id is not null do nothing;
end $$;
create function public.manee_prepare_fixed_costs(p_store_id uuid,p_month_key text) returns void language sql security invoker set search_path='' as $$select private.manee_prepare_fixed_costs(p_store_id,p_month_key)$$;
revoke all on function private.manee_prepare_fixed_costs(uuid,text),public.manee_prepare_fixed_costs(uuid,text) from public,anon;
grant execute on function private.manee_prepare_fixed_costs(uuid,text),public.manee_prepare_fixed_costs(uuid,text) to authenticated;

create function private.manee_cost_review(p_store_id uuid,p_month_key text,p_action text default 'read',p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare first_day date;last_day date;today date:=(now() at time zone 'Asia/Seoul')::date;
 e_id uuid;f_id uuid;key text;v_date date;v_amount integer;v_name text;v_memo text;v_cat text;v_mode text;request uuid;previous jsonb;checks jsonb;templates jsonb;
begin
 perform private.assert_cost_access(p_store_id,p_month_key);
 first_day:=to_date(p_month_key||'-01','YYYY-MM-DD');last_day:=(first_day+interval '1 month - 1 day')::date;
 if p_action not in ('read','link','skip','add','defer','complete','stop_template') or p_action is null then raise exception 'Invalid cost action';end if;
 perform pg_advisory_xact_lock(hashtextextended('cost:'||p_store_id::text||p_month_key,0));
 if p_action<>'read' then
  insert into public.monthly_cost_reviews(store_id,month_key) values(p_store_id,p_month_key) on conflict do nothing;
 end if;
 key:=nullif(p_payload->>'key','');
 if key is not null and key not in ('electricity','water','gas') and not exists(select 1 from public.recurring_cost_templates t where t.id::text=key and t.store_id=p_store_id and t.active and t.mode='variable' and t.start_month<=p_month_key) then raise exception 'Invalid cost item';end if;
 if p_action in ('link','skip') and key is null then raise exception 'Cost item required';end if;
 if p_action='add' then
  request:=(p_payload->>'request_id')::uuid;if request is null then raise exception 'Request ID required';end if;
  select payload into previous from private.monthly_cost_requests where store_id=p_store_id and request_id=request;
  if found then
   if previous<>p_payload||jsonb_build_object('month_key',p_month_key) then raise exception 'Request payload mismatch';end if;
   return private.manee_cost_review(p_store_id,p_month_key,'read','{}');
  end if;
  v_date:=(p_payload->>'date')::date;v_amount:=(p_payload->>'amount')::integer;v_name:=trim(p_payload->>'name');v_memo:=coalesce(p_payload->>'memo','');v_cat:=nullif(p_payload->>'category','');v_mode:=coalesce(p_payload->>'recurrence','none');
  if v_date is null or v_date<first_day or v_date>last_day or v_date>today or v_amount is null or v_amount=0 or v_name is null or length(v_name) not between 1 and 120 or length(v_memo)>1000 then raise exception 'Invalid cost input';end if;
  if v_mode not in ('none','fixed','variable') or (v_cat is not null and v_cat not in ('food','beverage','supplies','insurance','payroll_tax','utilities','fees','tax','other')) then raise exception 'Invalid cost category';end if;
  insert into public.expense_entries(store_id,date,description,amount,category,memo) values(p_store_id,v_date,v_name,v_amount,v_cat,v_memo) returning id into e_id;
  if v_mode<>'none' then
   if exists(select 1 from public.recurring_cost_templates where store_id=p_store_id and active and name=v_name) then raise exception 'Recurring item already registered';end if;
   insert into public.recurring_cost_templates(store_id,name,category,mode,amount,start_month)
   values(p_store_id,v_name,v_cat,v_mode,case when v_mode='fixed' then v_amount end,to_char(first_day+interval '1 month','YYYY-MM'));
  end if;
  insert into private.monthly_cost_requests values(p_store_id,request,p_payload||jsonb_build_object('month_key',p_month_key));
 elsif p_action='link' then
  e_id:=nullif(p_payload->>'expense_id','')::uuid;f_id:=nullif(p_payload->>'fixed_id','')::uuid;
  if (e_id is null)=(f_id is null) then raise exception 'Choose one existing entry';end if;
  if e_id is not null and not exists(select 1 from public.expense_entries where id=e_id and store_id=p_store_id and date between first_day and last_day) then raise exception 'Expense scope mismatch';end if;
  if f_id is not null and not exists(select 1 from public.fixed_expenses where id=f_id and store_id=p_store_id and month_key=p_month_key) then raise exception 'Fixed scope mismatch';end if;
 end if;
 if p_action in ('add','link','skip') then
  if key is not null then
   insert into public.monthly_cost_checks(store_id,month_key,item_key,status,expense_id,fixed_id)
   values(p_store_id,p_month_key,key,case when p_action='skip' then 'not_applicable' else 'linked' end,e_id,f_id)
   on conflict(store_id,month_key,item_key) do update set status=excluded.status,expense_id=excluded.expense_id,fixed_id=excluded.fixed_id,updated_at=now();
  end if;
  update public.monthly_cost_reviews set completed_at=null,completed_by=null,remind_after=null where store_id=p_store_id and month_key=p_month_key;
 elsif p_action='defer' then
  v_date:=(p_payload->>'remind_after')::date;
  if v_date is null or v_date<=today or v_date>today+7 then raise exception 'Choose a reminder within seven days';end if;
  update public.monthly_cost_reviews set completed_at=null,completed_by=null,remind_after=v_date where store_id=p_store_id and month_key=p_month_key;
 elsif p_action='stop_template' then
  update public.recurring_cost_templates set active=false where id=(p_payload->>'template_id')::uuid and store_id=p_store_id;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('key',c.item_key,'status',case when c.status='not_applicable' then c.status when exists(select 1 from public.expense_entries e where e.id=c.expense_id and e.store_id=p_store_id and e.date between first_day and last_day) or exists(select 1 from public.fixed_expenses f where f.id=c.fixed_id and f.store_id=p_store_id and f.month_key=p_month_key) then 'linked' else 'pending' end,'expense_id',c.expense_id,'fixed_id',c.fixed_id)),'[]') into checks from public.monthly_cost_checks c where c.store_id=p_store_id and c.month_key=p_month_key;
 select coalesce(jsonb_agg(to_jsonb(t) order by t.name),'[]') into templates from public.recurring_cost_templates t where t.store_id=p_store_id and t.active;
 if p_action='complete' then
  if exists(select 1 from (select unnest(array['electricity','water','gas']) key union all select t.id::text from public.recurring_cost_templates t where t.store_id=p_store_id and t.active and t.mode='variable' and t.start_month<=p_month_key) required
    where not exists(select 1 from jsonb_array_elements(checks) c where c->>'key'=required.key and c->>'status' in ('linked','not_applicable'))) then raise exception 'Review remaining costs';end if;
  update public.monthly_cost_reviews set completed_at=now(),completed_by=auth.uid(),remind_after=null where store_id=p_store_id and month_key=p_month_key;
 end if;
 return jsonb_build_object('checks',checks,'templates',templates,'review',coalesce((select to_jsonb(r)-'completed_by' from public.monthly_cost_reviews r where r.store_id=p_store_id and r.month_key=p_month_key),'{}'));
end $$;
create function public.manee_cost_review(p_store_id uuid,p_month_key text,p_action text default 'read',p_payload jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$select private.manee_cost_review(p_store_id,p_month_key,p_action,p_payload)$$;
revoke all on function private.manee_cost_review(uuid,text,text,jsonb),public.manee_cost_review(uuid,text,text,jsonb) from public,anon;
grant execute on function private.manee_cost_review(uuid,text,text,jsonb),public.manee_cost_review(uuid,text,text,jsonb) to authenticated;

-- Enrich owner/manager exports without expanding the franchise financial endpoint.
create function private.manee_report_preview(p_store_id uuid,p_month_key text) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare r jsonb;begin
 perform private.assert_cost_access(p_store_id,p_month_key);
 r:=private.manee_financial_report(p_store_id,p_month_key);
 r:=r||jsonb_build_object('expenses',(select coalesce(jsonb_agg(jsonb_build_object('date',e.date,'description',private.financial_label(p_store_id,e.description),'memo',private.financial_label(p_store_id,e.memo),'category',e.category,'amount',e.amount) order by e.date,e.id),'[]') from public.expense_entries e where e.store_id=p_store_id and e.date>=to_date(p_month_key||'-01','YYYY-MM-DD') and e.date<(to_date(p_month_key||'-01','YYYY-MM-DD')+interval '1 month')),
 'cost_review_complete',exists(select 1 from public.monthly_cost_reviews where store_id=p_store_id and month_key=p_month_key and completed_at is not null));
 return jsonb_build_object('status','provisional','month_key',p_month_key,'snapshot',r,'closed_at',r->>'generated_at');
end $$;
create function public.manee_report_preview(p_store_id uuid,p_month_key text) returns jsonb language sql stable security invoker set search_path='' as $$select private.manee_report_preview(p_store_id,p_month_key)$$;
revoke all on function private.manee_report_preview(uuid,text),public.manee_report_preview(uuid,text) from public,anon;
grant execute on function private.manee_report_preview(uuid,text),public.manee_report_preview(uuid,text) to authenticated;
-- Preserve all existing closing gates and idempotency; only enrich new snapshots.
do $$declare definition text;begin
 definition:=pg_get_functiondef('private.manee_close_month(uuid,text,uuid,text)'::regprocedure);
 if position('r:=public.manee_financial_report(p_store_id,p_month_key);' in definition)=0 then raise exception 'Closing source changed; review required';end if;
 definition:=replace(definition,'r:=public.manee_financial_report(p_store_id,p_month_key);','r:=(private.manee_report_preview(p_store_id,p_month_key))->''snapshot'';');
 execute definition;
end $$;

create function private.manee_bind_owner_push(p_endpoint text,p_store_id uuid) returns void
language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null or not private.is_live_manee_session() or not private.has_store_membership(p_store_id,array['owner']) then raise exception 'Owner access denied' using errcode='42501';end if;
 update public.push_subscriptions set user_id=auth.uid(),store_id=p_store_id,role='storeOwner',crew_id=null,is_manager=true where endpoint=p_endpoint and (user_id=auth.uid() or (user_id is null and store_id=p_store_id and role='storeOwner'));
end $$;
create function public.manee_bind_owner_push(p_endpoint text,p_store_id uuid) returns void language sql security invoker set search_path='' as $$select private.manee_bind_owner_push(p_endpoint,p_store_id)$$;
revoke all on function private.manee_bind_owner_push(text,uuid),public.manee_bind_owner_push(text,uuid) from public,anon;
grant execute on function private.manee_bind_owner_push(text,uuid),public.manee_bind_owner_push(text,uuid) to authenticated;

-- Service-only queue claim: one notification per device/store/day, no raw credentials to clients.
create function public.manee_claim_cost_reminders() returns jsonb
language plpgsql security definer set search_path='' as $$
declare today date:=(now() at time zone 'Asia/Seoul')::date;month text:=to_char(now() at time zone 'Asia/Seoul','YYYY-MM');last_day date;candidate record;claimed integer;result jsonb:='[]';begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service access required' using errcode='42501';end if;
 last_day:=(date_trunc('month',today)+interval '1 month - 1 day')::date;
 for candidate in
  select distinct s.id store_id,s.name,sub.id subscription_id,sub.endpoint,sub.p256dh,sub.auth,due.month_key from public.stores s
  join public.store_memberships m on m.store_id=s.id and m.role='owner' and m.status='active'
  join public.profiles profile on profile.user_id=m.user_id and profile.status='active'
  join auth.users owner_user on owner_user.id=m.user_id and (owner_user.banned_until is null or owner_user.banned_until<=now())
  join public.push_subscriptions sub on sub.user_id=m.user_id and sub.role='storeOwner'
  cross join lateral (select month month_key where today in (last_day-7,last_day-3,last_day) union select r.month_key from public.monthly_cost_reviews r where r.store_id=s.id and r.remind_after=today) due
  left join public.monthly_cost_reviews review on review.store_id=s.id and review.month_key=due.month_key
  where s.archived_at is null and review.completed_at is null
  and ((due.month_key=month and review.remind_after is null and today in (last_day-7,last_day-3,last_day)) or review.remind_after=today)
  and exists(select 1 from public.sales_reports sr where sr.store_id=s.id and sr.date>=to_date(due.month_key||'-01','YYYY-MM-DD') and sr.date<(to_date(due.month_key||'-01','YYYY-MM-DD')+interval '1 month') and sr.date<=today)
 loop
  insert into private.monthly_cost_push_deliveries(store_id,month_key,subscription_id,send_date)
  values(candidate.store_id,candidate.month_key,candidate.subscription_id,today) on conflict do nothing;
  get diagnostics claimed=row_count;
  if claimed=1 then result:=result||jsonb_build_array(to_jsonb(candidate)||jsonb_build_object('month_key',candidate.month_key,'send_date',today));end if;
 end loop;
 return result;
end $$;
revoke all on function public.manee_claim_cost_reminders() from public,anon,authenticated;
grant execute on function public.manee_claim_cost_reminders() to service_role;
create function public.manee_finish_cost_reminder(p_store_id uuid,p_month_key text,p_subscription_id bigint,p_send_date date,p_status text) returns void
language plpgsql security definer set search_path='' as $$begin
 if coalesce(auth.role(),'')<>'service_role' or p_status not in ('sent','failed','expired') then raise exception 'Service access required' using errcode='42501';end if;
 update private.monthly_cost_push_deliveries set status=p_status where store_id=p_store_id and month_key=p_month_key and subscription_id=p_subscription_id and send_date=p_send_date;
 if p_status='expired' then delete from public.push_subscriptions where id=p_subscription_id;end if;
end $$;
revoke all on function public.manee_finish_cost_reminder(uuid,text,bigint,date,text) from public,anon,authenticated;
grant execute on function public.manee_finish_cost_reminder(uuid,text,bigint,date,text) to service_role;

-- Authenticated clients cannot attach another user's identity to a device.
create function private.guard_push_owner_identity() returns trigger language plpgsql security definer set search_path='' as $$begin
 if auth.role()='authenticated' and new.user_id is not null and
  (new.user_id<>auth.uid() or new.role<>'storeOwner' or not private.is_live_manee_session() or not private.has_store_membership(new.store_id,array['owner'])) then
  raise exception 'Push identity mismatch' using errcode='42501';
 end if;
 return new;
end $$;
revoke all on function private.guard_push_owner_identity() from public,anon,authenticated;
create trigger guard_push_owner_identity before insert or update on public.push_subscriptions for each row execute function private.guard_push_owner_identity();

-- A changed ledger must be checked again; this never edits its financial rows.
create function private.invalidate_cost_review() returns trigger language plpgsql security definer set search_path='' as $$begin
 if tg_op<>'INSERT' then
  update public.monthly_cost_reviews set completed_at=null,completed_by=null where store_id=old.store_id and month_key=coalesce(to_jsonb(old)->>'month_key',left(to_jsonb(old)->>'date',7));
 end if;
 if tg_op<>'DELETE' then
  update public.monthly_cost_reviews set completed_at=null,completed_by=null where store_id=new.store_id and month_key=coalesce(to_jsonb(new)->>'month_key',left(to_jsonb(new)->>'date',7));
 end if;
 return null;
end $$;
revoke all on function private.invalidate_cost_review() from public,anon,authenticated;
create trigger expense_invalidates_cost_review after insert or update or delete on public.expense_entries for each row execute function private.invalidate_cost_review();
create trigger fixed_invalidates_cost_review after insert or update or delete on public.fixed_expenses for each row execute function private.invalidate_cost_review();
-- Service RPCs also use exposed invoker wrappers and unexposed definer cores.
alter function public.manee_claim_cost_reminders() set schema private;
alter function public.manee_finish_cost_reminder(uuid,text,bigint,date,text) set schema private;
create function public.manee_claim_cost_reminders() returns jsonb language sql security invoker set search_path='' as $$select private.manee_claim_cost_reminders()$$;
create function public.manee_finish_cost_reminder(p_store_id uuid,p_month_key text,p_subscription_id bigint,p_send_date date,p_status text) returns void language sql security invoker set search_path='' as $$select private.manee_finish_cost_reminder(p_store_id,p_month_key,p_subscription_id,p_send_date,p_status)$$;
revoke all on function public.manee_claim_cost_reminders(),public.manee_finish_cost_reminder(uuid,text,bigint,date,text) from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function public.manee_claim_cost_reminders(),public.manee_finish_cost_reminder(uuid,text,bigint,date,text) to service_role;
notify pgrst,'reload schema';


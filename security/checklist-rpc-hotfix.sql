-- Hotfix: manee_checklist RPC was never deployed to production, so the
-- checklist feature is completely broken there (MANEE_STAFF_AUTH_ENABLED
-- routes all checklist actions through this RPC, which doesn't exist).
-- This is extracted verbatim from security/store-permissions.sql (the
-- Phase C permission-lockdown migration) WITHOUT the rest of that file:
-- no legacy "allow all" policy drops, no new RLS policies, no guard
-- triggers, no RPC-wrapper migration for other functions. All of this
-- function's dependencies already exist in production with matching
-- signatures/columns, verified via read-only queries before writing this.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Checklist writes share a store lock. A single checkbox never replaces another
-- employee's whole checklist; close totals and timestamps come from the server.
create function private.manee_checklist(p_action text,p_store_id uuid,p_date date,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  st public.stores%rowtype; manager boolean; business_date date; item text;
  total_count int; done_count int; result jsonb; tab_entry record; category jsonb; entry jsonb;
begin
  if auth.uid() is null or not private.is_live_manee_session() then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into st from public.stores where id=p_store_id and archived_at is null for update;
  if not found or not private.has_store_membership(p_store_id,null) then raise exception 'Membership required' using errcode='42501'; end if;
  manager:=private.can_manage_store(p_store_id);
  business_date:=((now() at time zone 'Asia/Seoul')-make_interval(hours=>coalesce(st.business_day_cutoff_hour,6)))::date;
  if p_date is null or (not manager and p_date<>business_date) then raise exception 'Only today can be changed' using errcode='42501'; end if;
  if p_action in ('templates','initialize') then
    if not manager then raise exception 'Manager required' using errcode='42501'; end if;
    if p_action='initialize' and exists(select 1 from public.checklist_templates where store_id=p_store_id) then
      return jsonb_build_object('ok',true); end if;
    if jsonb_typeof(p_payload->'items') is distinct from 'object' or octet_length(p_payload::text)>200000 then raise exception 'Invalid checklist' using errcode='22023'; end if;
    for tab_entry in select key,value from jsonb_each(p_payload->'items') loop
      if tab_entry.key not in ('morning','afternoon','routine') or jsonb_typeof(tab_entry.value)<>'array' then raise exception 'Invalid checklist' using errcode='22023'; end if;
      for category in select value from jsonb_array_elements(tab_entry.value) loop
        if jsonb_typeof(category->'items') is distinct from 'array' or jsonb_typeof(category->'id') is distinct from 'string'
          or jsonb_typeof(category->'name') is distinct from 'string' then raise exception 'Invalid category' using errcode='22023'; end if;
        for entry in select value from jsonb_array_elements(category->'items') loop
          if jsonb_typeof(entry->'id') is distinct from 'string' or length(entry->>'id') not between 1 and 120
            or jsonb_typeof(entry->'label') is distinct from 'string' or length(entry->>'label')>1000 then raise exception 'Invalid item' using errcode='22023'; end if;
        end loop;
      end loop;
      insert into public.checklist_templates(store_id,tab,data) values(p_store_id,tab_entry.key,tab_entry.value)
        on conflict(store_id,tab) do update set data=excluded.data;
    end loop;
  elsif p_action='reopen' then
    if not manager then raise exception 'Manager required' using errcode='42501'; end if;
    delete from public.checklist_log where store_id=p_store_id and date=p_date;
  elsif p_action in ('check','reset','close') then
    if exists(select 1 from public.checklist_log where store_id=p_store_id and date=p_date) then
      if p_action<>'close' then raise exception 'Checklist already closed' using errcode='55000'; end if;
    elsif p_action='reset' then
      if not manager then raise exception 'Manager required' using errcode='42501'; end if;
      delete from public.checklist_checks where store_id=p_store_id and date=p_date;
    elsif p_action='check' then
      item:=p_payload->>'item_id';
      if item is null or not exists(select 1 from public.checklist_templates t,
        lateral jsonb_array_elements(t.data) cat,lateral jsonb_array_elements(cat->'items') it
        where t.store_id=p_store_id and it->>'id'=item) then raise exception 'Unknown checklist item' using errcode='22023'; end if;
      if jsonb_typeof(p_payload->'checked') is distinct from 'boolean' then raise exception 'Invalid checkbox' using errcode='22023'; end if;
      if (p_payload->>'checked')::boolean then
        insert into public.checklist_checks(store_id,date,item_id,checked) values(p_store_id,p_date,item,true)
          on conflict(store_id,date,item_id) do update set checked=true;
      else delete from public.checklist_checks where store_id=p_store_id and date=p_date and item_id=item; end if;
    else
      select count(distinct it->>'id'),count(distinct it->>'id') filter(where exists(select 1 from public.checklist_checks c
        where c.store_id=p_store_id and c.date=p_date and c.item_id=it->>'id' and c.checked))
        into total_count,done_count from public.checklist_templates t,lateral jsonb_array_elements(t.data) cat,
        lateral jsonb_array_elements(cat->'items') it where t.store_id=p_store_id;
      insert into public.checklist_log(store_id,date,done,total,closed_at) values(p_store_id,p_date,done_count,total_count,clock_timestamp());
    end if;
  else raise exception 'Unknown action' using errcode='22023'; end if;
  return jsonb_build_object('ok',true,'checks',coalesce((select jsonb_object_agg(item_id,true) from public.checklist_checks where store_id=p_store_id and date=p_date and checked),'{}'::jsonb),
    'log',(select jsonb_build_object('done',done,'total',total,'closedAt',extract(epoch from closed_at)*1000) from public.checklist_log where store_id=p_store_id and date=p_date));
end;
$$;
create function public.manee_checklist(p_action text,p_store_id uuid,p_date date,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.manee_checklist(p_action,p_store_id,p_date,p_payload); $$;
revoke all on function private.manee_checklist(text,uuid,date,jsonb),public.manee_checklist(text,uuid,date,jsonb) from public,anon;
grant execute on function private.manee_checklist(text,uuid,date,jsonb),public.manee_checklist(text,uuid,date,jsonb) to authenticated;
commit;

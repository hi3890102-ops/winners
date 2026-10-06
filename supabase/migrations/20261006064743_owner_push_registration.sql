-- The subscription table stays server-managed: no client SELECT/DML grants.
-- The private cores authorize the current live owner, never a client-supplied
-- identity, and return only a confirmation. Public wrappers remain invokers.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.manee_register_owner_push(
 p_store_id uuid, p_endpoint text, p_p256dh text, p_auth text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare saved_id bigint;
begin
 if auth.uid() is null or not private.is_live_manee_session()
    or not private.has_store_membership(p_store_id, array['owner'])
    or not exists(select 1 from auth.users u where u.id=auth.uid()
      and (u.banned_until is null or u.banned_until<=now())) then
  raise exception 'Owner access denied' using errcode='42501';
 end if;
 -- Restrict outbound push destinations to browser push providers, not arbitrary
 -- URLs that could make the scheduled sender access private/internal services.
 if p_endpoint is null or length(p_endpoint)>4096 or p_endpoint !~
    '^https://(fcm\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)*notify\.windows\.com)/[^[:space:]#]+$'
    or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{87}=?$'
    or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{22}={0,2}$' then
  raise exception 'Invalid push subscription' using errcode='22023';
 end if;

 insert into public.push_subscriptions as existing
  (store_id,crew_id,role,is_manager,user_id,endpoint,p256dh,auth)
 values(p_store_id,null,'storeOwner',true,auth.uid(),p_endpoint,p_p256dh,p_auth)
 on conflict(endpoint) do update set
  store_id=excluded.store_id,crew_id=null,role='storeOwner',is_manager=true,
  user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth
 where existing.user_id=auth.uid()
    or (existing.user_id is null and existing.p256dh=excluded.p256dh
        and existing.auth=excluded.auth)
 returning id into saved_id;
 -- Unbound legacy devices can be recovered only with their full device keys.
 -- A subscription bound to another account must be replaced in that browser.
 if saved_id is null then
  raise exception 'Push subscription unavailable' using errcode='23505';
 end if;
 return true;
end $$;

create function private.manee_unregister_owner_push(
 p_endpoint text, p_p256dh text, p_auth text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is null or not private.is_live_manee_session()
    or not exists(select 1 from auth.users u where u.id=auth.uid()
      and (u.banned_until is null or u.banned_until<=now())) then
  raise exception 'Authenticated access required' using errcode='42501';
 end if;
 delete from public.push_subscriptions s
 where s.user_id=auth.uid() and s.role='storeOwner'
   and s.endpoint=p_endpoint and s.p256dh=p_p256dh and s.auth=p_auth;
 return true;
end $$;

create function public.manee_register_owner_push(
 p_store_id uuid, p_endpoint text, p_p256dh text, p_auth text
) returns boolean language sql security invoker set search_path='' as $$
 select private.manee_register_owner_push(p_store_id,p_endpoint,p_p256dh,p_auth)
$$;
create function public.manee_unregister_owner_push(
 p_endpoint text, p_p256dh text, p_auth text
) returns boolean language sql security invoker set search_path='' as $$
 select private.manee_unregister_owner_push(p_endpoint,p_p256dh,p_auth)
$$;
revoke all on function private.manee_register_owner_push(uuid,text,text,text),
 private.manee_unregister_owner_push(text,text,text),
 public.manee_register_owner_push(uuid,text,text,text),
 public.manee_unregister_owner_push(text,text,text) from public,anon;
grant execute on function private.manee_register_owner_push(uuid,text,text,text),
 private.manee_unregister_owner_push(text,text,text),
 public.manee_register_owner_push(uuid,text,text,text),
 public.manee_unregister_owner_push(text,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;

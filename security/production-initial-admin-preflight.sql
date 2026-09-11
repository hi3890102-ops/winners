-- READ ONLY. Identify production super-admin candidates.
-- Do not promote anyone without explicit operator approval.
select p.user_id,p.username,p.display_name,
       count(*) filter(where sm.role='owner' and sm.status='active') as active_owner_memberships,
       jsonb_agg(jsonb_build_object('store_id',s.id,'store_name',s.name) order by s.name)
         filter(where sm.role='owner' and sm.status='active') as owner_stores
from public.profiles p
join public.store_memberships sm on sm.user_id=p.user_id
join public.stores s on s.id=sm.store_id and s.archived_at is null
where p.status='active'
group by p.user_id,p.username,p.display_name
order by active_owner_memberships desc,p.username;

select user_id,role,status,created_at,revoked_at
from public.platform_admins
order by created_at;

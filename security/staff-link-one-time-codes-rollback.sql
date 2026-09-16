-- Emergency code-format rollback only. Does not undo memberships or business data.
-- Consumed one-time codes (join_code is null) stay consumed and are never restored.
begin;
update public.crew c
set join_code=b.old_join_code
from private.staff_link_code_rollout_backup b
where c.id=b.crew_id and c.join_code is not null and b.old_join_code is not null;
commit;

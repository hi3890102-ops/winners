-- Applied directly to production and staging on 2026-09-17.
--
-- Bug report: "무료체험 이용 현황"에서 6명 전원이 무제한체험인데
-- "40일 체험 진행중"으로 잘못 집계됨.
--
-- Root cause: public.profiles only had profiles_select_self (self-row
-- SELECT only). manee-admin's loadHqDashboardStats() does
-- db.from('profiles').select(...).in('username', ownerUsernames) as the
-- HQ admin -- whose own auth.uid() never matches any owner's user_id --
-- so RLS silently filtered every row out. Not a PostgREST error (200,
-- empty array), so it was invisible except as wrong downstream numbers:
-- profileMap ended up empty, so every owner fell back to
-- unlimitedTrial=false, billingStatus='trial', signupDate=null. This
-- also means 가입 추이/금일 신규가입 (both derived from profiles.created_at)
-- have likely shown 0 the entire time, not just today -- same root cause,
-- caught only now because someone actually checked the trial-tier count
-- against known reality.
--
-- Fix: HQ platform admins can read all profiles (needed for the owner
-- roster on their own dashboard). Column-level grants already covered
-- every column this query selects -- verified via information_schema.
-- column_privileges -- so only the missing row policy was the blocker.
create policy profiles_admin_read on public.profiles
  for select to authenticated
  using (private.has_platform_role(array['super_admin','admin','support','read_only']::text[]));

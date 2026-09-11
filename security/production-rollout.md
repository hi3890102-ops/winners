# Production security-v2 rollout

Do not merge `security-v2` before this checklist is complete.

## Goal

Move the existing production app to Supabase Auth for owners/staff/admins while preserving all existing store, crew, attendance, sales, expense, reservation and checklist records.

## Current production baseline (checked 2026-09-12 KST)

- 12 active stores
- 120 crew rows
- 534 attendance rows
- 10 reservations
- 15 owner request rows, 12 approved
- 3 approved owner rows already migrated to Auth; 9 remain on progressive migration
- 3 active owner memberships covering 3 stores
- 0 active staff/manager memberships
- 120 valid six-digit crew join codes, 0 duplicates
- 0 crews with more than one open attendance row
- 0 active platform administrators
- `manee-signup` and `manee-login` are active in production
- staff portal, support recovery tables/RPC and `manee-account-recovery` are not yet in production

## Important blockers before cutover

1. Create/confirm the initial production `super_admin`. Production currently has no active platform administrator.
2. Use the additive production staff foundation, not the staging `staff-auth.sql`. The staging file also removes legacy public policies and would disrupt the current production UI before cutover.
3. Use `security/support-password-recovery-production.sql`. The staging migration assumes `private.account_recovery_keys` exists, but production does not have that table.
4. Deploy the production-specific `manee-account-recovery` Edge Function source. The staging v2 bundle intentionally rejects the production project URL.
5. Production user/admin builds must enable the new Auth flows only after the backend foundation is ready.
6. The files named `*-live-rollback.sql` in this branch are validation scripts that finish with `ROLLBACK`; they are not production rollback migrations.

## Recommended cutover order

### Phase A — additive backend foundation, no legacy permission removal

1. Run `security/production-preflight.sql` read-only and save the result.
2. Take a Supabase database backup/snapshot.
3. Record the current production `main` SHAs for both repositories and current Netlify production deploy IDs.
4. Apply `security/staff-auth-production-foundation.sql`. This adds staff Auth tables/functions and the live-session helper but deliberately keeps the current legacy browser policies/grants.
5. Apply `security/support-password-recovery-production.sql`.
6. Deploy `manee-staff-signup` and `supabase/functions/manee-account-recovery-production/index.ts` to the production project under the `manee-account-recovery` function name.
7. Explicitly choose and assign the initial verified `super_admin`; use `security/production-initial-admin-preflight.sql` to identify the candidate first.
8. Confirm `manee-login`/`manee-signup` remain healthy and verify the newly added RPCs/functions exist.

### Phase B — application cutover

1. Merge/deploy the user app production build. The production build now activates staff/owner security-v2 Auth while previews remain on staging.
2. Merge/deploy the administrator app production build. Its environment-aware build selects production Supabase and activates administrator Auth only for the production build.
3. Immediately verify:
   - existing migrated owner login
   - one legacy owner progressive migration login
   - staff signup and store-link request
   - owner approval of the staff link
   - staff can see only their intended application scope
   - password reset request -> six-digit code -> new password -> re-login
   - administrator login and recovery portal

During Phase B the old permissive RLS policies still exist, so complete the smoke test quickly and proceed to Phase C. This short window does not make production more permissive than its pre-cutover state, but the new role restrictions are not fully enforced until Phase C.

### Phase C — permission lockdown

Only after Phase B succeeds, apply `security/store-permissions.sql` to remove legacy anonymous/public table access and enforce store-scoped RLS.

Then re-check:

- anonymous table access = 0
- unconditional `allow all - ...` policies = 0
- staff cannot manage store settings
- staff cannot read/write/delete financial data unless explicitly allowed by role/sales access
- owner can manage its own store only
- platform administrator sees intended scope
- old/expired Auth sessions are rejected

## Rollback strategy

Prefer application rollback before destructive database rollback.

### If Phase A fails

- Do not deploy the new production UI.
- Existing production app remains on the old flow because the production foundation is additive.
- Leave additive objects in place while investigating unless there is a specific reason to remove them; never delete existing business records or Auth-migrated owners.

### If Phase B fails before permission lockdown

- Roll back both Netlify production deploys to the recorded pre-cutover deploys.
- Leave additive Auth tables/functions in place; they do not require deleting existing records.
- Disable/stop using newly deployed recovery/staff Edge Functions while investigating.

### If Phase C fails

- Roll back both applications to the recorded pre-cutover deploys and run `security/production-emergency-permission-rollback.sql` only as the emergency permission restore.
- Do not delete profiles, memberships, staff link audit rows, password reset audit rows, crew, attendance, sales, expenses, reservations or checklist history.
- Never roll back by deleting newly migrated Auth users. Existing identities must be preserved and fixed forward.

## Final merge gate

Merge `security-v2` only when all of the following are true:

- production preflight is green
- database backup exists
- additive production staff foundation is reviewed
- production-safe support recovery SQL is reviewed
- production-capable recovery Edge Function is ready
- initial super admin is explicitly chosen and verified
- user and administrator production builds are ready to switch together
- rollback deploy IDs and pre-lockdown policy/grant snapshot are saved

After merge, keep the previous production deploy available for immediate rollback until the full login, staff link, attendance, recovery and permission smoke test passes.

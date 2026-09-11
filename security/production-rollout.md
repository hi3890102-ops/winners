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
2. Use a production-safe support recovery migration. The staging migration assumes `private.account_recovery_keys` exists, but production does not have that table.
3. Deploy a production-capable `manee-account-recovery` Edge Function. The staging v2 bundle intentionally rejects the production project URL.
4. Production user/admin builds must enable the new Auth flows only after the backend foundation is ready.
5. The files named `*-live-rollback.sql` in this branch are validation scripts that finish with `ROLLBACK`; they are not production rollback migrations.

## Recommended cutover order

### Phase A — no user-visible change

1. Run `security/production-preflight.sql` read-only and save the result.
2. Take a Supabase database backup/snapshot.
3. Record the current production `main` SHAs for both repositories and current Netlify production deploy IDs.
4. Apply the staff Auth foundation (`security/staff-auth.sql`) after production review.
5. Apply the production-safe support recovery foundation.
6. Deploy `manee-staff-signup` and the production-capable `manee-account-recovery` Edge Function.
7. Confirm `manee-login`/`manee-signup` remain healthy.

### Phase B — application cutover

1. Deploy the user app production build with staff/owner Auth enabled.
2. Deploy the administrator app production build with administrator Auth enabled.
3. Immediately verify:
   - existing migrated owner login
   - one legacy owner progressive migration login
   - staff signup and store-link request
   - owner approval of the staff link
   - staff can see only their store and own attendance identity
   - password reset request -> six-digit code -> new password -> re-login
   - administrator login and recovery portal

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
- Existing production app remains on the old flow.
- Remove only newly created support/staff objects if required after investigation; do not delete existing business records or Auth-migrated owners.

### If Phase B fails before permission lockdown

- Roll back both Netlify production deploys to the recorded pre-cutover deploys.
- Leave additive Auth tables/functions in place; they do not require deleting existing records.
- Disable/stop using newly deployed recovery/staff Edge Functions while investigating.

### If Phase C fails

- Roll back the application to the recorded pre-cutover deploy only together with restoring the pre-cutover grants/policies captured before Phase C.
- Do not delete profiles, memberships, staff link audit rows, password reset audit rows, crew, attendance, sales, expenses, reservations or checklist history.
- Never roll back by deleting newly migrated Auth users. Existing identities must be preserved and remapped/fixed forward.

## Final merge gate

Merge `security-v2` only when all of the following are true:

- production preflight is green
- database backup exists
- production-safe support recovery SQL is reviewed
- production-capable recovery Edge Function is ready
- initial super admin is explicitly chosen and verified
- user and administrator production builds are ready to switch together
- rollback deploy IDs and pre-lockdown policy/grant snapshot are saved

After merge, keep the previous production deploy available for immediate rollback until the full login, staff link, attendance, recovery and permission smoke test passes.

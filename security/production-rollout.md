# Production security-v2 rollout

Do not merge `security-v2` before backend preparation and separate production approval.

## Goal

Move owners/staff/admins to Supabase Auth while preserving stores, employee identities, attendance, payroll, sales, expenses, reservations and checklist records.

## Latest employee connection decision (2026-09-16)

A store receives one automatic eight-character reusable code. Employees sign up independently, enter only the store code, confirm the store name, and request membership. The owner selects the existing crew record and approves. The code does not grant business-data access. No employee-name or store-name matching is used to assign a crew record automatically.

`security/store-staff-link-code.sql` supersedes the previous per-employee one-time code rollout. Do NOT run `staff-link-one-time-codes.sql` after the new store-code migration; doing so would reinstall an obsolete portal. Existing six-digit `crew.join_code` values can remain untouched for production rollback compatibility; security-v2 no longer uses them for joining.

Codes are reserved atomically in private history, unique across stores, and automatically assigned to existing/new stores. Retired codes cannot be reused. Owner rotation blocks new requests using the old code but preserves existing memberships and already-pending requests. The owner can reject unwanted pending requests separately.

## Historical production baseline (2026-09-12 KST; recheck before release)

- 12 active stores, 120 crew, 534 attendance rows, 10 reservations.
- 15 owner request rows, 12 approved; 3 approved owners migrated to Auth, 9 pending progressive migration.
- 3 active owner memberships, no active staff/manager memberships, no active platform administrator.
- 120 legacy six-digit employee codes without duplicates; no duplicate open attendance.
- Production has `manee-signup` and `manee-login`; the staff portal and account recovery backend were not yet deployed at that checkpoint.

## Phase A — additive backend preparation

1. Run `security/production-preflight.sql` read-only and save fresh results. Also check duplicate pending `(requester_user_id, store_id)` pairs if staff-link requests already exist. The new migration deliberately stops rather than deleting ambiguous historical requests.
2. Take a Supabase database backup/snapshot. Record production main SHAs and Netlify deploy IDs for both repositories.
3. Apply `security/staff-auth-production-foundation.sql`, NOT the staging staff-auth migration. The production foundation preserves legacy public policies/grants until cutover.
4. Apply `security/support-password-recovery-production.sql`, not the staging variant that assumes recovery-key tables exist.
5. Deploy `manee-staff-signup` and the production-specific recovery source at `supabase/functions/manee-account-recovery-production/index.ts` under the function name `manee-account-recovery`.
6. Explicitly select and verify the initial super_admin using `security/production-initial-admin-preflight.sql`; do not automatically promote an arbitrary account.
7. Verify old signup/login and newly added APIs remain healthy.

## Phase B — store codes, then application cutover

1. Apply `security/store-staff-link-code.sql` after the production foundation and before enabling the new UI. It adds store codes, backs existing stores with unique codes, and changes approval to require an owner-selected `crew_id`. It preserves crew.join_code, business records and memberships.
2. Check: every store has one code; no duplicate code; code-history and previous private portal are not callable/readable by anonymous or authenticated clients.
3. Deploy the user and administrator security-v2 applications with production environment selection. Previews must remain on staging.
4. Smoke-test migrated owner login, legacy owner progressive migration, staff signup, store-code preview/request, explicit crew selection/approval, staff login after approval, manager home after refresh, recovery request -> six-digit reset code -> new password -> normal login, and administrator login.
5. Verify code rotation leaves existing employees connected; confirm the old code cannot create a new request.

The previous permissive production RLS remains until Phase C. A successful code-only flow does not prove full production permission enforcement during that transition window. Complete the smoke test promptly and apply the final lockdown.

## Phase C — permission lockdown

After the application smoke test, apply `security/store-permissions.sql`. Recheck anonymous table access, unconditional legacy policies, cross-store access, owner-only settings, role/sales-scoped financial access, staff payroll isolation, expired/suspended/revoked sessions, and original attendance/history preservation.

Store-code joining adds no direct grant to employee payroll and must not reopen the previous private employee-code RPC. Recheck those restrictions after all migrations.

## Rollback

Prefer recorded Netlify application rollback and forward-fixing additive structures over deleting data.

- Phase A failure: stop before UI cutover; keep additive objects unless a reviewed repair requires otherwise.
- Phase B failure before lockdown: restore both recorded production deploys. The new store-code migration intentionally did not rewrite legacy crew codes. Retain new profiles/memberships/audit/history and investigate.
- Phase C failure: restore recorded applications and use `security/production-emergency-permission-rollback.sql` only for an approved emergency permission restore.
- `security/store-staff-link-code-rollback.sql` is a narrower rollback to the PREVIOUS SECURITY-V2 employee-code portal, NOT a complete rollback to production main. Pair it with the matching older v2 UI. It expires store-only pending requests, preserves business records/memberships, and never restores consumed codes. Reapply the latest store-code migration to roll forward.
- Files named `*-live-rollback.sql` are synthetic validation scripts ending in ROLLBACK, not production rollback migrations.

Never delete Auth-migrated owners, staff profiles, memberships, payroll, crew, attendance, sales or other business records as a rollback shortcut.

## Merge gate

Require fresh production preflight, backup, reviewed production foundation/recovery/store-code migrations, verified initial admin, ready production builds, recorded rollback deploy IDs, and explicit production approval. Test new joining end-to-end again after the final permission lockdown.

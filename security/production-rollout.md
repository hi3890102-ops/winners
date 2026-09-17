# Production security-v2 rollout

Do not merge `security-v2` before backend preparation and separate production approval.

## Goal

Move owners/staff/admins to Supabase Auth while preserving stores, employee identities, attendance, payroll, sales, expenses, reservations and checklist records.

## Latest employee connection decision (2026-09-16)

A store receives one automatic eight-character reusable code. Employees sign up independently, enter only the store code, confirm the store name, and request membership. The store code never grants business-data access by itself.

Owner approval now has two paths:

- **New employee (default):** no existing crew record is required. `security/store-staff-new-employee-approval.sql` creates a new crew record from the verified profile display name, with wage `0`, hourly wage type, default position `홀`, and the Seoul approval date as hire date, then links the Auth account. The owner completes payroll/position details afterward.
- **Existing employee conversion (temporary compatibility path):** the owner explicitly selects the old crew record and uses the existing `approve` action. The original payroll, attendance and other crew-linked history is preserved. This path can be hidden/removed after legacy staff have converted to username/password accounts.

No employee-name or store-name matching automatically chooses an existing crew record.

`security/store-staff-link-code.sql` supersedes the previous per-employee one-time code rollout. Apply `security/store-staff-new-employee-approval.sql` immediately after it. Do NOT run `staff-link-one-time-codes.sql` after the new store-code migration; doing so would reinstall an obsolete portal. Existing six-digit `crew.join_code` values can remain untouched for production rollback compatibility; security-v2 no longer uses them for joining.

Codes are reserved atomically in private history, unique across stores, and automatically assigned to existing/new stores. Retired codes cannot be reused. Owner rotation blocks new requests using the old code but preserves existing memberships and already-pending requests. The owner can reject unwanted pending requests separately.

## Historical production baseline (2026-09-12 KST; recheck before release)

- 12 active stores, 120 crew, 534 attendance rows, 10 reservations.
- 15 owner request rows, 12 approved; 3 approved owners migrated to Auth, 9 pending progressive migration.
- 3 active owner memberships, no active staff/manager memberships, no active platform administrator.
- 120 legacy six-digit employee codes without duplicates; no duplicate open attendance.
- Production has `manee-signup` and `manee-login`; the staff portal and account recovery backend were not yet deployed at that checkpoint.

## Phase A — additive backend preparation

1. Run `security/production-preflight.sql` read-only and save fresh results. Also check duplicate pending `(requester_user_id, store_id)` pairs if staff-link requests already exist. The new migration deliberately stops rather than deleting ambiguous historical requests.
2. Take a Supabase database backup/snapshot. Record production main SHAs and Netlify deploy IDs for both repositories. As of 2026-09-16 the org is on the Free plan with zero backups and no on-demand backup option — Supabase's own guidance for Free tier is a manual `supabase db dump`. Until the org upgrades (planned after incorporation), treat a fresh logical export of the critical tables as the minimum bar, not a substitute for a real backup.
3. `security/staff-auth-production-foundation.sql` overwrites the live `public.clock_in`/`public.clock_out` functions that staff use today, so apply it as two parts instead of one file:
   - `security/staff-auth-production-foundation-part1.sql` — everything except the clock functions (new tables, helper functions, `manee_staff_portal`, the one-open-attendance-per-crew index, `private.staff_clock`). Safe to apply anytime; nothing live calls the new code yet.
   - `security/staff-auth-production-foundation-part2-clock-deferred.sql` — wires `public.clock_in`/`public.clock_out` to the new `private.staff_clock`. Apply only when `select count(*) from public.attendance where check_out is null` is 0 or as close as the business realistically gets (well after closing), since anyone with an open attendance row at that moment hits the new logic on their next clock-out.
   Do NOT apply the original combined `staff-auth-production-foundation.sql` to production — use the two split files instead. NOT the staging staff-auth migration either. The production foundation preserves legacy public policies/grants until cutover.
4. Apply `security/support-password-recovery-production.sql`, not the staging variant that assumes recovery-key tables exist. Fully additive, no live functions overwritten — safe regardless of clock-in state.
5. Deploy `manee-staff-signup`, `manee-check-username` (added 2026-09-16 for the sign-up duplicate-ID check; reuses `is_manee_username_reserved` and `consume_auth_rate_limit`, no new migration needed, `verify_jwt` must be OFF), and the production-specific recovery source at `supabase/functions/manee-account-recovery-production/index.ts` under the function name `manee-account-recovery`.
6. Explicitly select and verify the initial super_admin using `security/production-initial-admin-preflight.sql`; do not automatically promote an arbitrary account.
7. Verify old signup/login and newly added APIs remain healthy.

## Phase B — store codes, approval paths, then application cutover

1. Apply `security/store-staff-link-code.sql` after the production foundation and before enabling the new UI. It adds store codes and store-level join requests while preserving `crew.join_code`, business records and memberships.
2. Apply `security/store-staff-new-employee-approval.sql`. This adds the new-employee approval path while retaining explicit existing-record conversion.
3. Check: every store has one code; no duplicate code; code-history and previous private portals are not callable/readable by anonymous or authenticated clients.
4. Deploy the user and administrator security-v2 applications with production environment selection. Previews must remain on staging.
5. Smoke-test migrated owner login, legacy owner progressive migration, staff signup, store-code preview/request, **new employee approval without existing crew selection**, **existing employee conversion with explicit crew selection**, staff login after approval, manager home after refresh, recovery request -> six-digit reset code -> new password -> normal login, and administrator login.
6. Verify new employee approval creates exactly one crew/membership on retries, existing conversion preserves old payroll/history, and code rotation leaves existing employees/pending requests intact while the old code cannot create a new request.

The previous permissive production RLS remains until Phase C. A successful code-only flow does not prove full production permission enforcement during that transition window. Complete the smoke test promptly and apply the final lockdown.

## Phase C — permission lockdown

After the application smoke test, apply `security/store-permissions.sql`. Recheck anonymous table access, unconditional legacy policies, cross-store access, owner-only settings, role/sales-scoped financial access, staff payroll isolation, expired/suspended/revoked sessions, and original attendance/history preservation.

**Status (2026-09-17):** the 15 tables `store-permissions.sql` fully covers (announcement_reads, announcements, attendance, checklist_checks/log/templates, crew, expense_entries, fixed_expenses, fixed_schedules, sales_report_photos, sales_reports, shifts, stores, vendors) are locked down on production — see `security/phase-c-core-tables-2026-09-17.sql` for the exact statements applied and why the full file wasn't run verbatim (three pieces were already live from other same-day fixes). franchises and reservations were also locked down the same day (`franchises-rls-lockdown.sql`, `reservations-push-subscriptions-rls-lockdown.sql`). Supabase's security advisor shows zero ERROR-level findings as of this pass.

**Update (same day):** `billing_settings`, `crew_pay_adjustments`, `tax_reminder_ack` are now locked down too — see `security/billing-pay-tax-rls-lockdown.sql`. Zero ERROR-level advisor findings on production after this.

**Still open, deliberately deferred:** `app_settings` and `owner_requests` still have their legacy "allow all" policy on both staging and production. Both are read/written pre-authentication by legacy login flows (client fetches `password_hash` directly to verify credentials before any Supabase Auth session exists) and need an RPC-based redesign, not a grant/policy swap. Do this as its own reviewed pass.

Store-code joining adds no direct grant to employee payroll and must not reopen the previous private employee-code or store-code implementation RPCs. Recheck those restrictions after all migrations.

## Rollback

Prefer recorded Netlify application rollback and forward-fixing additive structures over deleting data.

- Phase A failure: stop before UI cutover; keep additive objects unless a reviewed repair requires otherwise.
- Phase B failure before lockdown: restore both recorded production deploys. The store-code/new-employee migrations do not rewrite legacy six-digit crew codes. Retain newly created profiles/memberships/audit/history unless a reviewed corrective migration explicitly addresses them.
- Phase C failure: restore recorded applications and use `security/production-emergency-permission-rollback.sql` only for an approved emergency permission restore.
- `security/store-staff-link-code-rollback.sql` is a narrower rollback to the previous SECURITY-V2 employee-code portal, NOT a complete rollback to production main. Pair it with the matching older v2 UI. It expires store-only pending requests, preserves business records/memberships, and never restores consumed codes.
- Files named `*-live-rollback.sql` are synthetic validation scripts ending in ROLLBACK, not production rollback migrations.

Never delete Auth-migrated owners, staff profiles, memberships, payroll, crew, attendance, sales or other business records as a rollback shortcut.

## Merge gate

Require fresh production preflight, backup, reviewed production foundation/recovery/store-code/new-employee migrations, verified initial admin, ready production builds, recorded rollback deploy IDs, and explicit production approval. Test both new and existing employee joining end-to-end again after the final permission lockdown.

# Store data permissions — isolated staging

Migration `20260911130759` (`enforce_store_scoped_data_permissions`) was applied to `obpkzecgswnfuyhwvncd` on 2026-09-11. The existing `security-v2` user preview is the only deployment target. Production `main`, production database and the administrator deployment remain unchanged.

## Access model

| Data | Active employee | Employee with sales entry | Store owner / Auth manager |
|---|---|---|---|
| Stores and shared schedules | Linked store only | Same | Authorized stores only |
| Employee payroll / attendance | Self through existing RPCs and own attendance | Same | Authorized store management |
| Announcements | Read, acknowledge self | Same | Publish/manage; see acknowledgements |
| Reservations | Shared work within linked store | Same | Store work |
| Checklist | Current business-day checks and close | Same | Templates, history, reset and reopen |
| Sales reports / expenses | No access | Read, submit reports/expenses | Store financial access |
| Delete sales/expense records | No | No | Owner only (manager cannot delete these) |
| Vendors / fixed expenses | No | Read | Manage |
| Legacy passwords / shared PIN / push credentials | No browser access | No | No browser access |

Franchise/platform oversight continues to rely on the existing explicit server-side role helpers. No role was assigned to any real account. Auth manager promotion and administrator/franchise login UI remain separate releases. Legacy `crew.is_manager` is not Auth role evidence.

## Changes

- Revoked direct PUBLIC/anonymous table and sequence privileges across the 26 existing public tables. Existing service-only enrollment, username lookup and recovery APIs retain their intended access. No column-level ACLs existed before the migration.
- Removed **17 unconditional compatibility policies** and the `stores` archived-only read policy that bypassed membership checks when OR-combined with them. Read/update/insert/delete rules now match store, employee and financial authority.
- Tightened store updates to name, location, onboarding, manager-dashboard option and business-day cutoff. Browsers cannot rewrite ownership/franchise metadata. Browser updates cannot reassign existing employee/attendance/schedule IDs to another store or employee, including when the actor owns both stores.
- Reservation/report/announcement author labels and report submission times are supplied by the server for browser writes. Sales report employee attribution comes from current membership; a different store's crew ID is rejected. Announcement read time is server supplied, and employees cannot remove acknowledgement rows directly.
- Checklist writes use a private transaction with a public invoker RPC. Individual checks preserve other employees' checks. The store lock serializes changes against close/reopen. Closed checklists reject changes; staff cannot alter historical days or reopen/reset them. Close totals and timestamps are computed from stored data. Default initialization never overwrites an existing template. Template input structure is validated and rendered labels/IDs are escaped.
- Kept all seven existing attendance/directory RPC signatures while moving their privileged bodies to the unexposed private schema. Public wrappers are SECURITY INVOKER; their server identity/role checks remain intact.
- Active profile status now accompanies the existing actual-session check on every protected path.

## Frontend compatibility

User and administrator HTML continue to be generated from a single canonical source. This release enables the new user flow only in isolated staging; the administrator feature stays disabled.

Checklist changes now wait for server success. Reservation/announcement/expense/vendor/fixed-expense deletes, fixed-amount updates and announcement acknowledgement also validate the saved result before changing the screen. Errors and zero-row updates/deletes no longer display a false success on these paths. A late checklist response cannot overwrite the newly selected store. Template changes preserve the old screen when saving fails.

Employee financial entry does not expose owner-only delete controls. Default-template creation and automatic fixed-expense carry-forward require management authority. Existing owner account restore uses Auth memberships and does not need the legacy owner request table. Additional-store requests through that legacy table now show an availability message; the new verified administrator workflow must replace that path before release.

## Verification

**116 automated checks passed**: 29 existing environment/owner session tests, 44 database checks, 14 staff UI-function checks, 12 staff signup handler checks, 9 recovery handler checks, and 8 permission UI-function checks. Both generated HTML scripts compile, and the staging build selects the isolated backend with external integrations disabled.

The exact `store-permissions-live-rollback.sql` also passed on staging PostgreSQL. Synthetic identities/session rows test enrollment/approval, clock-in/out, recovery proof replay denial, expired-session denial, new-session restoration, revoke/reactivation, store-list isolation, legacy credential denial, checklist preservation/server totals and anonymous reservation denial. All synthetic rows were rolled back.

Preserved user data after validation: profiles **2**, stores **1**, crew **1**, attendance **0**, active staff links **1**, reservations **0**, checklist templates **3**. No actual password or recovery key was read or changed. The staging project has no Storage buckets; public-table permissions are not a production Storage audit.

Post-deployment checks:

- PUBLIC/anonymous public-table grants: **0**.
- Unconditional / archived-only public access policies: **0**.
- Public tables without RLS: **0**.
- Public SECURITY DEFINER functions executable by authenticated users: **0**.

Advisor findings: four intentional private RPC-only tables have RLS without direct-client policies. Leaked-password protection remains disabled. No paid settings were enabled.

## Limits and next steps

SQL-role tests use synthetic sessions, not actual JWT issuance or the HTTP password reset endpoint. Real device recovery/checklist/reservation tests, device GPS and independent-connection concurrency still need validation. A completed actual password recovery has not been observed.

Password recovery without a previously saved key, verified staff-record transfer, manager promotion, administrator/franchise Auth UI, the first verified platform-admin enrollment, and additional-store approval are still pending. Production rollout requires a separate coordinated review of all clients, database permissions, data migration, external integrations and user approval. Do not claim this staging cutover makes the entire SaaS production-ready.

Prefer a forward fix or temporary maintenance state. Do not restore public `allow all` policies, reconnect the preview to production, reactivate real memberships, or delete real records to roll back this release.

References checked before implementation: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [Supabase changelog](https://supabase.com/changelog).

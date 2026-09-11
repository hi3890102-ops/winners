# Employee Auth pilot — isolated staging

Applied 2026-09-11 to `obpkzecgswnfuyhwvncd` only. Production `main` and its Supabase project were not changed. The frontend feature is enabled for the user staging build. The administrator variant keeps its existing entry flow and is not deployed in this release.

## Behavior

Employees create their own username/password profile through `manee-staff-signup`; no store or owner role is created. The internal Auth email is not a user-facing recovery address. The existing `manee-login` endpoint accepts both owner and employee profiles.

A six-digit code creates a seven-day connection request. It never grants a membership or returns employee payroll, contact or identity details. An owner verifies the employee's actual account username before approving. The server uses the authenticated actor, stored request and existing crew row; request-supplied actor IDs and roles are not authorization inputs. The original `crew.id` and attendance remain in place.

Approval, rejection and revoke happen in transactions. Store/crew/request/membership lock order and unique constraints protect competing approvals. A pending request is unique per requester and crew, not per crew globally. Request attempts are limited per authenticated account, including failed guesses. Approval rechecks active profile, active owner membership, store, employment status, expiry and previous links. A revoked record may be reactivated for the same account after a fresh owner approval. Transferring a record to another account is not automatic. Approval/revoke audit events are kept in a private table.

Employees restore sessions through verified Auth and current membership. Cached legacy code identities are not accepted in this pilot. A legacy `is_manager` flag does not create Auth manager authority. The self-record endpoint returns only the employee's permitted record; coworker directory responses omit payroll and private fields.

The `crew`, `attendance` and `stores` allow-all policies were replaced in staging. Owners retain scoped crew and attendance management. Employees use server RPCs for clock-in/out and time confirmation, and submit time corrections for approval. Server timestamps and the configured store location are used; store location is required. Client GPS coordinates are inputs, not device attestation. Open attendance is unique per crew and the UI can close a record from a previous month.

## Manual check

1. Reopen the protected existing Netlify preview and confirm the test-environment banner.
2. Create a test owner, finish store/location setup, and register a synthetic employee under schedule → staff management. Note the employee's six-digit participation code.
3. In a separate browser/private window, choose employee login → create employee account. Enter the code under my store connections. The account must remain pending without showing employee payroll/history.
4. As the owner, open staff management → staff account connections → refresh requests. Verify the requested account username and approve.
5. As the employee, refresh connections and enter the store. Check the original employee name/history, clock-in/out at the configured location, and login after logout.
6. As the owner, revoke the connection. Employee data requests and attendance writes must be denied; crew/history remain in the owner view.

## Verification and limits

`node --test security/*.test.mjs` passed 73 tests: 29 existing isolation/session regressions, 22 PGlite database scenarios, 10 UI-function scenarios, and 12 employee signup handler scenarios. PGlite is pinned at 0.5.8. The new Edge SDK import is pinned at 2.116.0. Tests use synthetic fixtures and mocked Auth/network dependencies, not real user passwords.

`staff-auth-live-rollback.sql` also passed on the staging PostgreSQL database using synthetic identities and SQL roles. It verifies pending access, owner approval, duplicate rejection, original record retention, legacy role protection, direct-write denial and revoke. All fixture rows were rolled back, with zero Auth/profile/store/crew/attendance/request/audit rows verified afterward.

Actual browser signup/login with Supabase-issued user JWTs and separate-connection concurrency have not been verified here. The existing Netlify team-access protection was preserved. Do not describe the SQL-role checks as an end-to-end Auth test.

Remaining work before production or forced employee migration:

- Password recovery and record transfer require a separate verified recovery process. Do not force existing employees to migrate before it is available.
- Manager promotion/recovery UI and administrator/franchise Auth migration are separate work.
- Remaining legacy permissive policies and authorization paths still need the full RLS rollout. This pilot does not establish system-wide security completion.
- Test AI/receipt processing and push/notification integrations remain disabled until separate staging integration settings exist.
- Production release must explicitly coordinate schema deployment, frontend feature enablement, administrator compatibility and approval. A `main` merge alone does not enable this employee pilot.

Security advisor results: two new private, RPC-only tables have RLS without direct-client policies by design. Existing `auth_rate_limits` has the same service-only pattern. Seven existing public SECURITY DEFINER warnings remain for separate review; the new public portal is SECURITY INVOKER. See [RLS policy diagnostics](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) and [privileged function diagnostics](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).

## Reproduction and recovery

The applied SQL snapshot and tool-generated migration version are recorded in `staff-auth.sql` and `staff-auth-release.json`. Tests use `fixtures/staging-baseline.sql` as their pre-change schema. Do not apply that fixture to an existing database.

Prefer a forward repair or temporarily unavailable preview if a problem appears. Do not restore old permissive policies, reactivate revoked memberships or delete new Auth/profile/request data to roll back this pilot. Keep the staging backend isolation. User/admin HTML still comes from the same source via `scripts/build-variants.py`.

The pre-auth signup validates the project application key in its body; public application keys do not identify employees or grant store access. User operations require Auth through PostgREST. See [Supabase key migration](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys) for the Edge key validation model.

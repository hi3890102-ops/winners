# Account recovery pilot — isolated staging

Applied to `obpkzecgswnfuyhwvncd` on 2026-09-11. Migration `20260911123418`; `manee-account-recovery` v1. The existing `security-v2` user preview is the only frontend target. Production `main`, production Supabase, and the administrator deployment are unchanged.

## User flow

1. Sign in to the test account. Employees open **내 매장·연결 상태**; owners open schedule → staff management → **내 계정·매장 연결**.
2. Open **비밀번호 복구키**, re-enter the current password, and issue a key. Keep the displayed key somewhere private. It is shown once, never stored in localStorage, and cannot be retrieved from the server. Reissuing invalidates the previous key.
3. Sign out. Open **비밀번호 찾기**, enter the same username, saved recovery key and a new password twice.
4. Sign in normally with the new password. The account and original store/employee/attendance IDs remain unchanged. Issue and save a fresh key afterward.

This works for owner and employee Auth accounts, including employees with more than one store. A store's six-digit participation code is not a recovery credential. Store owners cannot reset another person's account. Recovery does not grant memberships or reactivate revoked links.

A key must be issued **before** the password is forgotten. Losing both the password and saved key requires a separate verified support process, which is not implemented in this pilot. Do not force all existing employees to migrate yet. SMS and email delivery are not used. Internal Auth email addresses are not user recovery addresses.

## Implementation and failure handling

The server generates 128 random bits (32 hexadecimal characters). Only the SHA-256 digest reaches the private key table. Issuance requires an Auth-verified JWT, an active live session, an active profile, and successful password reauthentication. The temporary reauthentication session is signed out locally and never sent to the browser. The resulting key is kept only in page memory until the user leaves that view or logs out. Clipboard access requires the user to press copy.

The Edge endpoint validates the project application key, is pinned to the staging project URL, and returns `Cache-Control: no-store`. Authenticated issuance and pre-auth recovery share a 30/hour IP limit. Issuance adds 5/hour per account; reset attempts add 5/15 minutes per normalized username. Failed guesses consume attempts. The IP key uses gateway-supplied headers and is supplementary to account limits and the high-entropy recovery proof, not a verified device identity.

The service-only RPC atomically consumes the matching key under profile/key row locks **before** Auth changes the password. Neither user-supplied IDs nor roles choose the reset target. Missing accounts, wrong keys and used keys return the same result. Passwords go only to the Auth API; application tables and audit events never store them. Audit events record issue, reset start, completion or uncertainty without raw credentials.

The Auth password update and application RPC are not one transaction. If Auth or the completion response fails, the consumed key is never restored, and the UI reports an uncertain result instead of success. Try normal login with the new password first; if Auth did not commit, the old password still applies. Reissuance requires successful current-password authentication and is briefly paused (10 minutes) while an outcome is uncertain. If neither login works and no valid proof remains, verified support is required. Do not run a manual blind retry that resets credentials again.

Supabase's admin password update removes all sessions. Signed JWTs can otherwise remain usable until their expiry, so this patch checks the actual `auth.sessions` row, user and expiry in the roots of application authorization and the staff portal. Restrictive session policies were added to all 26 existing public tables for the authenticated role. These policies do not grant new access. Current live sessions keep working. Existing anonymous permissions elsewhere are still part of the separate full RLS rollout; this patch does not claim complete application security.

## Verification

- **95 automated checks passed**: 29 original environment/owner session regressions, 31 database checks (including the exact server SQL rehearsal), 14 frontend function checks, 12 staff signup checks, 9 recovery Edge checks.
- User/admin generated HTML scripts compiled; administrator feature remains disabled. Test build selects the staging backend and preserves disabled external integrations.
- `account-recovery-live-rollback.sql` passed on staging PostgreSQL: pending/approval, own history, clock-in/out and duplicate denial, recovery-key consumption/replay, removed-session denial, a new session restoring the original crew, and owner revoke preserving attendance.
- All synthetic live-check rows were rolled back. The user's test data remained profiles **2**, crew **1**, active staff link **1**, attendance **0**. No real user's password or recovery key was accessed or changed.
- Authenticated and anonymous callers cannot execute the recovery service RPC or read the private recovery tables. Service role has the intended RPC access.

The live SQL check uses synthetic identities and session rows; it simulates Auth's session deletion. It does **not** exercise the real HTTP password endpoint, issue actual JWTs, test device GPS/browser forms, or establish separate-connection concurrency. Those limits are also recorded in `account-recovery-release.json`. The earlier user report and live approved link confirm actual employee enrollment/approval only.

Advisor: four private RPC-only tables intentionally have RLS without direct-client policies. Seven pre-existing public SECURITY DEFINER warnings remain, now behind the session-checked authority helpers. Leaked-password protection is disabled and remains a separate configuration review. No new client-callable privileged recovery function was exposed.

## Safe continuation

Keep staging isolation and the session checks if the new recovery UI needs a forward fix. Do not restore old permissive policies, reuse consumed keys, reset real passwords for testing, replace account IDs, delete employee history, or roll back to a preview commit that points at production. Production release requires its own coordinated frontend, Auth, RLS and administrator review.

Current official references checked before implementation:

- [Supabase changelog](https://supabase.com/changelog)
- [Admin password update API](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid)
- [Session validation after logout](https://supabase.com/docs/guides/auth/sessions#how-to-ensure-an-access-token-jwt-cannot-be-used-after-a-user-signs-out)
- [Auth admin update implementation](https://github.com/supabase/auth/blob/master/internal/api/admin.go)
- [Auth password/session model implementation](https://github.com/supabase/auth/blob/master/internal/models/user.go)

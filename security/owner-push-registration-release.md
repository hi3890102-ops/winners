# Owner push registration recovery — 2026-10-06

Owners could grant notification permission while the app failed to persist the
browser subscription. Direct table access had been revoked in the September
security lockdown, but the enable button still used a direct upsert. Refresh
treated the browser subscription as enabled and ignored account-binding errors.

## Change

- Owner registration and removal use authenticated RPCs. Private cores require
  a live session and verified ownership; public functions are security invokers.
- The subscription table remains unreadable/unwritable by browser roles. The
  registration result is a boolean and returns no device keys or other users.
- A granted browser subscription is saved again on app entry, recovering missing
  rows and legacy rows whose full device keys match. A different bound account
  cannot be overwritten; an explicit enable action rotates that browser token.
- The owner UI shows enabled only after the server confirms registration. Failed
  connections show a retry message. Old asynchronous results cannot update the
  next signed-in account, and subscription operations do not overlap.
- Push destinations are restricted to browser push providers. No permission
  prompt runs during background recovery.

## Verification

- Local full suite: 615 passed, 9 existing optional skips, 0 failed.
- New browser-flow regression tests cover recovery without a prompt, server
  errors, permission denial, account changes, shared devices, and opt-out errors.
- Database tests cover register/retry/remove with direct table access revoked,
  anonymous/staff/foreign-store/expired-session/banned-user rejection, legacy
  key ownership, cross-account protection, and destination validation.
- Real staging transaction verified registration, idempotent retry, denial for a
  foreign store, preserved table restrictions, and removal, then rolled back all
  synthetic records. No push message was sent by this verification.
- Staging security advisor has no new warning/error; prior findings remain.
- Production and staging builds and inline JavaScript syntax checks passed.

## Rollout

Apply `20261006064743_owner_push_registration.sql` before publishing the frontend.
It creates functions only and does not change sales, expense, payroll, or existing
push rows. Existing permission holders need to reload/reopen the updated owner
app so their browser supplies its own subscription. Actual device receipt still
needs a separately authorized send and confirmation on the receiving device.

This patch addresses owner registration. Staff push enrollment uses its existing
path and requires separate verification; owner counts are not staff counts.

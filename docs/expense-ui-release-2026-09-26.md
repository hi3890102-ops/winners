# Expense UI update — 2026-09-26

- Vendor view preserves monthly totals and entry counts; expanding a vendor shows individual entries.
- Date view groups the same entries with daily totals. Monthly overall total remains visible.
- Entry editor supports date, vendor, integer amount, category and optional memo.
- Saves are store scoped, confirmed before local state changes, protected against duplicate submission and stale context responses. Failed saves retain input.
- Changing month removes the saved entry from the old month. Dashboard/report aggregates are invalidated.
- Edit visibility now matches manager/owner update permissions. Database RLS unchanged.
- Expense lookup failures show retry rather than misleading empty totals.
- Leaving monthly reports clears the detail view state.
- Editor error notices remain visible above the sheet.

Validation: 515 tests; 506 passed, 9 environment-dependent skips, 0 failures. Production build and diff checks passed. Additive nullable memo migration applied and RLS verified enabled. Existing financial rows were not edited for testing.

Limits: no authenticated end-to-end save against operational records; no physical Android/iOS device test. The automated suite does not establish that all menu interactions are defect free.

Database advisory follow-up: 11 INFO notices for private RLS tables without policies, 3 WARN notices about authenticated execution of security-definer functions, and disabled leaked-password protection. This release does not change these functions/auth settings. Review separately; they do not concern the added memo column. References: https://supabase.com/docs/guides/database/database-linter and https://supabase.com/docs/guides/auth/password-security

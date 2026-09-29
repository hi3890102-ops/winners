# Owner signup and store preparation

Approved scope: progressive owner signup and initial store setup. Employee self-signup and shared store code are the employee path; employee creation, old-record linking, wages, and schedules are not part of onboarding.

## Behavior

- Five signup screens: introduction, owner name, credentials and username check, store/franchise code, review and submit. Existing signup API and authentication remain in use. No new legal-consent text or consent collection is invented: the mockup's placeholder agreement screen is replaced with account review until approved policy documents/consent storage are provided.
- After the account/store are created: location, business-day cutoff, vendors/categories, monthly fixed costs, employee invitation guide, checklist templates, warning thresholds/manager visibility/notification opt-in, review.
- Store code is retrieved by the authenticated owner portal; no demo code or fabricated success. Staff self-signup, owner approval, employment settings, and then schedules are explained, without making them signup prerequisites.
- Skip, previous, resume from home, and reopen from More are supported. Saved records remain server-backed. The current step and non-sensitive labels are browser-local, scoped by owner username and store ID; another device sees server-saved data but restarts the guidance. Unsaved drafts remain memory-only. Passwords are never persisted.
- Fixed costs use the existing monthly schema and carry-forward behavior. Variable bills are explained as requiring monthly review; no unsupported recurring-type field was introduced. Existing amounts/records are not rewritten by navigation.
- New writes wait for confirmed returned rows, use store predicates, block repeated submissions, retain retry drafts on failure, and ignore late responses after account/store changes. Completion is not set locally when the server rejects or returns zero rows.
- Existing historical employee-linking functionality outside onboarding is not removed in this release. No RLS, schema, payroll calculation, or protected-function fixture changes.

## Verification

- Full suite: 527 tests, 518 passed, 9 pre-existing environment-dependent skips, 0 failures.
- Added behavioral coverage: signup validation/memory draft; serialized per-user/store progress; all preparation screens; no manual employee/wage/schedule fields; failed/zero-row completion; duplicate submission; late response after store switch; fixed-cost validation and retry; invite continuation; cutoff rejection.
- Production build and `git diff --check` passed. Main base: 9f6288d487a57683b76ecb46940009a74a55b274.
- Physical-phone and authenticated live signup/save were not executed; no operational records or accounts were created for testing. Local Playwright rendering was attempted but Chromium download failed in this environment, so visual/browser verification is not claimed.

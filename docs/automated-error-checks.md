# MANEE automated error checks

Configured 2026-10-07 (Asia/Seoul).

| Check | Schedule | Scope |
| --- | --- | --- |
| monitor-public.yml | Every 5 minutes (GitHub best effort) | Public HTTP pages, essential resources and deployment configuration; retries included |
| finalize-store-code.yml / verify-admin.yml | 07:17 / 07:27 daily and existing change triggers | Existing regression, interaction, calculation, build and isolated database suites |
| weekly-browser.yml | 07:37 daily and Monday 08:10 | Public unauthenticated rendering at 375, 430 and 1440px; JS exceptions, same-origin resource failures and horizontal overflow |
| ChatGPT daily result check | 09:00 daily | Failed, delayed or missing scheduled runs |
| ChatGPT availability result check | Hourly | Two consecutive failed completed checks; monitoring stale after 30 minutes |
| ChatGPT weekly summary | Monday 10:00 | Last seven days, failures, recovery, missing checks and unverified scope |

ChatGPT result automations are attached to the error-specific conversation. GitHub schedule timing is not a five-minute uptime SLA; ChatGPT notifications are hourly, not instant.

Public monitoring uses scripts/check-public-sites.mjs and config/public-sites.json.
Browser checks use scripts/check-public-browser.mjs. Reports and public-page screenshots are retained as Actions artifacts for 14 days; frequent availability artifacts for 7 days.
No browser test submits forms, logs in or writes attendance/business data. No service-role keys or real employee data are used.

## Coverage still requiring implementation
- Real login/logout with dedicated QA accounts for staff, manager, owner and headquarters.
- End-to-end attendance -> administrator reflection -> payroll -> report/export.
- Cross-store authorization checks with separate QA stores.
- A verified isolated test deployment, test identities and secret injection are prerequisites. Existing staging documents are historical planning evidence, not proof that those prerequisites are ready.
- Real device GPS, camera and push receipt remain separate device checks.
- Persistent incident identifiers and guaranteed duplicate-alert suppression are not implemented; hourly prompts can only deduplicate when previous reports are available.

Payroll expectation: floor each individual work session to a multiple of 30 minutes; discard the remainder. Existing calculation tests are not proof of operational payroll correctness.

## Handling a failed check
Read the failed job/step and report its actual evidence. A missing scheduled run is monitoring failure, not proof the app is down. A public HTTP failure is not proof login or the database has failed.
Distinguish repaired historical failures from current failures. Do not expose private logs or credential values. Private administrator run links require an authorized GitHub account; include a human-readable result in the report.
Code repair, production deployment and business data changes are not performed by the result automations.

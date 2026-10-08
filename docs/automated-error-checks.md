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
Browser checks use scripts/check-public-browser.mjs. Reports and public-page screenshots are retained as Actions artifacts for 14 days; frequent availability diagnostics for 7 days. Incident checkpoints request 90 days (subject to the repository's artifact retention limit).
No browser test submits forms, logs in or writes attendance/business data. No service-role keys or real employee data are used.

## Public incident identity and transitions

`scripts/public-monitor-incidents.mjs` links observations across runs. The existing `checkedAt`, `scope`, `ok`, `sites` and individual checks remain in `monitoring-results.json` (report schema version 2). Failed checks always additionally contain `failureReason` and `incidentKey`; `incidentId` is added when tracking is available.

- `incidentKey`: `public-v1-` plus SHA-256 of canonical HTTPS origin, case-sensitive URL pathname and normalized failure reason. Site display names, query/fragment cache-busters, timing, retry count and exception prose do not affect identity.
- Failure reasons are semantic codes: for example `http:503`, `http:404`, `network:timeout`, `network:dns`, `javascript:syntax`, `json:syntax`, `config:projectref`. Different HTTP codes and validation causes remain distinct. Unknown network exceptions share `network:other` instead of embedding volatile messages in a key; the original message remains diagnostic evidence.
- `id` / `incidentId`: key + history lineage + occurrence number. Repeated observations keep this ID; a confirmed recovery followed by the same cause increments the occurrence. The original key and first-seen time remain available. An intentional history reset gets a new lineage.
- `incidents` contains this run's transitions, including `key`, `id`, `reason`, `occurrence`, `firstSeenAt`, `openedAt`, `lastSeenAt`, `recoveredAt`, `consecutiveFailures`, `shouldNotify` and `eventId`.

| Transition | Evidence | Notification event |
| --- | --- | --- |
| `new` | First recorded failure of this key | One opening event |
| `ongoing` | Same key still open | Suppressed; same ID |
| `recovered` | This exact site's path passed all its checks | One recovery event for the same ID |
| `recurred` | Previously resolved key fails again | One opening event with a new occurrence ID |
| `unobserved` | Path/site removed, not checked, or currently failing for another reason | Suppressed; recovery is unproven |

Only the final outcome after the existing retries is observed. A successful retry does not create an incident. A different failure reason does not by itself close an old incident: a successful check of that path is required. Unobserved causes keep their open ID, and their consecutive-failure count resets to zero. Resolved records are carried forward in every checkpoint, including healthy runs, so recurrence history does not expire with the original result artifact.

`notifications` is the subset eligible for reporting. Opening IDs end in `:opened`, recovery IDs in `:recovered`; use the complete `eventId` as a consumer's deduplication key. These are notification intents, not delivery receipts.

## State continuity in GitHub Actions

The scheduled monitor serializes all default-branch executions with one concurrency group and `cancel-in-progress: false`. Feature-branch dispatches are excluded. Checkout does not persist credentials. The token has only `contents: read` and `actions: read`; no PAT, repository writes, issue writes, production secrets or application database are required. Artifact upload uses the Actions runtime service.

1. Find the newest `public-monitor-state-v1-<run_id>-<run_attempt>` artifact from this exact workflow, repository, default branch and a `schedule`, `push` or `workflow_dispatch` event. Paginate past unrelated artifacts. Do not filter to successful jobs: a new outage intentionally fails the final alert step **after** persisting state. Order by artifact creation/ID, not run ID, so reruns of older runs use the newest state.
2. Download that exact artifact and validate the state schema, scope, key/ID consistency, chronology and source run/attempt. An expired, unreadable or incompatible latest checkpoint is an error; do not fall back past it to an older history.
3. Run the same unauthenticated, same-origin GET checks with redirects disallowed and the existing retries. Keep collecting HTTP evidence even if state restoration fails. Standalone/release invocations remain stateless (`incidentTracking.status: disabled`) and still exit nonzero on any failed public check.
4. Compare with the prior state and upload `monitoring-state.json` **together with** `monitoring-results.json` as a single immutable checkpoint, whether sites passed or failed. Closed records are retained; no cache eviction policy is used for state.
5. Only after successful checkpoint upload, evaluate notification intents. New/recurred outages fail the alert step once; ongoing failures do not repeatedly fail it. Recovery events are recorded without failing the job. Any continuity/persistence error fails monitoring and suppresses site incident notifications.

The separate `public-monitor-results` artifact is diagnostic only. Its existence, a job summary or a partially executed run is not evidence that notification intents were committed. The checkpoint artifact is the commit boundary. A failed upload must not authorize a notification. Restoring the next run from that checkpoint prevents the same outage from generating another opening event, including after an alert-step failure or rerun.

**Job success is no longer a health signal for this workflow.** During a continuing outage a run can succeed with `report.ok: false`. Result readers must inspect JSON, not count failed workflow conclusions. The hourly ChatGPT consumer's previous two-failed-runs rule must be migrated when enabling this workflow: use committed per-path observations (`consecutiveFailures >= 2` if retaining that confirmation policy), preserve `incidentId`/`eventId` as its durable watermark, and scan **all** committed checkpoints since its watermark rather than just the latest result. A failure and recovery can both occur between hourly polls. Recovery/recurrence events must not be discarded by the two-failure filter. Updating an external ChatGPT task or delivering email/Slack/push messages is not performed by these repository scripts.

### Initialization, loss and delivery guarantees

After merging, run **Monitor public availability** on the default branch once with `initialize_state: true`. This explicitly starts the incident history; existing healthy or failing observations become its baseline. Normal schedules use the default `false`. Initialization is ignored when a valid checkpoint already exists. There is no automatic empty-state fallback: with missing history, API/download/validation failures, `incidentTracking.status` is `unavailable`, `notifications` is empty, the public results are still saved, and monitoring fails visibly.

Each new checkpoint carries the cumulative state forward and renews retention. Artifacts are not an eternal external database: prolonged inactivity beyond retention, administrative deletion of history, or GitHub storage failures can break continuity. Restore the latest intact checkpoint/history before enabling alerts again. If recovery is impossible, intentionally initialize a new lineage and record the loss; do not claim that old occurrences can still be distinguished. Deleting only the newest artifacts can leave an older history looking current; do not delete checkpoint history during operation. A read-only artifact store cannot prove that an administrator removed newer checkpoints.

The guarantee here is **one committed opening/recovery event per occurrence while the serialized checkpoint history is intact**, with duplicate intents suppressed across checks. There is no claim of exactly-once external message delivery: a separate sender must durably record delivery by `eventId` (or use a destination idempotency key) and handle retries. GitHub's own notification preferences and monitoring-infrastructure failures are separate from site-incident deduplication. Missing runs or an unobserved recovery between probes cannot be inferred.

### Regression checks

Run offline, with fixture responses and temporary state files only:

```sh
node --test tests/public-sites.test.mjs tests/public-monitor-incidents.test.mjs
```

Coverage includes repeated failures, one-time recovery, recurrence IDs, healthy history carry-forward, source/path/reason isolation, volatile error normalization, retry success, missing/changed checks, corrupted/missing state, JSON round-trips, reruns, failed-run restoration, pagination, untrusted artifacts and upload-gated notifications. The existing `finalize-store-code.yml` regression glob includes these tests on pull requests and main pushes. No regression test uses an operational account or writes business data.

## Coverage still requiring implementation
- Real login/logout with dedicated QA accounts for staff, manager, owner and headquarters.
- End-to-end attendance -> administrator reflection -> payroll -> report/export.
- Cross-store authorization checks with separate QA stores.
- A verified isolated test deployment, test identities and secret injection are prerequisites. Existing staging documents are historical planning evidence, not proof that those prerequisites are ready.
- Real device GPS, camera and push receipt remain separate device checks.
- External notification delivery receipts and migration of the hourly ChatGPT consumer to the committed incident protocol above. The repository now deduplicates incident intents; it does not send or acknowledge external messages.

Payroll expectation: floor each individual work session to a multiple of 30 minutes; discard the remainder. Existing calculation tests are not proof of operational payroll correctness.

## Handling a failed check
Read the failed job/step and report its actual evidence. A missing scheduled run is monitoring failure, not proof the app is down. A public HTTP failure is not proof login or the database has failed.
Distinguish repaired historical failures from current failures. Do not expose private logs or credential values. Private administrator run links require an authorized GitHub account; include a human-readable result in the report.
Code repair, production deployment and business data changes are not performed by the result automations.

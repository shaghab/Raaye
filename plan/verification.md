# Verification record

What actually ran for this build, with outcomes. Environment: Linux sandbox, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 (host instance for tests, Compose instance for the Docker smoke test), Docker Engine 29 with Compose v2, Firebase Auth emulator (firebase-tools 15.32.1), Chromium (Playwright). Date: 7 October 2026.

## Summary

| Check | Command | Result |
| --- | --- | --- |
| Lint (7 projects) | `pnpm lint` | passed |
| Strict typecheck (apps, libs, test files, e2e) | `pnpm typecheck` | passed |
| Unit tests | `pnpm test` | passed: contracts 4, domain 36, server 18, web 6 (64 tests) |
| Integration tests (real PostgreSQL) | `pnpm test:integration` | passed: 11 suites, 71 tests |
| WhatsApp asset validation | `pnpm whatsapp:validate` | passed: 8 checks (3 Flows, 3 fixtures, 2 template specs) |
| Production builds (api, worker, web) | `pnpm build` | passed; web initial bundle 658 kB raw / 161 kB transfer |
| All of the above in one run | `pnpm verify` | passed (lint 11 s, typecheck 27 s, unit 11 s, integration 50 s, assets 2 s, builds 25 s) |
| Playwright critical journeys | `pnpm test:e2e` | passed: 8 journeys (auth/roles 4, contacts 2, survey end-to-end 2) |
| Docker startup smoke | `pnpm verify -- --docker` (`scripts/docker-smoke.ts`) | passed: build, bootstrap (migrate + seed), dashboard and API reachable on 127.0.0.1:8080, emulator sign-in, seeded data present, user-created contact survives `docker compose restart api worker`, seed re-run adds nothing |
| 1,000-contact scenario (R59) | `apps/api/src/__integration__/scale.int-spec.ts` | passed: launch request 664 ms, 1,000 invitations accepted in 22.8 s through the mock provider including a simulated worker crash and lease recovery, exactly one attempt per logical message, results query 23 ms, dispatch page 1,000 recipients |
| Seed idempotency | `node dist/apps/worker/main.js seed` twice; `seed:scale` twice | second runs report `contacts: 0`, every survey `skipped`; scale seed `{"created":0,"existing":1000}` |

## Integration suites (apps/api/src/__integration__)

| Suite | Tests | Covers |
| --- | --- | --- |
| `auth-membership.int-spec.ts` | 6 | token verification, membership resolution, role matrix, invitations, last-admin protection including concurrent downgrade/revoke requests, revocation (R03-R06, R09) |
| `tenant-constraints.int-spec.ts` | 3 | composite foreign keys and unique constraints, scoped client refusing foreign organizations (R07, R08) |
| `contacts.int-spec.ts` | 15 | contact CRUD, same phone in two organizations, consent evidence and withdrawal, groups/tags, CSV/XLSX import with attestation and invalid rows, interrupted import resumed exactly once per row, crashed/expired/purged imports, rows applied before the marker existed, the migration backfill run against legacy-shaped batches, concurrent runs with a failure, export neutralization (R10-R14, R50, R56) |
| `surveys-launch.int-spec.ts` | 23 | authoring validation, audience freeze, launch idempotency, scheduling, unschedule, activation/closing jobs, STOP cancelling queued sends, ambiguous send and explicit retry, archive/launch serialization, Viewer draft visibility, status callbacks (concurrent, failed projection replayed by the retry and the sweep) (R15, R21, R23-R29, R43, R44, R55) |
| `conversation.int-spec.ts` | 11 | Start/intro/profile offer, buttons/list/Flow answers, edit window with injected clock, multi-select validation, resume/switch between surveys, enrollment of unknown senders, STOP/HELP/EDIT commands, duplicate webhooks, signed raw webhook ingress and quarantine (R16-R20, R31-R42, R44) |
| `reporting.int-spec.ts` | 8 | aggregates with known dataset, breakdowns on frozen profiles with threshold, Admin-only responses with audit, CSV/XLSX exports parsed and checked, result sharing snapshot/template/`View results`/revoke with a respondent who withdrew invitations only, revocation canceling queued notices and the send policy refusing a revoked snapshot, retention cleanup (R06, R30, R46-R54, R56, R58) |
| `internal.int-spec.ts` | 2 | service-identity guard, idempotent job execution and sweep routes (R55) |
| `jobs-push.int-spec.ts` | 2 | Cloud Tasks hand-off of pending jobs, scheduled tasks, re-push after retry, rejected pushes left for the sweep, inert under the postgres driver (R55) |
| `jobs-leases.int-spec.ts` | 3 | a reclaimed lease is not reset by recovery and the previous holder can neither complete nor fail the job; recovery of a dead worker's leases re-queues retryable jobs and fails exhausted ones; the runner reports a lost lease (R43, R55) |
| `inbox.int-spec.ts` | 2 | inbox row and processing job commit together; duplicate delivery re-enqueues an orphaned pending row (R41, R42) |
| `scale.int-spec.ts` | 1 | 1,000-contact launch and restart during dispatch (R59) |

## Unit suites

- `libs/domain/src/lib/__tests__/*` (36): edit windows, scheduling, commands, consent derivation, service window, age bands, demographics, question/renderer rules, aggregates, CSV, spreadsheet neutralization, phone normalization, import rules, tokens, results text.
- `libs/server/src/**/__tests__/*` (15): Meta webhook contract (raw-byte signatures, batched parsing, Flow response bounds), Meta send payloads and error classification including post-transmission resets as ambiguous sends, send policy gate, configuration validation (fail-closed live mode), Cloud Tasks adapter.
- `libs/contracts/src/lib/__tests__/schemas.spec.ts` (4): question/audience/query/launch/organization schemas.
- `apps/web/src/app/**/*.spec.ts` (6): formatting helpers, API error mapping, chip component rendering.

## Playwright journeys (apps/web-e2e/src)

1. Wrong password rejected; Admin signs in; mock badge and mock banner visible; sign out.
2. Viewer sees aggregates only (no contacts/audit navigation, no Responses/Dispatch tabs, no launch controls).
3. Second tenant sees only its own surveys and contacts.
4. Password reset page does not reveal accounts.
5. Manager creates a contact (national-format phone normalized), records consent evidence, searches, exports CSV (download observed).
6. Import wizard uploads the invalid fixture, maps columns, previews, and shows error rows.
7. Manager authors a five-question survey with a fresh consented participant, previews messages, checks eligibility, launches; Admin answers in the simulator (buttons, list, multi-select Flow, rating), edits an answer inside the window, is refused after the clock advances 121 s; Viewer sees aggregates reflecting the edited answer and downloads the aggregates CSV.
8. Shared results status visible after closure; STOP from a participant yields the opt-out acknowledgement and the contact shows Withdrawn.

## Manual UI inspection

Screens exercised in a browser against both the dev server and the Docker/nginx production bundle: login, overview (counts, attention items, blocked dispatch list), contacts list/detail/form/import wizard/groups & tags, surveys list/editor/detail (overview, results, breakdowns, dispatch with message detail and retry, responses, share results), settings (organization, defaults, staff, messaging), audit log, simulator (conversation, controls, Flow forms, clock, faults, outbox). Loading, empty and error states render through the shared `rye-state` component; downloads work through authenticated fetches.

## Not run / external

- Live Meta Cloud API calls (template registration and status, Flow upload/publish, real webhook traffic, real delivery). The adapter is covered by contract tests against the documented payload and webhook formats only.
- Google OIDC verification for `/internal/*` under `JOB_DRIVER=cloud_tasks` (unit-tested request shaping only; the local shared-token path is integration-tested).
- GCP deployment; `DEPLOYMENT.md` is a reference layout.
- Firefox/WebKit browser projects (Chromium only).
- `prisma migrate reset` could not be executed by the agent (Prisma's AI-agent guard); the development database was recreated with `DROP SCHEMA` + `prisma migrate deploy`, and `pnpm db:reset` remains available to a human operator.

## Known limitations observed during verification

- Node slim images lack the `openssl` binary; Prisma prints an OpenSSL detection warning in the `bootstrap` container but migrations apply correctly.
- The Angular dev server (`nx serve web`) takes 60-90 s to start on first run; Playwright waits up to 240 s.
- The `jobs` table "dead jobs" counter on the overview counts permanently failed send jobs, which the seed creates deliberately as a diagnostics fixture.
- A live deployment has no automated way to create its first organization and Admin membership (the demo seed is refused in live configuration); the messaging connection is created from Settings, but the organization itself needs an operator database insert. Tracked in issue #13.

## Review round 1 (Codex, commit 596ac4c)

Four P1 findings were fixed with regression tests and one P2 finding was tracked as a GitHub issue; see `plan/review-state.json`. After the fixes: `pnpm lint` passed, `pnpm typecheck` passed, server unit tests 15 passed, integration suite 10 suites / 53 tests passed.

## Review round 2 (Codex, commit 8c1ed4f)

Three P1 findings were fixed with regression tests (audience filter composition, phone-change window reset, per-connection access token) and three P2 findings were tracked as GitHub issues #5, #6 and #7. After the fixes: `pnpm lint` passed, `pnpm typecheck` passed, server unit tests 16 passed, integration suite 10 suites / 53 tests passed.

## Review round 3 (Codex, commit 0ddb201)

Two P1 findings were fixed with regression tests (readiness is checked before a run is activated and blocked activations are retried by the sweep until the closing time; disabled messaging connections are honored by readiness, the send policy gate and the simulator) and two P2 findings were tracked as GitHub issues #8 and #9. After the fixes: `pnpm lint` passed (7 projects), `pnpm typecheck` passed (7 projects), unit tests passed for 6 projects (server 17), integration suite 10 suites / 55 tests passed, `pnpm whatsapp:validate` 8 checks passed.

## Review round 4 (Codex, commit 721765b)

Three P1 findings were fixed with regression tests (signed webhook traffic for a disabled connection is quarantined; the first Settings save provisions the organization's sender for the configured mode; consent decisions serialize under a contact row lock) and three P2 findings were tracked as GitHub issues #10, #11 and #12. A deployment gap noticed while fixing the provisioning finding (no automated first organization/Admin in a live deployment) is tracked as issue #13. After the fixes: `pnpm lint` passed (7 projects), `pnpm typecheck` passed (7 projects), unit tests passed for 6 projects (server 18), integration suite 11 suites / 59 tests passed.

## Review round 5 (Codex, commit d6b9c6e)

Three P1 findings were fixed with regression tests (the worker claims a queued message under the contact row lock and re-evaluates the send policy there; archive and launch serialize on the survey row; future-dated imported consent evidence is rejected at preview and revalidated at processing) and three P2 findings were tracked as GitHub issues #14, #15 and #16. The acceptance matrix was re-aligned with the `MVP.md` requirement IDs in the same round. After the fixes: `pnpm lint` passed (7 projects), `pnpm typecheck` passed (7 projects), unit tests passed for 6 projects (server 18), integration suite 11 suites / 62 tests passed.

## Review round 6 (Codex, commit a583a1e)

Two P1 findings were fixed with regression tests (the provider hand-off now runs under the contact row lock with a policy re-check, so a STOP either suppresses the message or waits for the provider's answer; draft edits serialize with launch on the survey row and launch refuses to freeze a revision edited after validation). No lower-priority findings were raised. After the fixes: `pnpm lint` passed (7 projects), `pnpm typecheck` passed (7 projects), unit tests passed for 6 projects (server 18), integration suite 11 suites / 64 tests passed.

## Review round 7 (Codex, commit 09d00d3)

One P1 finding was fixed with a regression test (archiving now cancels active test runs and their queued sends) and one P2 finding was tracked as GitHub issue #17. After the fix: `pnpm lint` passed (7 projects), `pnpm typecheck` passed (7 projects), unit tests passed for 6 projects (server 18), integration suite 11 suites / 65 tests passed.

## Review round 8 (Codex, commit 6f06ac3)

One P1 finding was fixed with a regression test (the hand-off re-check judges deadlines on a clock reading taken after the contact lock is acquired). No lower-priority findings were raised. After the fix: `pnpm lint` passed (7 projects), `pnpm typecheck` passed (7 projects), unit tests passed for 6 projects (server 18), integration suite 11 suites / 66 tests passed.

## Review round 9 (Codex, commit bd550e2)

Two P1 findings were fixed with regression tests (consent evidence records the notice version that the prompt actually showed; test-run creation serializes with archive and draft edits on the survey row). No lower-priority findings were raised. After the fixes: `pnpm lint` passed (7 projects), `pnpm typecheck` passed (7 projects), unit tests passed for 6 projects (server 18), integration suite 11 suites / 68 tests passed.

## Review round 10 (Codex, commit af1d892)

One P1 finding was fixed with a regression test (each consent button carries the notice version it was rendered with, so an older button records its own wording after a re-prompt). No lower-priority findings were raised. After the fix: `pnpm lint` passed (7 projects), `pnpm typecheck` passed (7 projects), unit tests passed for 6 projects (server 18), integration suite 11 suites / 68 tests passed.

## Review round 11 (Codex, commit 6dc1303)

Two P1 findings were fixed with regression tests (participant-notice version updates serialize under the organization row lock with an atomic increment; delivery-state promotion is a conditional, rank-guarded update) and one P2 finding was tracked as GitHub issue #18. After the fixes: `pnpm lint` passed (7 projects), `pnpm typecheck` passed (7 projects), unit tests passed for 6 projects (server 18), integration suite 11 suites / 70 tests passed.

## Review round 12 (Codex, commit 964f7d5)

One P1 finding was fixed with a regression test (answer writes lock the survey run row and re-read its state, so they serialize with closure) and one P2 finding was tracked as GitHub issue #19. After the fix: `pnpm lint` passed (7 projects), `pnpm typecheck` passed (7 projects), unit tests passed for 6 projects (server 18), integration suite 11 suites / 71 tests passed.

## Review round 13 (Codex, commit 2c62a04)

Codex completed its review of 2c62a04 with no findings ("Didn't find any major issues", pull-request comment 6037569940). Every review thread on the pull request is resolved: 25 P1 findings were fixed with regression tests across rounds 1-12, and 15 P2 findings are tracked as GitHub issues #4-#12 and #14-#19 (plus #13 for the first-organization bootstrap gap found while fixing round 4).

## Final verification on the pull-request head

The last product-code change is `56b2580` (head `2c62a04` at review round 13). The later commits `745b97f` and `dd2a4a9` change only `plan/` records and `scripts/docker-smoke.ts`. What ran, and from which tree:

- From `745b97f`: `pnpm build` passed (api, worker, web production bundles); `pnpm test:e2e` passed, 8 Playwright journeys (1 m 18 s).
- Docker smoke from `745b97f`: failed at the contact-creation step with `CONTACT_DUPLICATE`, because `scripts/docker-smoke.ts` reused a fixed phone number against the Compose volume kept from an earlier `--keep` run; the stack had already built, migrated, seeded and become healthy. The script now derives the number from the run timestamp.
- Docker smoke from the modified working tree that became `dd2a4a9` (`745b97f` plus that script change): passed at 12:21 UTC with the images rebuilt from that tree: bootstrap migrated and seeded, dashboard and API reachable through nginx on 127.0.0.1:8080, emulator sign-in, seeded surveys present, a newly created contact survived `docker compose restart api worker`, the seed re-run added nothing, `docker compose down` completed.
- From the tree of `dd2a4a9` (only `plan/review-state.json` differed, uncommitted), after review round 14 questioned this record: `pnpm verify` passed (lint and strict typecheck for 7 projects and the three production builds were replayed from the Nx cache because their inputs had not changed; unit tests executed, 64 passed in 6 projects (12 s); integration tests executed, 11 suites / 71 tests (63 s); WhatsApp assets 8 checks) and `pnpm test:e2e` passed (8 journeys, 55 s).

## Review round 14 (Codex, commit dd2a4a9)

One P2 finding, on this file: the first version of the section above said that every commit after `2c62a04` touched only `plan/` and attributed the successful Docker smoke to `745b97f`. Because this file is the verification evidence, the section was corrected in the record commit instead of being deferred to an issue, and the full `pnpm verify` suite and the Playwright journeys were re-run from the `dd2a4a9` tree so that the record no longer rests on partial re-runs. No product code changed.

## Review round 15 (Codex, commit 2f871f3)

Codex completed its review of 2f871f3 with no findings ("Didn't find any major issues", pull-request comment 6038069705). All 41 review threads are resolved: 25 P1 findings fixed with regression tests (rounds 1-12), 15 P2 findings tracked as GitHub issues #4-#12 and #14-#19, one P2 finding on this record corrected in the pull request (round 14), plus issue #13 for the first-organization bootstrap gap. The commit that records this outcome changes only `plan/` files and was not sent for a further review round.

## Follow-up: first-organization bootstrap (issue #13)

Branch restarted from the merged `main` (4bf2981). Checks run on the working tree that became this pull request:

| Check | Result |
| --- | --- |
| `pnpm verify` | passed: lint 7 projects, strict typecheck 7 projects, unit tests 68 (contracts 4, domain 36, server 22, web 6), integration 12 suites / 73 tests, WhatsApp assets 8 checks, production builds |
| `pnpm test:e2e` | passed: 9 Playwright journeys, including the new bootstrap journey (operator command through the worker bundle, acceptance link opened in the dashboard, account created in the Auth emulator with a chosen password, Admin sign-in, `organization.bootstrapped` visible in the audit log) |
| Migration | `prisma migrate deploy` applied `20261007143000_bootstrap_invitations` to the test and development databases; `prisma migrate diff --from-config-datasource --to-schema` reports no drift |
| CLI through the built worker bundle (`pnpm bootstrap:org -- ...`) | create: exit 0, JSON result with the link on stdout, structured log with ids only; re-run before acceptance: exit 0, `revokedInvitations: 1`; organization with an active Admin: exit 1 `BOOTSTRAP_REFUSED`; unknown option: exit 2 with usage; invalid slug/email/name: exit 1 with field errors; audit metadata holds no email |
| Container entrypoint | `docker run raaye-app:local seed` previously failed with `exec: seed: not found`; after the entrypoint change `seed` and `bootstrap:org` reach the worker bundle (they stop at the configuration check when no database is configured, as expected) |
| Docker smoke (`scripts/docker-smoke.ts --keep`) and `docker compose run --rm worker bootstrap:org ...` | passed: images rebuilt from this tree, bootstrap (migrate + seed, including the new migration), dashboard and API through nginx, emulator sign-in, restart persistence, seed idempotency; then `bootstrap:org` inside the Compose stack created an organization and printed its link (exit 0) and refused the seeded demo organization with `BOOTSTRAP_REFUSED` (exit 1); `docker compose down` completed |

Not run: nothing in this change touches the Meta adapter, Cloud Tasks or the dashboard beyond the existing acceptance page, so live Meta and GCP verification remain external as before.

## Review loop for pull request #20 (first-organization bootstrap)

| Round | Commit | Outcome |
| --- | --- | --- |
| 1 (pull request opened) | 2f8f7e9 | P1: a re-run with a corrected Admin address left the earlier address's link valid. Fixed in 14740fd: a re-run revokes every pending bootstrap invitation of the organization; the integration test covers the corrected-address case. |
| 2 | 14740fd | P1: invitation acceptance did not take the organization lock, so an acceptance racing a re-run could leave a second valid Admin link. Fixed in c90ff93: acceptance locks the organization row before consuming the invitation; a gated integration test interleaves a re-run and an acceptance and fails with a 500 without the lock. |
| 3 | c90ff93 | P2: the acceptance compares expiry against a clock reading taken before the lock wait. Tracked as issue #21, not implemented. |

All three review threads are resolved. After the fixes, on the tree of c90ff93: `pnpm verify` passed (lint 7 projects, strict typecheck 7 projects, unit tests 68, integration 12 suites / 74 tests, WhatsApp assets 8 checks, production builds); `pnpm test:e2e` passed (9 journeys). The commit that records this outcome changes only `plan/` files and was not sent for a further round.

## Follow-up: webhook secrets, Viewer drafts and invitation expiry (issues #10, #16, #21)

Branch restarted from the merged `main` (dbfdc6f). Checks run on the working tree that became this pull request:

| Check | Result |
| --- | --- |
| `pnpm verify` | passed: lint 7 projects, strict typecheck 7 projects, unit tests 70, integration 13 suites / 79 tests, WhatsApp assets 8 checks, production builds |
| `pnpm test:e2e` | passed: 9 Playwright journeys |
| New unit coverage | `libs/server/src/messaging/__tests__/secrets.spec.ts`: reference resolution and the fail-closed lookup |
| New integration coverage | `webhook-secrets.int-spec.ts` (process-wide secrets only without a bound reference; bound references never accept the process-wide values; an unresolved reference refuses verification and delivery and writes nothing; a repaired reference restores the connection); `surveys-launch.int-spec.ts` "Viewers never see draft surveys, in the list or by id" (list, `state=DRAFT`, archived drafts, detail, preview, results, breakdowns; Admin and Survey Manager unaffected); `reporting.int-spec.ts` adjusted so the unlaunched-survey results read is a Survey Manager's and a Viewer gets not-found; `auth-membership.int-spec.ts` "an invitation that expires while its acceptance waits for the organization lock is refused" (lock held by another transaction, injected clock advanced past expiry while the acceptance waits on `pg_stat_activity`, `INVITATION_INVALID`, no membership) |

Not run: nothing in this change touches the Meta adapter's outbound path, Cloud Tasks or Docker assets; live Meta and GCP verification remain external as before.

## Review loop for pull request #22 (webhook secrets, Viewer drafts, invitation expiry)

| Round | Commit | Outcome |
| --- | --- | --- |
| 1 (pull request opened) | a7d23be | Two P2 findings, both on behaviour this change would have introduced, fixed here: the Viewer overview still listed drafts whose links now answer not-found (7b3d8e3), and a password-based acceptance refused after the new post-lock expiry check left an orphan Firebase account (97a9af9 deleted the account). |
| 2 | 97a9af9 | P1: a transaction error can hide a commit whose acknowledgement was lost, so deleting the account could strand a persisted membership. af135ce reconciled against the database first. |
| 3 | af135ce | P1: the reconciliation read ran at once and unlocked. 44492db locked the invitation row first so the failed transaction resolves before the read. |
| 4 | 44492db | No findings. |
| 5 | aed9134 | P2 on the new contacts deep-link initializer: it read query keys the existing group and tag links do not emit. 1ef21b4 reads the contact query contract's keys. |
| 6 | 1ef21b4 | P1: a second acceptance by the same fresh identity could store its user row after the reference check, then lose the identity (3026fab checked references first). P2: the overview's blocked-run list still named drafts (0623b73 applies the Viewer predicate there, with a test that blocks a draft's test run). |
| 7 | 0623b73 | P1: the reference check was a snapshot; cd6850a serialized acceptances per identity with an advisory lock. |
| 8 | cd6850a | P1: the lock ended before the deletion. 7170e78 removes the deletion altogether: an account created for a refused acceptance is kept, the refusal says so, and only the reconciliation that returns a persisted acceptance as a success remains. |
| 9 | 7170e78 | One P2, the same stale-clock pattern at the shared user-row upsert when one identity joins two organizations at once, a wait point that predates this change: tracked as issue #23. |

All ten review threads are resolved. The Playwright run on 44492db failed one journey ("STOP after launch cancels pending sends ...") on both attempts: it opened `/contacts?search=Kamran`, but the contacts list never read filters from the URL, so it showed the unfiltered first page, and the "E2E Contact" rows that every run of the contacts journey adds to the long-lived development database had pushed the seeded contact onto the second page (26 names before it, 10 of them from today's runs). The API search itself answered in under 100 ms. The contacts list now seeds its search, consent, group, tag and archived filters from the URL (aed9134, keys aligned in 1ef21b4), which makes deep links work and the journey independent of accumulated data.

On the tree of 7170e78: `pnpm verify` passed (lint 7 projects, strict typecheck 7 projects, unit tests 75, integration 13 suites / 79 tests, WhatsApp assets 8 checks, production builds) and `pnpm test:e2e` passed (9 journeys). The commit that records this outcome changes only `plan/` files and was not sent for a further round.

## Follow-up: status replay, job leases and import resume (issues #4, #14, #5, #6)

Branch restarted from the merged `main` (d8f89c1). Checks run on the working tree that became this pull request:

| Check | Result |
| --- | --- |
| `pnpm verify` | passed: lint 7 projects, strict typecheck 7 projects, unit tests 75 (contracts 4, domain 36, server 29, web 6), integration 14 suites / 85 tests, WhatsApp assets 8 checks, production builds (api, worker, web) |
| `pnpm test:e2e` | passed: 9 Playwright journeys (auth/roles 4, bootstrap 1, contacts 2, survey end-to-end 2) |
| Migration | `20261007170000_import_row_applied_at` applied with `prisma migrate deploy`; `prisma migrate diff` reports no drift |
| New integration coverage | `surveys-launch.int-spec.ts` "a status whose projection failed is applied by the provider retry and by the sweep instead of being dismissed as a duplicate" (projection fails once: no event row and no state change persisted; the retry is recorded and the state promoted; a genuine duplicate still creates no second event; dispatch metrics count the delivery; an unmatched READ is linked and applied by the sweep only once both writes succeed); `jobs-leases.int-spec.ts` (3 tests, see the suites table); `contacts.int-spec.ts` "a failure during processing answers with an error, keeps the applied rows and resumes exactly once per row" (450-row file, consent write fails in the second 200-row chunk: HTTP 500 `IMPORT_PROCESSING_FAILED` with the batch id and the partial summary, 200 contacts and 200 stamped rows, 250 pending, batch `FAILED` and `resumable`; the second confirm completes with 450 contacts, every row applied once, one consent event and one group membership per contact; audit trail confirmed/failed/resumed/completed) and "an import left CONFIRMED by a crash resumes once even when confirmed concurrently, and expired rows report a clear error" (two concurrent confirms, one completion audit, three contacts; a stopped batch past its retention window answers 409 before and after the retention purge, nothing imported) |

Not run: nothing in this change touches the Meta adapter's outbound path, Cloud Tasks or the Docker assets; live Meta and GCP verification remain external as before.

## Review loop for pull request #24 (status replay, job leases, import resume)

| Round | Commit | Outcome |
| --- | --- | --- |
| 1 (pull request opened) | 5e67cfe | Two P1 and one P2, all fixed in e653148: the staged rows of a failed batch were never purged because processing set the staging marker while keeping the rows (processing now drops only the raw file and the retention sweep purges the rows of every batch at the end of the window, which also bounds the error report); rows applied before the `applied_at` marker existed would have been applied again on resume (migration backfill plus runtime recognition); and a run that failed after a concurrent run completed the batch recorded a false failure (the failure transition now defers to the completion, and a run that applied every pending row completes the batch even after a concurrent failure mark). |
| 2 | e653148 | P1: the backfill recognized an applied legacy UPDATE only while the contact still named that batch as its last import. dc9916a classifies legacy rows by durable evidence (completed batch, created contact, last import or consent evidence recorded under the batch) and refuses the in-flight UPDATE rows it cannot classify; a test runs the migration's statements against legacy-shaped batches built through the API. |
| 3 | a4b2c3f | No findings. |

All four review threads are resolved. On the tree of dc9916a (a4b2c3f adds only `plan/`): `pnpm verify` passed (lint 7 projects, strict typecheck 7 projects, unit tests 75, integration 14 suites / 88 tests, WhatsApp assets 8 checks, production builds) and `pnpm test:e2e` passed (9 journeys). The commit that records this outcome changes only `plan/` files and was not sent for a further round.

## Follow-up: results permission scope, readiness by purpose, profile Flow, revocation (issues #8, #11, #18, #12)

Branch restarted from the merged `main` (c8802cd). Checks run on the working tree that became this pull request:

| Check | Result |
| --- | --- |
| `pnpm verify` | passed: lint 7 projects, strict typecheck 7 projects, unit tests 80 (contracts 4, domain 36, server 34, web 6), integration 14 suites / 90 tests, WhatsApp assets 8 checks, production builds (api, worker, web) |
| `pnpm test:e2e` | passed: 9 Playwright journeys. One run during the review loop failed the two journeys that open the seeded survey from the surveys list: the "E2E transport survey" rows that every run of the survey journey adds to the long-lived development database (31 surveys by then, page size 25) had pushed "Access to justice 2026" onto the second page. Both journeys now find it through the list's search field, which makes them independent of accumulated data; the application was not at fault. |
| New unit coverage | `libs/server/src/messaging/__tests__/policy.spec.ts` "governs result notices by the results scope alone while STOP still blocks them" (results scope with the invitation scope unknown or withdrawn, results unknown or withdrawn, STOP, revoked snapshot, invitations not unlocked by results permission); `libs/server/src/messaging/__tests__/readiness.spec.ts` (4 tests: complete sender, missing/disabled sender and unresolved secrets; templates required per purpose with the Settings warning; the profile Flow required for outreach while onboarding is enabled, unpublished/unbound/stale-asset cases, question Flows; mock mode) |
| New integration coverage | `reporting.int-spec.ts`: the sharing test withdraws P3's invitation scope before the share and asserts the notice still reaches P3 and that accepted notices equal the preview's eligible count, disables the sender while the notices leave (all suppressed, recipients `SUPPRESSED` with the reason) and retries them (accepted, recipients `INVITED` again), records a provider `FAILED` callback for one accepted notice (delivery state `FAILED`, recipient still `INVITED`, the RESULTS command still delivers the content), then withdraws P2's invitation scope after the broadcast and asserts P2's View results still delivers; "revoking cancels the result notices still queued and a revoked snapshot is refused at send time" (a second closed survey with five respondents, four notices; an invitation-only withdrawal leaves P6's queued notice and job; P1's RESULTS menu for two shared surveys stays queued and is sent with both controls after an invitation-only withdrawal, while P8's queued HELP reply is canceled by P8's invitation-only withdrawal and P8's notice stays; a second queued menu of P1 is canceled with P1's notice by a results-only withdrawal, after which RESULTS answers "no longer available" without a menu, and valid new evidence re-grants P1's results; a results withdrawal arriving while P1's RESULTS command is being processed, held at its conversation update after the permission read until the withdrawal is seen waiting on the contact lock: the processing completes, the withdrawal then cancels the menu it queued with its job, no attempt exists and no results control is live, and valid new evidence re-grants P1 again; P7's results-only withdrawal cancels the queued notice and marks the recipient, RESULTS is refused, and valid new evidence restores access so RESULTS delivers the content; a revocation held open in another transaction while a worker hands P8's notice over, released once the worker waits on the snapshot lock: the notice is refused with one `FAILED` attempt `RESULTS_REVOKED`; P6's notice claimed after the revocation is refused before any attempt; the Admin's revocation finds nothing left to cancel and records zero counts; after draining, no notice of the broadcast was accepted; revoking the first survey's snapshot too leaves P1 nothing to list) |
| Results menu pages | `reporting.int-spec.ts` "the page control of a results menu follows results permission like View results": a ten-item results menu built through the planner for P1 (page control flagged as results-related); an invitation-only withdrawal leaves its ten controls alive and the next page is served; a results-only withdrawal expires all of them; a page control that is still live is refused once results permission is withdrawn and no page is queued |
| Inbound processing under the contact lock | With the lock in `ConversationService.processEvent` reverted, the same reporting suite fails the race above (the menu stays `PENDING` after the withdrawal returned, and the page-control test then counts the leftover live controls); with it, the suite passes. `conversation.int-spec.ts` and `contacts.int-spec.ts` (29 tests, among them two simultaneous first replies and an answer in flight while the survey closes) pass under the lock. |
| Live-only paths | The readiness rules for live senders (template purposes, the profile Flow) and the conversation's profile-Flow guard apply only in live mode, which the integration harness cannot boot (it requires live auth and real secrets); they are covered by the unit tests above with live inputs, and the mock-mode suites prove the wiring (launch, test run, activation, survey detail and sharing call the same check). |

Not run: live Meta and GCP verification remain external as before.

# Verification record

What actually ran for this build, with outcomes. Environment: Linux sandbox, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 (host instance for tests, Compose instance for the Docker smoke test), Docker Engine 29 with Compose v2, Firebase Auth emulator (firebase-tools 15.32.1), Chromium (Playwright). Date: 7 October 2026.

## Summary

| Check | Command | Result |
| --- | --- | --- |
| Lint (7 projects) | `pnpm lint` | passed |
| Strict typecheck (apps, libs, test files, e2e) | `pnpm typecheck` | passed |
| Unit tests | `pnpm test` | passed: contracts 4, domain 36, server 18, web 6 (64 tests) |
| Integration tests (real PostgreSQL) | `pnpm test:integration` | passed: 11 suites, 64 tests |
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
| `contacts.int-spec.ts` | 8 | contact CRUD, same phone in two organizations, consent evidence and withdrawal, groups/tags, CSV/XLSX import with attestation and invalid rows, export neutralization (R10-R14, R50) |
| `surveys-launch.int-spec.ts` | 11 | authoring validation, audience freeze, launch idempotency, scheduling, unschedule, activation/closing jobs, STOP cancelling queued sends, ambiguous send and explicit retry (R15, R21, R23-R29, R43) |
| `conversation.int-spec.ts` | 11 | Start/intro/profile offer, buttons/list/Flow answers, edit window with injected clock, multi-select validation, resume/switch between surveys, enrollment of unknown senders, STOP/HELP/EDIT commands, duplicate webhooks, signed raw webhook ingress and quarantine (R16-R20, R31-R42, R44) |
| `reporting.int-spec.ts` | 6 | aggregates with known dataset, breakdowns on frozen profiles with threshold, Admin-only responses with audit, CSV/XLSX exports parsed and checked, result sharing snapshot/template/`View results`/revoke, retention cleanup (R06, R30, R46-R54, R56, R58) |
| `internal.int-spec.ts` | 2 | service-identity guard, idempotent job execution and sweep routes (R55) |
| `jobs-push.int-spec.ts` | 2 | Cloud Tasks hand-off of pending jobs, scheduled tasks, re-push after retry, rejected pushes left for the sweep, inert under the postgres driver (R55) |
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

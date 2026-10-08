# Raaye

Raaye lets an organization ask structured questions through WhatsApp, collect permission-based answers, and read accurate, traceable results from one dashboard. This repository contains the complete locally runnable MVP described in `MVP.md`: an Angular dashboard, a NestJS API and worker, PostgreSQL persistence with Prisma migrations, a Firebase Authentication emulator for staff sign-in, a realistic WhatsApp participant simulator, and a real WhatsApp Cloud API adapter with a documented setup path.

> **Identifiable, not anonymous.** Authorized organization Admins can link answers to contacts. Participants are told this in the participant notice they agree to (versioned, and recorded with their consent evidence) and in the checked-in invitation template; the shorter invitation shown by the local preview and simulator does not repeat it. Aggregate views, cohort thresholds and export restrictions are disclosure controls, not an anonymity guarantee.

## Quick start (Docker)

Requirements: Docker Desktop or Docker Engine with Compose v2. No local Node, PostgreSQL, Firebase account, Meta account or cloud credentials are needed. The first build downloads images and dependencies.

```bash
cp .env.example .env           # PowerShell: Copy-Item .env.example .env
docker compose up --build -d
```

Then open **http://localhost:8080** and sign in with one of the local demo accounts (they exist only in the local Auth emulator and are created only when `ALLOW_DEMO_BOOTSTRAP=true`):

| Account | Password | Role |
| --- | --- | --- |
| `admin@pilap.demo` | `Raaye-Admin-2026!` | Admin |
| `manager@pilap.demo` | `Raaye-Manager-2026!` | Survey Manager |
| `viewer@pilap.demo` | `Raaye-Viewer-2026!` | Viewer |
| `admin@lcf.demo` | `Raaye-OrgB-2026!` | Admin of a second tenant (isolation demo) |

What runs:

| Service | Address | Purpose |
| --- | --- | --- |
| `web` | http://localhost:8080 | Dashboard (nginx, `/api` proxied to the API) |
| `api` | http://localhost:8080/api/v1, OpenAPI at `/api/docs` through the proxy | NestJS API |
| `worker` | — | Durable job loop (sends, lifecycle, inbound processing, sweeps, retention) |
| `auth` | http://127.0.0.1:9099 | Firebase Authentication emulator (project `demo-raaye`) |
| `db` | 127.0.0.1:5432 | PostgreSQL 16 (`raaye`/`raaye`) |
| `bootstrap` | one-shot | Applies migrations and runs the idempotent synthetic seed |

Restarting (`docker compose restart` or `up` again) keeps every user-created record. The seed adds what is missing, except that it resets the four demo accounts (role, active membership and status, display name and Firebase uid) to their seeded values, so a role change or revocation made on a demo account is undone on the next start. `docker compose down -v` deletes the database volume.

The seeded demo (organization "Public Interest Law Association of Pakistan (demo)") contains 28 synthetic contacts covering every demographic field, consent state and group/tag, plus:

- a draft survey with all five question types,
- a scheduled survey (48-hour default duration),
- an active survey with partial and completed responses, an edited answer, an opt-out, a permanent delivery failure and an ambiguous (timed-out) send,
- a closed survey whose aggregate results were shared with eligible respondents,
- an archived survey,
- a second tenant with its own contacts and survey (the same phone number exists in both tenants with separate consent).

All seeded phone numbers are synthetic (`is_synthetic`) and can never be sent to a live provider.

## Using the demo

1. **Overview**: counts, attention items (failed/unknown sends, blocked dispatch), recent surveys. The yellow **MOCK MESSAGING** badge is always visible while no real provider is configured.
2. **Contacts**: add contacts, record consent evidence (imports and replies never count as consent), manage groups/tags, import CSV/XLSX through the wizard (`fixtures/imports/` has a valid file and an intentionally invalid one; an import that stops part-way shows what was applied and can be resumed within the 24-hour staging window without importing any row twice), export the directory.
3. **Surveys**: author questions, choose the audience, preview exact WhatsApp renderings, check eligibility, send a test, launch now or schedule, watch dispatch, read results and demographic breakdowns, export CSV/XLSX, and (Admin) inspect individual answers or share results after closure.
4. **WhatsApp simulator** (Admin, development only): pick a synthetic contact, tap invitation buttons, answer questions (buttons, lists, Flow forms), type `STOP`, `HELP`, `START`, `RESUME`, `PROFILE`, `EDIT 2`, `RESULTS`, advance the simulated clock to expire edit windows or service windows, inject delivery failures, duplicate callbacks and timeouts. Every simulator action goes through the same inbound pipeline as a real webhook.
5. **Settings**: organization profile and participant notice, survey defaults (Admin), staff invitations and roles (Admin), messaging configuration and readiness (Admin).
6. **Audit log** (Admin): sensitive actions without personal data.

## Host development (without Docker for the app)

Requirements: Node 22.22.0, pnpm 10.28.0 (`corepack enable`), PostgreSQL 16 reachable at `DATABASE_URL` (for example `docker compose up -d db`).

```bash
cp .env.example .env
pnpm install
pnpm db:generate            # Prisma client
pnpm dev                    # auth emulator + migrations + seed + API + worker + Angular dev server
```

Dashboard: http://127.0.0.1:4200 (the dev server proxies `/api` to http://127.0.0.1:3000). OpenAPI: http://127.0.0.1:3000/api/docs.

### Commands

| Command | What it does |
| --- | --- |
| `pnpm lint` | ESLint across all projects |
| `pnpm typecheck` | Strict TypeScript for libraries, apps and test files |
| `pnpm test` | Unit tests (domain rules, policy gate, Meta contract, configuration, Cloud Tasks adapter) |
| `pnpm test:integration` | API integration tests against PostgreSQL (`TEST_DATABASE_URL`), including two-tenant isolation, launch/scheduling, the conversation engine, reporting/exports/sharing, retention, internal task routes and the 1,000-contact scenario |
| `pnpm test:e2e` | Playwright critical journeys (prepares the auth emulator, migrations and seed; starts the API and the dev server if needed) |
| `pnpm build` | Production builds for `api`, `worker` and `web` |
| `pnpm db:migrate` | `prisma migrate deploy` |
| `pnpm db:migrate:dev` | Create a new migration during development |
| `pnpm db:seed` | Idempotent synthetic demo seed (runs through the built worker bundle) |
| `pnpm seed:scale` | Adds 1,000 synthetic consented contacts for performance testing |
| `pnpm bootstrap:org -- --name <name> --slug <slug> --admin-email <email>` | Creates an organization and prints a single-use Admin invitation link once (the live-deployment path; needs no demo data) |
| `pnpm db:reset -- --yes` | Development-only reset (refuses non-local databases) |
| `pnpm verify` | Lint, typecheck, unit, integration, WhatsApp asset validation and production builds; `-- --e2e` adds Playwright, `-- --docker` adds the Compose smoke test |
| `pnpm whatsapp:validate` | Validates Flow JSON assets, Flow response fixtures and template specifications against the adapter |
| `pnpm docker:up` / `pnpm docker:down` | Compose helpers |

Worker CLI (same commands inside the container: `docker compose run --rm worker <command>`): `worker`, `sweep`, `run-once`, `retention`, `seed`, `seed:scale [count]`, `bootstrap:org --name <name> --slug <slug> --admin-email <email>` (first organization and Admin invitation for a live deployment; see `DEPLOYMENT.md`).

## Repository layout

```
apps/api            NestJS HTTP API (controllers, OpenAPI, webhook ingress, internal task routes)
apps/worker         Job loop, sweeps, retention and CLI commands
apps/web            Angular dashboard and simulator UI
apps/web-e2e        Playwright journeys
libs/contracts      Zod schemas and DTOs shared by API and dashboard
libs/domain         Pure domain rules (edit windows, consent, selections, aggregates, CSV/XLSX, phone, copy)
libs/server         NestJS modules: persistence, auth, contacts, surveys, jobs, messaging, conversation, reporting, seed
prisma              Schema and migrations
whatsapp            Flow JSON assets, response fixtures and template specifications
fixtures/imports    CSV import fixtures (valid and invalid); the XLSX tests build their workbooks in code
infra               Dockerfiles, nginx, Firebase emulator config
scripts             dev, verify, seed/CLI runner, db reset, Docker smoke, WhatsApp validation
docs                DECISIONS.md and operational notes
plan                acceptance.md (R01-R60 mapping) and verification.md (what actually ran)
```

## Live WhatsApp and deployment

The code includes a real Meta WhatsApp Cloud API adapter, signed webhook ingress, template/Flow readiness checks, Cloud Tasks and Cloud Scheduler entry points and a production configuration validator. None of it has been exercised against a live Meta account or a GCP project in this repository. See:

- `WHATSAPP_SETUP.md` — Meta app, WABA, phone number, webhook, templates, Flows, policy review.
- `DEPLOYMENT.md` — GCP reference layout and environment variables (documentation only; nothing is provisioned).
- `SECURITY.md` — roles, tenant isolation, data handling, retention and what the MVP does not promise.

Setting `MESSAGING_MODE=live` makes configuration validation fail closed unless every required secret reference is present, the emulator and simulator are disabled, demo bootstrap is off and authentication is live. There is no silent fallback to mock mode.

A live deployment gets its first organization and Admin from the operator command `bootstrap:org` (worker CLI, documented in `DEPLOYMENT.md`): it issues a single-use Admin invitation, works without the demo bootstrap and refuses once an active Admin exists.

## Versions

Node 22.22.0 · pnpm 10.28.0 · Nx 23.2.1 · TypeScript 5.9.3 · Angular 21.2.25 · Angular Material 21.2.14 · NestJS 11.2.7 · Prisma 7.10.0 · PostgreSQL 16.15 · Jest 30.5.2 · Playwright 1.63.0 · ESLint 10.12.0 · zod 4.6.5 · firebase 12.19.0 · firebase-admin 14.5.0 · firebase-tools 15.32.1 (emulator). See `docs/DECISIONS.md` for the reasoning.

## License

MIT, see `LICENSE`.

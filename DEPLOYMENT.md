# Deployment reference (GCP)

This document describes a production layout that the code supports. **Nothing here has been provisioned or exercised.** It does not authorize deployment; it tells the operator what the application expects.

## Components

| Component | Service | Notes |
| --- | --- | --- |
| API | Cloud Run (`apps/api`) | Public HTTPS for the dashboard API and the Meta webhook. Container `raaye-app:<tag>` with command `api`. |
| Task receiver | Cloud Run (`apps/api` bundle, command `api`) | Receives Cloud Tasks pushes on `/api/v1/internal/jobs/:id/execute` and Cloud Scheduler calls on `/api/v1/internal/sweep`. The internal routes live in the API bundle, so this is the same image and command as the API: the same service, or a separate one with min instances 0. `WORKER_BASE_URL` is its URL. `apps/worker` (command `worker`) serves no HTTP: it is the polling loop for an always-on instance (`JOB_DRIVER=postgres`) and the one-shot operator commands (`seed`, `sweep`, `run-once`, `retention`, `bootstrap:org`). |
| Dashboard | Cloud Run (nginx image target `web`) or any static host | The dashboard calls a relative `/api/v1`, so `/api` must reach the API on the dashboard's own origin. The checked-in `infra/docker/nginx.conf` proxies `/api/` only to the Compose service `api:3000` through Docker's resolver (127.0.0.11), and the upstream is not configurable by an environment variable. On Cloud Run, either route `/api/*` to the API service in front of the dashboard (for example an HTTPS load balancer) or replace the proxy block of `nginx.conf` (upstream, resolver, Host header, TLS) before building the `web` target. |
| Database | Cloud SQL for PostgreSQL 16 | Private IP or the Cloud SQL connector; `DATABASE_URL` with SSL. |
| Jobs | Cloud Tasks queue + Cloud Scheduler | `JOB_DRIVER=cloud_tasks`; the periodic sweep runs every minute via Scheduler calling `/internal/sweep` with an OIDC token. |
| Auth | Firebase Authentication (email/password) | `AUTH_MODE=live`, `FIREBASE_PROJECT_ID=<real project>`; password-reset action links use Firebase's hosted pages. |
| Secrets | Secret Manager → environment variables | Meta app secret, access token, verify token, internal task token. |

## Environment variables (API and worker)

```text
APP_ENV=production
LOG_LEVEL=info
WEB_ORIGIN=https://dashboard.example.org
DATABASE_URL=postgresql://user:pass@/raaye?host=/cloudsql/<project>:<region>:<instance>
AUTH_MODE=live
FIREBASE_PROJECT_ID=<firebase project>
PUBLIC_FIREBASE_API_KEY=<Firebase web API key>   # served to the dashboard by /api/v1/auth/config; not validated at startup
MESSAGING_MODE=live
ENABLE_SIMULATOR=false
ALLOW_DEMO_BOOTSTRAP=false
JOB_DRIVER=cloud_tasks
GCP_PROJECT_ID=<project>
CLOUD_TASKS_LOCATION=<region>
CLOUD_TASKS_QUEUE=raaye-jobs
WORKER_BASE_URL=https://<worker service url>
TASK_SERVICE_ACCOUNT_EMAIL=<tasks service account>
INTERNAL_TASK_TOKEN=<32+ random characters>   # fallback shared secret when JOB_DRIVER=postgres
META_*                                          # see WHATSAPP_SETUP.md
```

`loadConfig()` validates everything at startup and refuses production with an emulator host, demo project IDs, simulator routes or demo bootstrap. It also refuses missing Meta values when `MESSAGING_MODE=live` and missing Cloud Tasks values when `JOB_DRIVER=cloud_tasks`. Production does not force `MESSAGING_MODE=live`: leaving it unset runs the mock provider, so set it explicitly.

## Task delivery

- The jobs table remains the source of truth. With `JOB_DRIVER=cloud_tasks`, `JobsService.pushDue` hands every pending job that has not been pushed yet to Cloud Tasks as an HTTP task (task name `job-<id>-<attempt>`, so a double push is rejected by the queue and a retry after backoff gets a fresh task); it runs right after jobs are enqueued and again on every sweep, and `pushed_at` records the hand-off. Handlers are idempotent so a redelivery is harmless.
- `/api/v1/internal/jobs/:id/execute` claims the job with the lease mechanism, runs it once and returns `DONE`, `RETRY`, `FAILED`, `LOST` (the lease expired and was reclaimed before the outcome could be recorded; the new claim owns the job) or `NOT_CLAIMABLE`.
- `/api/v1/internal/sweep` recovers expired leases, activates/closes due runs, reconciles unmatched delivery statuses, runs retention cleanup hourly, and processes a bounded batch of due jobs. Schedule it every minute; it is safe to overlap.
- Both routes require a Google OIDC token for `TASK_SERVICE_ACCOUNT_EMAIL` with audience `WORKER_BASE_URL` (verified with `google-auth-library`). Locally they accept the shared `INTERNAL_TASK_TOKEN`.
- Do not rely on an idle Cloud Run instance running the in-process worker loop; use the push model above or run the worker loop on an always-on instance.

## Migrations

Run `node node_modules/prisma/build/index.js migrate deploy` (the image entrypoint's `bootstrap` command does this and then seeds; in production use `migrate deploy` only — the seed refuses to run without `ALLOW_DEMO_BOOTSTRAP=true`, which production configuration rejects).

## First organization and Admin

A live deployment has no demo seed (`ALLOW_DEMO_BOOTSTRAP` must be false), and staff invitations need an existing Admin. The first organization and its first Admin therefore come from the operator command in the worker CLI, which needs only the application environment (`DATABASE_URL`, `WEB_ORIGIN` and the rest of the validated configuration) and works in live configuration:

```
raaye-entrypoint bootstrap:org --name "Public Interest Law Association of Pakistan" --slug pilap --admin-email admin@example.org [--support-contact "..."] [--timezone Asia/Karachi]
```

Inside the image this is `node dist/apps/worker/main.js bootstrap:org ...`; on a host checkout it is `pnpm bootstrap:org -- --name ... --slug ... --admin-email ...`; with Compose it is `docker compose run --rm worker bootstrap:org ...`. The command:

- creates the organization when the slug is new, with the default duration and edit window and a placeholder participant notice that the Admin must review in **Settings → Organization** before launching anything;
- issues a single-use Admin invitation for the address, valid for 72 hours, and prints the result once as JSON on stdout, including the acceptance link. Send that link to the Admin through a trusted channel: opening it in the dashboard creates their Firebase account with a password they choose (or attaches an existing account that carries the same email) and the Admin membership. The structured log records the organization and invitation ids only, never the link; where stdout is captured by a log system (a Cloud Run job, for example), treat that entry as sensitive, or run the command from an operator workstation through the Cloud SQL Auth Proxy;
- replaces every pending bootstrap link when run again before acceptance, including a link issued to a different address when the email is corrected (the earlier links stop working), and refuses with `BOOTSTRAP_REFUSED` once the organization has an active Admin, so further staff are always invited from **Settings → Staff**;
- writes an `organization.bootstrapped` audit event for the organization on every run.

An Admin then creates the organization's live sender by saving **Settings → Messaging** once (see `WHATSAPP_SETUP.md`); the save creates the connection row and its webhook app key.

## Observability

Structured pino logs with correlation ids; no personal data in logs. `GET /api/v1/health/live` and `/health/ready` (database check) for probes.

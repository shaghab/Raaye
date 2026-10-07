# Deployment reference (GCP)

This document describes a production layout that the code supports. **Nothing here has been provisioned or exercised.** It does not authorize deployment; it tells the operator what the application expects.

## Components

| Component | Service | Notes |
| --- | --- | --- |
| API | Cloud Run (`apps/api`) | Public HTTPS for the dashboard API and the Meta webhook. Container `raaye-app:<tag>` with command `api`. |
| Worker | Cloud Run (`apps/worker`) | Receives Cloud Tasks pushes on `/api/v1/internal/jobs/:id/execute` and Cloud Scheduler calls on `/api/v1/internal/sweep`. Same image, command `api` (the internal routes live in the API bundle) or a dedicated service with min instances 0. |
| Dashboard | Cloud Run (nginx image target `web`) or any static host | `/api` must proxy to the API. |
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

`loadConfig()` validates everything at startup and refuses production with an emulator host, demo project IDs, simulator routes, demo bootstrap, or missing Meta/Cloud Tasks values.

## Task delivery

- The jobs table remains the source of truth. With `JOB_DRIVER=cloud_tasks`, `JobsService.pushDue` hands every pending job that has not been pushed yet to Cloud Tasks as an HTTP task (task name `job-<id>-<attempt>`, so a double push is rejected by the queue and a retry after backoff gets a fresh task); it runs right after jobs are enqueued and again on every sweep, and `pushed_at` records the hand-off. Handlers are idempotent so a redelivery is harmless.
- `/api/v1/internal/jobs/:id/execute` claims the job with the lease mechanism, runs it once and returns `DONE`, `RETRY`, `FAILED` or `NOT_CLAIMABLE`.
- `/api/v1/internal/sweep` recovers expired leases, activates/closes due runs, reconciles unmatched delivery statuses, runs retention cleanup hourly, and processes a bounded batch of due jobs. Schedule it every minute; it is safe to overlap.
- Both routes require a Google OIDC token for `TASK_SERVICE_ACCOUNT_EMAIL` with audience `WORKER_BASE_URL` (verified with `google-auth-library`). Locally they accept the shared `INTERNAL_TASK_TOKEN`.
- Do not rely on an idle Cloud Run instance running the in-process worker loop; use the push model above or run the worker loop on an always-on instance.

## Migrations

Run `node node_modules/prisma/build/index.js migrate deploy` (the image entrypoint's `bootstrap` command does this and then seeds; in production use `migrate deploy` only — the seed refuses to run without `ALLOW_DEMO_BOOTSTRAP=true`, which production configuration rejects).

After the first deployment an Admin creates the organization's live sender by saving **Settings → Messaging** once (see `WHATSAPP_SETUP.md`); the save creates the connection row and its webhook app key. Creating the first organization, user and Admin membership in a live deployment is not automated yet and requires an operator database insert; this gap is tracked in [issue #13](https://github.com/shaghab/Raaye/issues/13).

## Observability

Structured pino logs with correlation ids; no personal data in logs. `GET /api/v1/health/live` and `/health/ready` (database check) for probes.

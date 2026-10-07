# Acceptance matrix (R01-R60)

Status legend: **Done** = implemented with the listed evidence; **Done (local)** = implemented and verified locally, live-account verification remains external; **Partial** = implemented with a documented gap. Evidence paths are relative to the repository root. Test names refer to `describe`/`it` titles.

| ID | Requirement (abridged) | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- |
| R01 | Clean Docker startup reaches a usable dashboard with demo credentials | `docker-compose.yml`, `infra/docker/*`, `infra/firebase/*`, seed via `bootstrap` | `scripts/docker-smoke.ts` (`pnpm verify -- --docker`), `plan/verification.md` | See verification |
| R02 | Restart preserves user data and stable seed identities | Idempotent `SeedService` (`libs/server/src/seed/seed.service.ts`), persistent `raaye-db` volume | Seed re-run report (`skipped` list), `scripts/docker-smoke.ts` restart check | Done (local) |
| R03 | Login, logout, reset, invitation acceptance | `apps/web/src/app/features/auth/*`, `staff-invitations.controller.ts`, `OrganizationService.createInvitation/acceptInvitation` | E2E `auth-and-roles.spec.ts`; integration `auth-membership.int-spec.ts` ("invitations are single-use…") | Done |
| R04 | Role matrix enforced server-side | `AuthGuard`, `@Roles`, controllers | Integration `auth-membership.int-spec.ts`, `reporting.int-spec.ts` ("only Admin can read identifiable answers"), E2E viewer journey | Done |
| R05 | Membership revocation immediate; last Admin protected | `OrganizationService.updateMember/revokeMember` (organization row lock serializes the check and the mutation) | Integration `auth-membership.int-spec.ts` ("concurrent Admin downgrades cannot remove the last Admin") | Done |
| R06 | Only Admin sees identifiable answers/exports; audited | `ReportingController` role guards, `AuditService` | Integration `reporting.int-spec.ts` (403 for Manager/Viewer, audit without PII) | Done |
| R07 | Two-tenant isolation across API, jobs, webhooks, exports | `createTenantDb` (`libs/server/src/persistence/tenant-db.ts`), composite FKs | Integration `tenant-constraints.int-spec.ts`, `contacts.int-spec.ts`, `conversation.int-spec.ts` (webhook quarantine), E2E tenant test | Done |
| R08 | DB constraints prevent cross-tenant relations | `prisma/schema.prisma` `(organizationId, id)` uniques and composite FKs | Integration `tenant-constraints.int-spec.ts` | Done |
| R09 | Organization settings, timezone, participant notice | `OrganizationController`, settings UI | Integration `auth-membership.int-spec.ts`; E2E settings view | Done |
| R10 | Contact uniqueness per organization + normalized phone | `ContactsService.create`, `normalizePhone` | Integration `contacts.int-spec.ts` ("same phone in two organizations…") | Done |
| R11 | Manual add/edit/archive with provenance | `ContactsService`, contact form/detail UI | Integration `contacts.int-spec.ts`; E2E `contacts.spec.ts` | Done |
| R12 | CSV/XLSX import wizard with validation, duplicates, attestation | `ImportService`, `import-wizard.component.ts`, fixtures | Integration `contacts.int-spec.ts` (import tests); E2E import preview | Done |
| R13 | Groups/tags | `GroupsTagsService`, UI | Integration `contacts.int-spec.ts` | Done |
| R14 | Consent evidence, scopes, withdrawal history; imports are not consent | `ConsentService`, `deriveConsent` | Unit `consent.spec.ts`; integration `contacts.int-spec.ts`, `conversation.int-spec.ts` (STOP) | Done |
| R15 | Invitation with Start survey; voluntary notice | `MessagePlanner.invitation`, templates | Integration `surveys-launch.int-spec.ts`, `conversation.int-spec.ts` | Done |
| R16 | Yes/No and Yes/No/Indifferent as buttons | `planRenderer`, planner | Unit `questions.spec.ts`; E2E journey | Done |
| R17 | Single choice as buttons/list/Flow by size | `planRenderer` | Unit `questions.spec.ts`; integration conversation tests | Done |
| R18 | Multiple selection as a submitted set with min/max/exclusive | `validateSelection`, multi-choice Flow, `AnswerService` | Unit `questions.spec.ts`; integration `conversation.int-spec.ts`; E2E journey | Done |
| R19 | Rating 1-5 list | planner | Integration conversation tests; E2E journey | Done |
| R20 | Participant-initiated enrollment with affirmative consent | `ConversationService.handleEnrollmentText/offerConsent` | Integration `conversation.int-spec.ts` ("unknown senders…") | Done |
| R21 | STOP precedence, cancels pending sends | `handleStop`, `OutreachCancellation` | Integration `conversation.int-spec.ts`, `surveys-launch.int-spec.ts`; E2E STOP test | Done |
| R22 | Missing template/Flow blocks live readiness explicitly | `MessagingReadinessService.check` (templates, Flows, secrets, disabled connection) | Unit `policy.spec.ts`, `env.spec.ts`; integration `surveys-launch.int-spec.ts` ("a disabled messaging connection…"); readiness UI | Done (local) |
| R23 | Survey authoring limits and validation | `surveyDraftSchema`, `SurveysService.contentErrors` | Integration `surveys-launch.int-spec.ts` | Done |
| R24 | Audience modes, preview, freeze at launch | `AudienceService`, `LaunchService.launch` | Integration `surveys-launch.int-spec.ts` | Done |
| R25 | Scheduling with durable jobs | `jobs` table, `ActivateSurveyHandler`, `SweepService` (blocked activations retried every minute until the closing time) | Integration `surveys-launch.int-spec.ts` (including "a run whose readiness breaks before activation…"), `internal.int-spec.ts` | Done |
| R26 | 48-hour default from intended opening | `computeClosesAt` | Unit `schedule.spec.ts`; integration launch tests | Done |
| R27 | Automatic closing, expired-before-activation | `CloseSurveyHandler`, sweep | Integration `surveys-launch.int-spec.ts` | Done |
| R28 | Test mode runs isolated from results | `createTestRun`, `isTest` flags | Integration `reporting.int-spec.ts` (test run excluded) | Done |
| R29 | Unschedule returns to draft | `LaunchService.unschedule` | Integration `surveys-launch.int-spec.ts` | Done |
| R30 | Results exclude test participation | reporting SQL filters | Integration `reporting.int-spec.ts` | Done |
| R31 | One canonical answer per participation/question | `answers` unique, `AnswerService` | Integration `conversation.int-spec.ts` | Done |
| R32 | Edit within window replaces answer, keeps history | `AnswerService.submit` | Integration `conversation.int-spec.ts`; `reporting.int-spec.ts` (revisions) | Done |
| R33 | Fixed deadline from first answer, no reset | `evaluateEdit` | Unit `edit-window.spec.ts`; integration conversation tests with injected clock | Done |
| R34 | Reject at expiry / after close; zero disables | `evaluateEdit`, close handling | Unit + integration; E2E expiry step | Done |
| R35 | Concurrency safety (row locks, uniqueness) | `SELECT … FOR UPDATE`, unique constraints | Integration `conversation.int-spec.ts` (duplicate webhook events) | Done |
| R36 | Optional profile onboarding, skippable, self-report never overrides verified membership | `handleFlow` profile branch, `profileProvenance` | Integration `conversation.int-spec.ts` | Done |
| R37 | Resume / interrupted survey behaviour | foreground/background participation, RESUME | Integration `conversation.int-spec.ts`; seed (switch survey) | Done |
| R38 | Multiple surveys without cross-wiring | action bindings, continue/switch menu | Integration `conversation.int-spec.ts` | Done |
| R39 | HELP/EDIT/PROFILE/RESULTS commands | `parseCommand`, `ConversationService` | Unit `commands.spec.ts`; integration conversation tests | Done |
| R40 | Raw webhook signature verification, batch processing | `verifyWebhookSignature`, `parseMetaWebhook`, `WebhooksController`; batches for a disabled connection are quarantined | Unit `meta-contract.spec.ts`; integration `conversation.int-spec.ts` (including "quarantines signed webhook traffic for a disabled connection…") | Done (local) |
| R41 | Inbox persisted before success; outbox atomic | `InboxService.ingest` (inbox row + job in one transaction), `DeliveryService.createMessage` in transactions | Integration `inbox.int-spec.ts`, conversation/launch tests | Done |
| R42 | Duplicate events ignored | `providerMessageId` uniqueness; a duplicate of a pending row without a job re-enqueues processing | Integration `conversation.int-spec.ts`, `inbox.int-spec.ts` | Done |
| R43 | Ambiguous send → UNKNOWN, explicit retry | `DeliveryService.send/retry`; Meta adapter classifies timeouts and post-transmission resets as UNKNOWN | Unit `meta-contract.spec.ts`; integration `surveys-launch.int-spec.ts` (ambiguous sends, disabled-connection suppression and Admin retry); seed fixture; dispatch UI | Done |
| R44 | Unknown connection quarantined | `InboxService.resolveConnection/quarantine` | Integration `conversation.int-spec.ts` | Done |
| R45 | No free-form outside the 24-hour window; templates don't open it | `evaluateSendPolicy`, `serviceWindowOpen` | Unit `policy.spec.ts`, `service-window.spec.ts` | Done |
| R46 | Aggregates from canonical answers with correct denominators | `ReportingService.results` | Integration `reporting.int-spec.ts` (known dataset) | Done |
| R47 | Multi-select percentages of respondents; N/A for zero | `aggregates.ts` | Unit `aggregates.spec.ts`; integration reporting | Done |
| R48 | Demographic breakdowns on frozen profiles with threshold | `ReportingService.breakdowns` | Integration `reporting.int-spec.ts` | Done |
| R49 | Admin-only individual responses with revision history, audited | `ReportingService.responses` | Integration `reporting.int-spec.ts` | Done |
| R50 | CSV/XLSX exports parsed and verified; formula neutralization; phone as text | `ExportService`, `spreadsheet.ts`, `csv.ts` | Unit `spreadsheet.spec.ts`, `csv.spec.ts`; integration `reporting.int-spec.ts`, `contacts.int-spec.ts`; E2E downloads | Done |
| R51 | Admin-initiated sharing after closure with frozen snapshot | `SharingService.share` | Integration `reporting.int-spec.ts` | Done |
| R52 | Results outreach uses template outside window; View results returns snapshot | `SharingService`, `showResults` | Integration `reporting.int-spec.ts` | Done (local) |
| R53 | Eligibility: real respondents, results permission, opt-outs | `SharingService.preview` | Integration `reporting.int-spec.ts` | Done |
| R54 | Small-sample questions withheld; single broadcast | `SharingService` | Integration `reporting.int-spec.ts` | Done |
| R55 | Cloud Tasks / Scheduler task handlers with service identity | `InternalController`, `InternalTaskGuard`, `CloudTasksAdapter`, `JobsService.pushDue` (hand-off after enqueue and on every sweep, `pushed_at` tracking) | Unit `cloud-tasks.spec.ts`; integration `internal.int-spec.ts`, `jobs-push.int-spec.ts` | Done (local; OIDC path and the live queue untested against Google) |
| R56 | Retention cleanup | `RetentionService` | Integration `reporting.int-spec.ts` (retention test) | Done |
| R57 | Live configuration fails closed; synthetic contacts never sent live | `loadConfig`, `evaluateSendPolicy` | Unit `env.spec.ts`, `policy.spec.ts` | Done |
| R58 | Audit of sensitive actions without PII | `AuditService` | Integration `reporting.int-spec.ts`, `contacts.int-spec.ts` | Done |
| R59 | 1,000-contact launch, restart during dispatch, fast results | `scale.int-spec.ts`, `seed:scale` | Integration `scale.int-spec.ts` (timings in `plan/verification.md`) | Done (local) |
| R60 | Honest final reporting, documentation, verification evidence | `README.md`, `docs/DECISIONS.md`, `plan/verification.md`, `WHATSAPP_SETUP.md`, `DEPLOYMENT.md`, `SECURITY.md` | This file and `plan/verification.md` | Done |

## Known gaps and external steps

- Live Meta verification (template approval, Flow publication, real webhook traffic, delivery reconciliation on real numbers) and GCP deployment have not been performed; the adapters, validators and guides exist. See `WHATSAPP_SETUP.md` §7 and `DEPLOYMENT.md`.
- Password reset in the local emulator is verified through the emulator outbox (links listed in the simulator page); a real email provider is a production concern of Firebase.
- Urdu/RTL presentation is out of scope; the content model is locale-ready.

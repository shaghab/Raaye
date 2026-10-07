# Raaye: Coding Agent Instructions

These instructions apply to the entire repository. Build the application described in `MVP.md`, using `VISION.md` for product intent. Do not substitute a smaller prototype or a collection of scaffolds.

## 1. Read the contract first

Read `VISION.md` and the whole of `MVP.md`, including the acceptance matrix and deployment boundaries. Read long files in chunks when needed; do not treat the first screenful or a generated summary as the specification.

Repository document roles:

- `VISION.md`: purpose, users, product principles, future direction.
- `MVP.md`: authoritative functional scope, defaults, data rules, API behavior, acceptance conditions.
- `AGENTS.md`: engineering and execution discipline.
- `CLAUDE.md`: compatibility import of this file, not another specification.
- `docs/DECISIONS.md`: material implementation choices and their rationale.
- `plan/acceptance.md`: requirement IDs mapped to code, tests, and actual evidence.
- `plan/verification.md`: commands run, outcomes, failures, and external verification gaps.

Explicit subsequent product-owner instructions override earlier product choices. Security constraints and external API limitations must be reported and handled honestly, not bypassed. Do not rewrite the acceptance criteria to make unfinished code appear complete.

## 2. Work autonomously, within the authorized boundary

The user has already answered the product questions. Do not ask them again. Make reasonable implementation decisions, record material assumptions, and continue. Implement working code rather than ending with a plan.

The authorized outcome is a locally runnable MVP, including tests, Docker, and a real-provider integration path. It does not include creating cloud resources, enabling billing, sending messages to real people, changing Meta assets, creating a GitHub repository, or pushing code remotely.

Never execute a paid, public, destructive, or externally visible operation merely because credentials happen to exist in the environment. Real test sends and live deployment need a separate explicit instruction. Local synthetic tests and ordinary repository edits are authorized.

Inspect the existing repository and working tree before changing it. Preserve unrelated files and uncommitted work. Do not force-push, reset the repository, overwrite unknown secrets, or delete user data. Guard destructive development reset commands so they cannot target a live database.

A missing Meta token or GCP account is not a reason to stop. Finish the simulator-backed implementation and contract tests. Clearly identify live verification that remains external.

## 3. The result must be a working product

All of the following are required, not stretch goals:

- Angular dashboard with real API-backed screens and email/password authentication.
- NestJS backend, PostgreSQL persistence, checked-in Prisma migrations, and tenant-scoped authorization.
- Manual/CSV/XLSX contacts, consent evidence, opt-outs, groups/tags, and optional participant profiling.
- All five requested question types, including working multiple-selection submission.
- Scheduled sending, automatic closure, test mode, limited answer changes, resume/switch behavior, and durable queues.
- Accurate aggregates, demographic breakdowns, exports, Admin-only individual answers, and result sharing.
- A realistic local participant simulator using the same domain services as the live adapter.
- A real WhatsApp Cloud API adapter, checked-in Flow assets, webhook handling, configuration validation, and setup guide.
- Reproducible Docker startup, meaningful tests, production builds, seed data, and honest verification evidence.

Do not implement the happy path and label consent, multi-select, exports, or tenancy as future work. No in-scope screen may consist of a TODO button, a hard-coded chart, or an array that disappears on refresh.

## 4. Implementation sequence

Use small verified vertical slices rather than generating the whole codebase without running anything.

1. Establish the pinned toolchain, workspace, Docker, PostgreSQL migrations, emulated auth, role model, and tenant-scoped persistence. Prove two-tenant isolation early.
2. Implement contacts, imports, consent, and basic survey authoring.
3. Complete an end-to-end invitation -> participant answer -> persisted result path through the real local simulator pipeline.
4. Add durable schedules, dispatch, webhook inbox/outbox, retries, window checks, and automatic closing.
5. Finish every question type, optional onboarding, answer revisions, concurrency, and interrupted/multiple survey behavior.
6. Finish reporting, demographic snapshots, exports, individual access, and result sharing.
7. Harden security/failure handling, complete UI states, run the full suite, test Docker startup, and finish operational documentation.

Maintain the acceptance checklist as you work. After each slice run the relevant checks and fix errors before building additional features on broken foundations.

## 5. Stack and dependency choices

Use Angular, NestJS, PostgreSQL, Prisma, Nx, pnpm, Jest, and Playwright. Angular Material is the default UI component library. Use Firebase Authentication and its local emulator. Do not substitute React, Next.js, an unstructured Express backend, SQLite, or a browser-only database.

Select a mutually compatible stable Node/Angular/Nest/Nx/Prisma/TypeScript version set. Check primary documentation and installed tool capabilities rather than guessing. Pin versions and check in the lockfile. Do not use floating `latest` tags for reproducible runtime images.

Prefer a small set of maintained dependencies. Review CSV/XLSX parsing packages for current support and known security issues. Do not import the archived WhatsApp Node SDK simply because its old examples appear in the reference list. A small typed HTTP adapter is preferable.

No runtime LLM, vector database, Kubernetes, Kafka, Redis, billing framework, Terraform, or CI/CD platform is needed. Do not add GitHub Actions. GCP adapters and deployment documentation do not authorize deployment.

Use the toolchain's supported features and conventions. Record the exact versions selected in the README. If an execution environment cannot download dependencies or run Docker, continue code work where possible and mark affected checks Not run rather than falsely claiming success.

## 6. Engineering style

Use strict TypeScript. Avoid `any`, unsafe casts, non-null assertions that conceal nullable states, and blanket lint/type-check suppression. External JSON starts as `unknown` and is validated into a discriminated type.

Choose short, meaningful domain names: Survey, Question, Answer, Contact, Consent, Participation, Message, Job. Do not create long ceremonial class names or generic enterprise abstractions that add no behavior.

Use DRY and SOLID to reduce actual duplication and coupling, not to add factories or inheritance around every function. Favor composition. Apply a Strategy/Adapter pattern to messaging providers and question renderers because those vary; do not build a general workflow framework for fixed survey sequences.

Keep controllers thin, domain rules testable, and persistence concerns in scoped repositories. Prefer explicit transactions and typed DTOs over magic decorators that obscure authorization or side effects.

Use dependency injection where the framework provides it. Validate configuration once at startup. Keep UI validation aligned with API rules, while retaining authoritative server-side enforcement.

Do not swallow exceptions, return HTTP success after a failed operation, or label provider acceptance as delivery. Expose safe domain error codes and actionable staff messages.

## 7. Tenant isolation is non-negotiable

Every tenant-owned row, relation, job, export, action binding, and message belongs to an organization. PILAP is seed data, not a global constant.

Resolve staff tenant context from verified identity plus active membership. A supplied organization ID is not authorization. Pass context into all tenant-owned operations, including aggregates, exports, nested relations, and background handlers.

Contact uniqueness is organization plus normalized phone. Never globally deduplicate participants or share consent between organizations.

Use composite tenant-qualified foreign keys and unique constraints. An answer must reference the correct tenant, participation, question, and option. Validate cross-question selection as well as cross-tenant access.

Permit unscoped queries only inside documented control-plane helpers for membership resolution, authenticated sender mapping, and due job-ID claims. They must not expose arbitrary business records. Do not leak an unrestricted Prisma client into controllers or general domain modules.

RLS is optional defense in depth, not a substitute for the scoped repository boundary or negative tests. If implemented, prove pool-safe transaction-local scoping.

Test at least two organizations and the same phone number in both. Include direct object requests, lists, mutations, relation-connects, reporting, exports, workers, and webhooks. UI screenshots alone cannot prove isolation.

## 8. Authorization and privacy

Implement the exact role matrix in `MVP.md`. Only Admin may inspect/export identifiable answers or share results. Survey Manager can manage contacts and surveys, but must not receive hidden answer fields in API responses. Viewer receives aggregates only.

Only Admin changes survey duration/edit-window settings. Survey Managers use defaults and can choose opening schedules. Do not accidentally give a broad update DTO the ability to bypass field-level permissions.

Membership revocation must take effect on subsequent API calls. Protect the last Admin. Staff invitation acceptance must verify the token, target email, Firebase identity, expiry, and single-use state before creating a membership.

Document that surveys are identifiable to authorized Admins. Do not use anonymous in the UI or README to describe this MVP. Protect exports and audit sensitive access without logging selected answers.

No personal data is needed in routine logs, traces, job payloads, URLs, or client analytics. Do not add third-party behavior-tracking software. Keep raw imports/webhooks restricted and implement their cleanup windows.

Archive survey records through normal UI actions. Do not turn archive-never-delete into a claim that personal data must be retained indefinitely regardless of an approved privacy process.

## 9. Consent and messaging rules

Imported contact data is not consent. Unknown permission means no proactive outreach. Keep consent scopes, source/evidence, dates, wording version, and withdrawal history.

Recheck permission when a message is about to leave the worker. Old imports must not re-enable a withdrawn contact. An inbound HI or survey answer does not automatically authorize future campaigns.

STOP and equivalent supported commands override profile/question processing and stop pending sends. A participant-initiated re-enrollment must obtain affirmative permission again.

Separate the survey's 48-hour duration from the provider's service window. Business-initiated/out-of-window communication follows the template rules in the specification. Sending a template does not itself open a user-response window.

Apply the same policy gates to live test messages, result invitations, and retries. Never silently fall back to unofficial WhatsApp automation or pretend a missing template/Flow is approved.

Follow current official Meta documentation for the configured API version. Account policy review and approvals are external prerequisites, not facts established by the app.

## 10. Survey and answer invariants

Freeze question content, order, option meaning, audience, and timing policy when scheduling/launching. Do not edit already collected questions in place. Locale text must remain separate from stable question/option identity.

One canonical answer per participation/question. Keep revision history separately and aggregate only current answers. Duplicate webhook events do not create votes, revision rows, or extra messages.

First accepted answer establishes the fixed edit deadline. Default is 120 seconds; every edit uses that original deadline. At expiry or survey closing, reject. Zero disables edits. Opening a form earlier does not extend submission time.

Use transactions, row locks/optimistic control where appropriate, and database uniqueness for concurrency. Use an injected clock in tests. Never rely on a browser clock or `sleep(120000)` to prove edit behavior.

Multiple-selection is a submitted set, not multiple independent list taps. Validate min/max and exclusive choices. Rating values are integers 1-5. Missing answers are not Indifferent.

Persist foreground/paused conversation state. Explicit action bindings determine where a reply belongs; never attach it to whichever survey was sent most recently. Editing an answer must not advance the next question twice.

## 11. Integrations, webhooks, and jobs

Keep provider DTOs at the adapter boundary. Use validated domain messages/actions internally. The simulator must traverse the same domain logic, not write fabricated answers directly into Prisma.

Verify webhook signatures over exact raw bytes. Process every batched message and status. Bind verified sender connection to organization and participant before accepting any action token or Flow submission.

Persist inbox events before returning webhook success. Persist domain changes and outgoing intents atomically. Use durable PostgreSQL jobs locally, leases, bounded retries, and idempotent handlers. Do not store deadlines exclusively in memory.

Separate one logical message from its attempts and delivery events. A send timeout can be ambiguous. Mark it unknown, stop automatic resends, and require the documented explicit retry decision. Never claim exactly-once external delivery without a provider guarantee.

For production-ready operation provide authenticated HTTP task handlers, the Cloud Tasks adapter, and a periodic-sweep path. Do not depend on Cloud Run continuing to run an idle in-process scheduler.

Follow the specified renderer routing. Supply actual versioned Flow JSON for single-choice, multi-select, and profile capture, with validation fixtures and registration instructions. If exact provider validation is externally blocked, report that limitation separately while preserving full local behavior.

## 12. Reporting and export discipline

Calculate counts from canonical persisted answers. Revisions replace current selections rather than incrementing totals indefinitely. Tests need known expected datasets, not snapshots of whatever the implementation happens to return.

Use the stated denominators, including the delivery-evidence intersection for response rate and respondent denominator for multiple-selection percentages. Show N/A for zero denominators. Preserve Unknown demographics and frozen analysis profiles.

Do not expose individual-response data through aggregate serializers, charts, filters, or exports. Apply the cohort disclosure rules consistently. A small cohort threshold is not a guarantee of anonymity.

Result sharing is Admin-initiated after close, with a frozen aggregate snapshot and a single broadcast. Check real respondents, results permission, test exclusion, current opt-outs, and template eligibility.

Parse generated CSV/XLSX in tests and verify its actual values, formulas/text types, and role restrictions. Treat export formula injection as a real input-handling issue, not a cosmetic escaping detail.

## 13. Local execution and demo safety

A clean checkout must start through the documented Docker Compose commands. Migrations and idempotent seed data run safely. Existing user-created records survive restart.

Use Firebase Auth Emulator and a mock messaging provider locally. Seed role-specific users, meaningful surveys, synthetic contacts, failures, and shared-result examples. Synthetic contacts must be impossible to message through the live adapter.

A live configuration must reject emulator flags, known demo credentials/bootstrap, enabled simulator routes, and missing secrets. Do not fall back to mock when live configuration is invalid.

Make simulator mode unmistakable in the UI. Local time/fault controls are development-only, authenticated, and scoped to tests. No paid service is required for routine local verification.

## 14. Tests and completion evidence

Implement the R01-R60 acceptance matrix. Use appropriate unit, integration, contract, and E2E evidence. Do not mock away the database in a transaction test or bypass the API in an authorization test.

Run the relevant root commands, with the final verification covering lint, strict types, unit tests, integration tests, critical Playwright journeys, production builds, Docker smoke, and the 1,000-contact scale scenario where the environment permits.

Inspect the UI for usable layouts, accessible controls, empty/loading/error states, working downloads, and visible mock/live identity. Do not rely only on API tests for a dashboard application.

Do not disable failing tests, weaken assertions, replace a required feature with a stub, or write a test that only confirms a mock was called. Repair the behavior or disclose the failing requirement.

Final reporting must state:

1. What is implemented and how to run it locally, including demo access.
2. Which commands/tests actually ran and their outcomes.
3. Any unresolved requirement IDs and concrete causes.
4. Which live Meta/GCP steps remain unperformed.

Do not claim production-ready approval, live deployment, successful real messaging, or 100,000-contact capacity from local test results. Do not call the product locally complete when known in-scope workflows are missing.

Keep durable implementation knowledge in the repository, temporary exploration under `plan/`, and canonical requirements in the existing specification files. Leave the repository easier for the next engineer or agent to understand.

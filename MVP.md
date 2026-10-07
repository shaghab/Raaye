# Raaye: MVP Implementation Specification

Version: 1.0  
Date: 7 October 2026  
Owner: Product owner / initial PILAP deployment  
Build target: A complete locally working application, with a deployment-ready codebase  
Normative companion files: `VISION.md` and `AGENTS.md`

## 0. Contract and interpretation

Implement this specification, not only its database schema or screen mockups. The requested output of the coding task is working software, migrations, seed data, a realistic participant simulator, meaningful automated tests, Docker startup, and operational documentation.

The requested question types, scheduled sending, optional onboarding, answer changes, result sharing, exports, tenancy, and role enforcement are all MVP requirements. Do not defer any of them because a simple yes/no prototype is easier.

The product owner's explicit decisions are binding. The labeled implementation defaults below resolve questions the owner left to engineering. Make small implementation decisions autonomously, record material decisions in `docs/DECISIONS.md`, and do not ask the owner to repeat information in these files.

Do not claim to have deployed GCP, obtained Meta approvals, or tested live WhatsApp unless those actions were actually authorized and completed. A real adapter with contract tests is required; live account provisioning is not.

All times in storage are UTC instants. PILAP's initial display/scheduling timezone is `Asia/Karachi`. English is the only implemented language. Content storage must support future locale variants.

## 1. Fixed decisions and implementation defaults

| Area | Contract |
| --- | --- |
| Product | Raaye. PILAP is the initial organization. |
| Tenancy | One organization exposed in the MVP UI; shared-schema tenant ownership and isolation from migration one. |
| Future scale | Approximately 1,000 contacts for the MVP. Schema, pagination, and queue design must not assume this is the permanent maximum. |
| Staff | Initially 4-5 users. Roles: Admin, Survey Manager, Viewer. |
| Authentication | Firebase email/password, with the Authentication Emulator locally. No public staff self-registration. |
| Contact creation | Manual entry and CSV/XLSX import. Name and WhatsApp number required. |
| Optional profile | City, district, gender, age band, occupation, membership status, tags/groups. Administrative tags are not participant-editable. |
| Consent | Explicit evidence and withdrawal tracking. Unknown consent means no proactive outreach. |
| Survey structure | Multiple questions, fixed order, no branching. Implementation limit: 1-20 questions. |
| Question types | Yes/No, Yes/No/Indifferent, arbitrary single-choice, multiple-selection, rating 1-5. |
| MCQ options | Implementation limit: 2-10 options per question. This is an MVP product limit, not a claim about the maximum capacity of every WhatsApp format. |
| Answer revision | Default 120 seconds per question. Admin-configurable per survey. First accepted answer starts a fixed window; edits never reset it. |
| Survey duration | Default 48 hours from the intended opening time. Admin-configurable, or explicit closing time. |
| Survey lifecycle | Draft, Scheduled, Active, Closed. `archived_at` is separate, not a fifth lifecycle state. |
| Participant experience | Invitation/start first; conversational questions, with a compact Flow for multi-select and when native controls cannot represent the content. |
| Audience | Everyone by default; individuals, groups/tags, and demographic filters supported. Permission is applied independently. |
| Scheduling | Send now and scheduled sending. Durable schedule, automatic close, restart recovery. |
| Testing | Local simulator plus an explicit, separately gated live test-send option. Tests never count toward real survey results. |
| Results | Aggregates, demographic breakdowns, CSV/XLSX export. Identifiable individual responses are Admin-only. |
| Sharing | Admin may share a frozen aggregate summary with eligible respondents after closing. No public results URL. |
| Stack | Angular, NestJS, PostgreSQL, Prisma, pnpm, Nx, Jest, Playwright. |
| Local runtime | Docker Compose. Emulated auth and WhatsApp. No paid service or cloud account needed for local operation. |
| Cloud direction | Firebase Hosting, Cloud Run, Cloud SQL, Cloud Tasks, Cloud Scheduler, Secret Manager. Manual deployment guide; no provisioning during this build. |
| Exclusions | No Terraform, no CI/CD, no GitHub Actions, no billing, no SaaS signup, no Google/Microsoft login, no Urdu UI. |

Unless explicitly identified as a platform restriction, numeric limits in this document are Raaye implementation defaults. Centralize them and enforce them consistently in API, UI, and tests.

## 2. Architecture and repository

### 2.1 Application shape

Build a modular monolith, with a separate worker entry point sharing the same domain services and persistence layer. Do not create a service for each domain module.

```text
Angular dashboard and local participant simulator
                 |
           NestJS HTTP API
                 |
   PostgreSQL + Prisma + durable jobs/outbox
                 |
          Shared worker handlers
             /           \
  Mock messaging       Meta Cloud API
  provider locally     adapter for live use
```

Suggested repository structure:

```text
apps/
  web/                         Angular dashboard and development-only simulator
  api/                         NestJS public/admin API and Meta webhook ingress
  worker/                      Polling and HTTP task entry points
libs/
  contracts/                   Shared DTOs/types without server secrets
  domain/                      Survey, consent, audience, answer and reporting rules
  persistence/                 Prisma repositories, scoped query helpers, migrations
  messaging/                   Message planning, Meta adapter, mock adapter, parsers
  jobs/                        Durable jobs, leases, dispatcher and scheduler handlers
  observability/               Structured logging, correlation and tracing
prisma/
  schema.prisma
  migrations/
  seed.ts
whatsapp/
  flows/                       Versioned Flow JSON assets and example data
  templates/                   Template specifications and setup notes
scripts/                       Local setup, seed, smoke and operational helpers
fixtures/                      Synthetic contacts and webhook examples
infra/                         Dockerfiles, Compose, reverse proxy, Firebase config
  gcp/                         Manual deployment examples, not Terraform
plan/                          Temporary implementation plans
  acceptance.md                Requirement/test progress
  verification.md              Commands actually executed and outcomes
docs/
  DECISIONS.md
  DEPLOYMENT.md
  WHATSAPP_SETUP.md
  SECURITY.md
README.md
VISION.md
MVP.md
AGENTS.md
CLAUDE.md
```

Exact directory names may vary where Nx conventions are better, but boundaries and deliverables must remain recognizable.

### 2.2 External adapters

Define narrow, typed interfaces for messaging, authentication verification, job delivery, and the clock. Domain logic must not depend on a particular webhook JSON layout, Firebase SDK object, or Cloud Tasks client.

The local mock provider and real Meta provider must call the same survey/consent/answer services. The simulator must not insert responses directly into the database or maintain a separate in-browser result store.

### 2.3 Local and future production execution

Local mode uses a PostgreSQL-backed job poller. Jobs survive worker restarts. Do not add Redis only to run the MVP.

Provide a Cloud Tasks delivery adapter and authenticated HTTP worker handlers that can be configured later. Cloud Scheduler invokes a short periodic sweep that finds due openings, closings, and enqueue work. Future schedules remain in PostgreSQL until due; do not depend on a cloud queue accepting arbitrarily distant timestamps.

The production path must not rely on an in-process timer inside a request-scaled Cloud Run instance. See references G2 and G3 for the managed trigger mechanisms. Duplicate task execution must be safe; see G1.

## 3. Tenancy and authorization boundaries

### 3.1 Tenant identity

Use a UUID organization ID. Seed PILAP by name and slug. Never insert a fixed PILAP ID or name into business rules, queries, participant copy, or authorization checks.

A minimal global `User` stores the external auth UID and account-level data. `OrganizationMembership` stores the user's role and status per organization. The MVP returns the user's single active membership without exposing a tenant-switching interface. A second organization exists in automated isolation tests.

Every tenant-owned table, including join tables, response revisions, imports, jobs, provider records, result snapshots, and audit events, carries `organization_id`.

Contact uniqueness is `(organization_id, normalized_phone)`, not phone number globally. The same number in two organizations does not share consent, profile attributes, participation, or history.

### 3.2 Request scope

Every admin API request must derive a `TenantContext` from a verified auth identity and an active membership. An organization ID in the URL or header is a selector only; it never proves authorization.

Pass tenant context into domain operations and tenant-scoped repositories. Controllers must not use an unrestricted Prisma client to fetch tenant data. Never trust tenant IDs inside imported rows, client DTOs, or task payloads.

Get-by-ID, list, update, aggregate, export, and relation-connect operations all require the same tenant restriction. A cross-tenant object request should return 404 without disclosing whether the object exists elsewhere.

### 3.3 Database enforcement

Use tenant-qualified unique constraints and composite foreign keys. For example, an Answer's `(organization_id, question_id)` must reference a Question belonging to the same organization. Answer options must belong to that same question, not just any option in the organization.

Make the authorized tenant repository boundary mandatory and test it. PostgreSQL row-level security may be added as defense in depth, but is not required to finish this MVP. If added, use transaction-local context and a non-bypass runtime role. Do not introduce unreliable session-scoped tenant variables into pooled connections.

Only narrowly defined routing/control-plane functions may run without a tenant context: resolving verified auth membership, mapping an authenticated Meta sender connection, and claiming due job IDs. They must not expose business data to an unauthenticated caller.

### 3.4 Messaging routing

One active WhatsApp sender connection per organization is sufficient for the MVP. Each active live `phone_number_id` maps to exactly one organization. Store sender identifiers as strings, not numeric database types.

Verify the Meta app webhook signature first. Then map each event's business `phone_number_id` to the organization connection. Then resolve the participant within that organization. The sender number in a webhook is not a tenant ID.

Keep business-sender identity, participant WhatsApp identity, and normalized contact phone number as distinct fields. Do not guess an identity association from a display name.

## 4. Staff authentication and roles

### 4.1 Authentication

Use Firebase Authentication email/password. The API verifies Firebase ID tokens. Local Docker configuration connects both frontend and Admin SDK to a shared `demo-raaye` Authentication Emulator project, with seeded users. Emulator-issued credentials are development-only; never accept them in production. See G4.

No staff registration page. Admin creates an organization invitation using email and role. For the MVP, generate a single-use, expiring invitation link that Admin can copy and send manually. Completing the link sets up or authenticates the Firebase account and creates the membership after verifying the email/account binding. Do not reveal passwords to Admin.

Invitation tokens must be random, stored hashed, expire after 72 hours, and be consumed transactionally. Existing users sign in to accept an invitation. New users set their password through the implemented invitation flow. Role and organization come from the invitation record, never editable request fields.

Support sign-out and password reset. Local reset/invitation testing must work through the emulator or local outbox without a real email service. Production password-reset action links use Firebase's supported flow.

No public endpoint may create a membership merely because a supplied email matches an organization name. A valid Firebase account without a membership cannot read Raaye data.

### 4.2 Permission matrix

| Capability | Admin | Survey Manager | Viewer |
| --- | --- | --- | --- |
| View aggregate dashboard/results | Yes | Yes | Yes |
| View published survey definitions/status | Yes | Yes | Yes |
| View/manage contacts, profile and consent evidence | Yes | Yes | No |
| Import contacts/manage groups and tags | Yes | Yes | No |
| Create/edit drafts and audience | Yes | Yes | No |
| Run preview/test, launch/schedule/close/archive | Yes | Yes | No |
| Configure draft survey duration/edit window | Yes | No | No |
| View delivery diagnostics and respondent identities | Yes | Yes, no answer content | No |
| View identifiable individual answers/revision history | Yes | No | No |
| Export aggregates | Yes | Yes | Yes |
| Export contacts | Yes | Yes | No |
| Export identifiable responses | Yes | No | No |
| Share aggregate results with respondents | Yes | No | No |
| Manage staff, organization, provider configuration | Yes | No | No |
| View audit trail | Yes | No | No |

Survey Managers can use defaults for new surveys. Only Admin changes the timing settings, reflecting the owner's explicit Admin-configurable requirement. Admin can change organization defaults for future drafts. Existing launched settings remain frozen.

Enforce permissions in the API and response serializers, not just by hiding navigation. The last active Admin cannot be removed or downgraded. Revoking a membership blocks subsequent API requests even if the Firebase token is still valid.

## 5. Contacts, profiles, and imports

### 5.1 Contact schema and validation

Required: name, WhatsApp phone number. Name is non-empty after trimming, up to 150 characters. Preserve the participant's actual supplied name; do not infer it from phone number or fabricate a placeholder.

Normalize phone numbers to E.164 using a maintained parser. The import wizard requires a default country when the file contains national-format numbers; initial default is Pakistan. Preserve leading digits, reject ambiguous/invalid values, and never coerce a phone number through floating-point arithmetic. Remove the leading `+` only at a provider boundary that requires digit-only format.

Optional fields:

| Field | Representation |
| --- | --- |
| City and district | Separate nullable strings, trimmed, plus normalized values for matching. No paid geocoding. |
| Gender | `woman`, `man`, `another_identity`, `prefer_not_to_say`, or null. Display labels are locale-ready. |
| Age | Prefer `age_band`: `under_18`, `18_24`, `25_34`, `35_44`, `45_54`, `55_64`, `65_plus`, `prefer_not_to_say`, or null. |
| Exact age on import | Accept integer 0-120 with an `age_as_of` date, derive age band, and preserve source metadata. Do not collect birth dates. |
| Occupation | Nullable string, maximum 120 characters. |
| Membership | `member`, `non_member`, or `unknown`, with source `admin`, `import`, or `self_reported`. It is not an access-control entitlement. |
| Language | BCP-47 `preferred_locale`, default `en`. |
| Tags/groups | Organization-owned many-to-many relations. Staff-managed only. |
| Record state | Active/archived, timestamps, and profile collection/provenance metadata. |

Missing, declined, and unknown values must not become misleading factual categories. Display an explicit Unknown/not provided group in reporting. Do not assume nationality, gender, religion, or political belief from a name.

If an import supplies both exact age and a conflicting age band, require correction rather than silently choosing one. Onboarding requests an age band, not exact age. Snapshot demographics for reporting as defined in section 14.

### 5.2 Manual entry

Provide Add contact and Edit contact forms, including optional fields, groups/tags, and separate consent controls. Creating a record does not automatically grant permission. Phone-number changes require explicit confirmation and new consent evidence for the new number; existing consent does not silently move to another number. Cancel pending outreach to the old number, invalidate its action bindings, and require a fresh verified sender association for the new number.

Use archive rather than destructive deletion in the ordinary contact interface. Archived contacts are excluded from new outreach. Preserve existing research records subject to the organization's separate privacy retention/erasure process.

### 5.3 CSV/XLSX import

Required workflow:

1. Upload `.csv` or `.xlsx`. Implementation limit: 5 MB and 10,000 data rows per file.
2. Select worksheet when necessary and map columns. CSV supports UTF-8, quoted values, BOM, and common newline conventions.
3. Select the phone-number default country and duplicate strategy.
4. Preview parsed and normalized data, row-level errors, consent eligibility, and create/update/skip counts.
5. Explicitly confirm import. Never import immediately on upload.
6. Present a completion summary and downloadable row-error report.

Required mappings are name and phone. All profile fields are optional. Provide downloadable template files and at least one fixture with intentional validation errors.

Duplicate modes: `skip_existing` by default; `update_non_empty_fields` as an explicit alternative. Duplicate normalized numbers inside one file are flagged and only the first valid row can be used after preview. Do not silently merge contradictory consent records.

Ordinary profile imports never re-enable a withdrawn contact. Granting consent during import requires affirmative evidence fields or an explicit batch-level attestation with scope, source, collected-at time, and wording version. A boolean column named `consent=true` by itself is insufficient.

For a previously withdrawn number, only a new, explicitly reviewed opt-in event dated after withdrawal can restore permission. Re-importing old evidence must not do so. Record the staff actor and evidence reference.

Use upload and row-count limits, reject encrypted workbooks and unsupported formats, and never evaluate spreadsheet formulas. Reject or flag formula cells in mapped data. Treat all cell content as untrusted. Protect exported error files from spreadsheet formula injection as well.

Store upload metadata and validation summary. Delete raw upload bytes after processing or after a maximum 24-hour staging period. Do not make raw uploads publicly accessible.

### 5.4 Groups, tags, and filters

Both groups and tags are simple named organization-scoped sets. A group represents a maintained audience such as Members; tags provide flexible labels. Do not build nested groups or a CRM automation engine.

Support contact search by name/phone and filtering by city, district, gender, age band, occupation, membership, consent status, group, and tag. Match values within a field using OR; combine different fields using AND. Define include/exclude behavior explicitly in the UI. All lists are paginated.

## 6. Consent and optional participant onboarding

### 6.1 Consent evidence

Use an append-only consent-event history and an effective current status. Record organization, contact, scope, event type, evidence source, evidence timestamp, record timestamp, wording/version, and actor where relevant.

Scopes are `survey_invitations` and `survey_results`. One explicit statement can cover both, but the system must store which scopes were actually granted. Merely answering a survey is not a grant for every future communication.

Current statuses: unknown, granted, withdrawn. Unknown and withdrawn cannot receive proactive survey invitations. Each dispatch job rechecks effective permission and contact archival status at execution time.

Platform baseline: Meta requires permission for subsequent outreach, approved templates for business-initiated conversations, and approved templates outside the 24-hour customer service window. User messages reopen that window. The organization must publish privacy information and provide a human support route. Meta also restricts political organizations and services; PILAP's eligibility is an external review item, not something this code can approve. See W1.

### 6.2 Suggested participant notice

Provide editable organization copy with a version, initially:

> This is Raaye, a survey bot from [Organization]. We invite you to voluntary surveys and may share aggregate results. Authorized [Organization] administrators can see your individual answers. You can stop messages at any time by replying STOP. Privacy information: [privacy URL]. Human support: [support contact].

Use clear acceptance and refusal controls when permission is being obtained during a participant-initiated conversation. An administrator must provide real privacy/support details before live outreach; local mode uses visibly marked example values.

Do not send an unsolicited WhatsApp message merely to ask an imported, unconsented number to opt in. Such contacts can be recruited outside WhatsApp or initiate a conversation themselves.

### 6.3 STOP and re-enrollment

Case-insensitive `STOP`, `UNSUBSCRIBE`, and `CANCEL MESSAGES` withdraw both messaging scopes, cancel pending outreach, pause any active conversation, and receive one brief acknowledgement. An offline staff-recorded opt-out has the same effect.

A user saying STOP does not retroactively erase valid research responses. Explain the separate route for privacy/erasure requests. Never send another proactive message just because a previous survey is still open.

`START` or `JOIN` from an unknown/withdrawn contact begins an explicit opt-in conversation. It does not silently restore consent. Regrant requires an affirmative reply to the current notice.

### 6.4 Participant-initiated enrollment

Unknown inbound senders may begin enrollment. Store temporary enrollment state without inventing a contact name. Collect a non-empty name and consent before creating an active survey-eligible contact. A Meta profile display name can be offered for confirmation, not silently treated as verified input.

Receiving HI is enough to reply in the current conversation but is not, by itself, consent to future survey broadcasts. No participant may self-assign administrative groups or staff privileges.

This is not a public SaaS signup flow. The receiving WhatsApp connection determines the organization.

### 6.5 Optional demographic onboarding

Organization setting `profile_onboarding_enabled` defaults to true. Offer it once after the participant starts a survey, or when they request `PROFILE`.

Suggested copy:

> To help [Organization] understand the results, you may share a few optional details about yourself. You can skip this and still take the survey.

Controls: `Add details` and `Skip`.

Use a compact optional profile Flow for city, district, gender, age band, occupation, and membership status. Every demographic field is optional; submission with no fields is valid. A participant can later update or clear previously supplied optional fields. Staff-managed tags/groups are not exposed.

Do not overwrite admin-verified membership with a contradictory self-report silently. Keep the participant's self-report and its source visible for staff review, or retain a separate verified membership field. Neither value affects messaging permission.

Onboarding is separate from survey answers. Declining it must not create a missing survey answer, block completion, or trigger repeated prompts for every survey. Record offered, completed, and skipped states. A skipped person may still invoke PROFILE later.

If onboarding is abandoned, `RESUME` or a survey's Start action must offer Continue survey without requiring completion of the profile form.

## 7. Survey authoring

### 7.1 Survey fields

A survey has an internal title, participant-facing title/introduction, ordered questions, audience definition, schedule, closing policy, answer edit-window seconds, locale, author, and revision.

Defaults: duration 48 hours; answer edit window 120 seconds; locale English; audience Everyone; no automatic result broadcast. Admin may set edit window to 0-3,600 seconds and duration to 1 hour-30 days, or choose a valid explicit closing instant within that range. These are configurable Raaye guardrails.

The editing window is per answer, not two minutes after the entire survey finishes. Explain this in the survey settings and participant help text.

Survey content should be neutral, clear, and attributable to the organization. Do not generate an LLM-based content classifier or automatically rewrite public-interest questions into innocuous topics. The author remains responsible for subject matter and policy review.

### 7.2 Question types

Expose the five requested authoring choices. A normalized implementation may use `single_choice`, `multi_choice`, and `rating` internally, with a `preset` for Yes/No and Yes/No/Indifferent.

| Authoring choice | Options and storage |
| --- | --- |
| Yes/No | Two fixed semantic option codes: YES, NO. |
| Yes/No/Indifferent | Three fixed semantic option codes: YES, NO, INDIFFERENT. Do not replace Indifferent with Unsure. |
| Arbitrary single-choice | 2-10 authored options, exactly one accepted selection. |
| Multiple-selection | 2-10 authored options, configurable minimum/maximum selections; defaults 1 and all options. |
| Rating 1-5 | Five integer values with optional endpoint labels; persist the numeric value plus its option identity. |

Each question has an immutable ID within a launched revision, order, locale-specific text, and options with stable IDs/codes. Option labels are not database keys. Reordering options must not reassign their identity.

All survey questions require a valid answer to mark the survey completed. Participation is voluntary: a person can stop or abandon without answering every question, and valid partial answers remain reportable. Optional survey questions, skip logic, randomization, free-text survey questions, matrix questions, and ranking are out of scope. Profile text fields remain supported and are not free-text survey questions.

For multi-select, duplicate option IDs are rejected or normalized before validation, and the final distinct set must satisfy min/max rules. An empty selection is not an Indifferent response. A None of the above option may be authored, with an `exclusive` flag that prevents selecting it with other options.

### 7.3 Validation and channel preview

Authoring must validate both content and its planned delivery format before launch. Use no more than 20 questions and 10 options per question in this release.

Provide full option text and a short display label when necessary. Do not silently truncate two distinct choices into the same visible label. A long prompt or label must either route to a tested Flow representation or produce a specific authoring error.

The preview shows the selected renderer: reply buttons, list, or Flow. Single-choice options with up to three choices use buttons when the labels fit. Four to ten choices use a list when the labels fit. Multi-select always uses a checkbox Flow. Rating 1-5 uses a five-row list. Long labels can use a single-choice Flow. See section 11 for the implementation contract.

### 7.4 Content immutability

Scheduling or launching creates an immutable revision of content, answer rules, timing settings, locale, and audience. References from messages and answers point to that revision.

Do not allow question text, option meaning, order, or edit-window policy to change after outreach begins. To ask a materially different question, clone to a new survey.

A scheduled survey can be unscheduled before any outreach begins, returning it to Draft. Future edits produce a new revision on the next schedule/launch; historical test runs and prior revisions are retained. Invalidating the old revision must cancel its jobs.

Clone copies content and permitted settings, not answers, recipients, consent, delivery history, published result snapshots, or old schedule instants.

## 8. Lifecycle and timing

### 8.1 States

```text
Draft -> Scheduled -> Active -> Closed
  |                     ^
  +---- Send now -------+

Scheduled -> Draft      only through Unschedule before outreach
Draft/Scheduled/Closed  may be archived under the rules below
```

Archiving an Active survey first requires an explicit Close action. Archived records remain accessible through an archive filter and read-only history. There is no destructive survey-delete endpoint.

### 8.2 Opening and closing

For Send now, persist `opens_at` from the database-backed clock when launch commits. For scheduled sends, persist the selected intended UTC opening time. Store the organization's timezone for presentation, not as the source of elapsed-time arithmetic.

Compute `closes_at = opens_at + duration` unless an explicit valid closing instant was configured. Thus a survey scheduled for 09:00 on a particular day closes at 09:00 two days later by default, even if a worker temporarily starts late. Record the actual activation time separately.

If workers restart after the opening time but before closing, activate and process remaining eligible invitations. If they resume after closing, close without sending stale invitations. Do not shift the closing deadline to compensate for downtime.

Opening/closing handlers are idempotent. Even if the scheduled closing job runs late, the answer service rejects writes when the authoritative current time reaches `closes_at`. The database deadline, not the displayed state badge alone, determines whether an answer is accepted.

A manual Close makes the effective closing time immediate, cancels remaining invitations/question sends, and prevents further answers or edits. It does not create synthetic responses or erase partial answers.

### 8.3 Schedule edits

Admin and Survey Manager may choose or change the opening time while Draft/Scheduled, subject to their timing permissions. Only Admin changes the duration or answer-window setting. Revalidate and recompute closing time before saving a schedule change.

After Active, opening time, closing policy, question content, and edit duration are immutable in this MVP. Early manual closure is allowed. Extending an already Active survey or reopening a Closed one is out of scope; clone instead.

### 8.4 Readiness versus lifecycle

`readiness` and `dispatch_health` are separate from lifecycle. A scheduled survey can have a blocked dispatch reason, such as an unavailable template. Show the reason, alert staff, and do not pretend messages were sent.

When prerequisites become valid before the deadline, the due sweep may resume remaining work. It must not automatically send a survey that the administrator canceled or archived.

## 9. Audience, launch, and testing

### 9.1 Audience selection

Modes: Everyone, Selected contacts, Groups/tags, and Filtered contacts. Default Everyone means all currently active contacts in this organization, followed by eligibility filtering. It does not include contacts from other organizations or bypass consent.

Group/tag matching supports Any or All. Demographic filters combine with group/tag filters using AND. Explicit exclusions take precedence over inclusion. A contact appears at most once in a survey audience.

Show a preview with selected count, currently eligible count, and exclusions by reason. Reasons include invalid phone, missing consent, withdrawn consent, archived contact, duplicate, and provider readiness issues where applicable.

### 9.2 Frozen audience

Freeze the selected contact IDs and audience criteria at schedule/launch confirmation. Contacts added later are not automatically appended to a scheduled survey, even if the original mode was Everyone.

Store selected recipients and eligibility-at-freeze for audit. Create outbound invitation work only for eligible recipients. Recheck permission, archival status, sender readiness, and survey time at actual execution. A contact who opts out after scheduling must not be messaged.

A contact excluded for missing consent at freeze is not automatically added later if consent arrives. For this MVP, either unschedule and rebuild before outreach, or include them in a subsequent survey. Do not continuously mutate the audience.

Audience attributes used for selecting recipients are snapshotted separately from demographics used for analyzing actual answers.

### 9.3 Launch preflight

Launch confirmation requires:

- Valid question content and all renderer capabilities.
- At least one currently eligible recipient, unless this is a test run.
- A valid opening/closing configuration and frozen revision.
- A visible review of selected versus eligible counts.
- Matching sender configuration and required template/Flow bindings in live mode.
- Organization privacy/support details and a recorded live-policy review attestation in live mode.
- Confirmation of possible messaging charges for live sends, without inventing a price estimate.

An attestation records a staff review, not Meta certification. Real legal/account eligibility remains an external responsibility. A template for results is required only when attempting results outreach, not to run an otherwise valid survey.

Create one immutable Launch record and one recipient record per selected contact. Protect launch against double-clicks and request retries using a client-supplied idempotency key and a unique active launch constraint.

### 9.4 Test mode

Always provide Preview and Send test before launch. A successful test is recommended but not a hard requirement for saving or scheduling; show its status on the review screen.

Local test sends use the simulator and the same message planner/state machine. Live test sends require explicit live-mode enablement, a configured provider, and a consented test contact with the relevant permission. Do not silently use an Admin's login email as their WhatsApp identity.

Represent a test as a distinct `test_run` with its own recipients, sessions, answers, and message IDs. It may reference a draft revision snapshot but must never enter normal survey counts, demographic reporting, exports, or result sharing. Previewing cannot send a message.

A test opening/closing clock can be independent of the real survey schedule so that a future scheduled survey can be tested now. The test's answer-edit policy matches the draft being tested. Labels in the dashboard and simulator must make Test unmistakable.

## 10. Participant conversation engine

### 10.1 Baseline journey

```text
Approved invitation -> Start survey -> optional profile offer
                   -> Question 1 -> Question 2 -> ... -> completion acknowledgement
```

Use one question at a time, showing `Question 2 of 5` and an instruction appropriate to the input type. Starting a survey is distinct from giving permission for all future messages. Previously recorded consent remains authoritative.

On the first valid answer, record the response and schedule the next question atomically. A separate one-line acknowledgement is not required after every question; the next question can begin with "Response recorded." Send the requested final acknowledgement once completion is reached:

> Thank you. Your response has been recorded.

Include a short instruction for editing recent answers. Do not echo sensitive selected answers into routine acknowledgements by default.

### 10.2 State persistence

Persist enrollment/profile state, foreground survey participation, current question, most recent inbound time, and relevant action references. Do not store conversation progress only in process memory.

A participant can have multiple invitations and partially completed surveys. Permit one foreground conversational survey per organization/contact to avoid mixed question sequences. Starting another survey offers Continue current or Switch survey. Switching pauses the first; it does not erase answers or extend deadlines.

Buttons and Flow submissions must carry explicit action bindings. A late reply to another survey is processed against that binding, not the foreground question. It must not silently advance the currently foreground survey or send unrelated questions.

If a valid answer arrives for a paused survey, save it under that survey, but do not take over the foreground conversation. Resume it explicitly to send its next unanswered question.

### 10.3 Commands

Support case-insensitive commands with surrounding whitespace ignored:

| Command | Behavior |
| --- | --- |
| HELP | Identify the bot and organization, explain commands, and supply human support. |
| STOP / UNSUBSCRIBE / CANCEL MESSAGES | Withdraw permission and stop queued outreach. |
| START / JOIN | Explicit consent/enrollment or a menu of eligible open invitations for an already consented contact. |
| RESUME | Continue the foreground survey or show available open invitations. |
| PROFILE | Offer optional profile updates, preserving survey position. |
| EDIT | Show currently editable answered questions, with survey context. |
| EDIT 2 | Reopen question 2 of the foreground survey if still editable. |
| RESULTS | Show available shared-result snapshots for this eligible respondent, not every organization result. |

Paginate invitation, edit, and results menus that exceed native row limits, for example nine choices plus a Next action. Preserve the originating survey/contact context across pages. Keep command interpretation deterministic. Do not introduce NLP or an LLM. `STOP` has precedence over all question/profile input, including when the bot expects text.

A normal text reply such as Yes should not be guessed across surveys. For MVP survey answers, require valid interactive controls, or an explicitly displayed numbered fallback with an unambiguous bound prompt. Free text is accepted only for defined enrollment/profile fields and supported commands.

### 10.4 Interrupted sessions

A participant may stop mid-survey and resume before its closing time. Preserve partial answers. If the messaging window expires, do not send another free-form question proactively. Wait for inbound RESUME/Start, or an separately authorized approved-template operation. Automatic reminder campaigns are out of scope.

Opening a list or a Flow is not an answer. Store a multiple-selection answer only after an actual form submission. A canceled Flow leaves that question unanswered.

Unrecognized input produces a short corrective reply and the appropriate current control when permission and messaging rules allow. It must not reset the survey or delete answers.

### 10.5 Completion and partial participation

A respondent is someone with at least one valid answer. Completed means all required questions in the frozen revision are answered. Merely tapping Start is Started, not Responded.

Completion may occur while earlier answers are still editable. Do not hold the conversation open or force a two-minute wait. Revising an existing answer does not send another completion acknowledgement or duplicate the next question.

## 11. WhatsApp message rendering and Flows

### 11.1 Rendering rules

Treat native lists as single-selection controls. Do not try to implement a multiple-selection question by sending a list and treating separate row taps as one final response.

| Question/interaction | Primary renderer |
| --- | --- |
| Single-choice, 2-3 short options | Interactive reply buttons. |
| Single-choice, 4-10 short options | Interactive list. |
| Rating 1-5 | Five-row interactive list with endpoint labels where supplied. |
| Multiple-selection | One-screen Flow with a checkbox group and Submit. |
| Single-choice with long labels/content | One-screen Flow with a radio group. |
| Optional profile | Compact Flow with optional fields and Save. |

Native reply buttons have a maximum of three choices in the documented interface, and native lists support ten rows total. See W2 and W3. Validate visible label limits using the current provider schema rather than assuming all controls accept arbitrary text. Use a conservative short-label validator with clear UI feedback.

Store the renderer plan at revision freeze. The mock provider must enforce the same configured limits. A missing live Flow binding is a readiness error, not an excuse to silently drop a question type or substitute an external public form.

### 11.2 Reusable Flow assets

Check in three versioned Flow definitions: `single-choice`, `multi-choice`, and `profile`. A rating can use the single-choice form if a future renderer change needs it.

For question Flows, inject prompt, option IDs/labels, initial values for edits, and constraints as initial screen data where the supported Flow schema permits. Prefer a simple navigate-and-complete Flow that submits through the normal webhook. Do not add a data-exchange endpoint unless a verified API limitation makes it necessary.

Include a `FlowRegistry` binding by organization, locale, purpose, schema version, and provider Flow ID/status. A reusable published Flow is not a separate newly created remote Flow for every participant. Changes to a published definition need a versioned replacement and new binding.

Include a local schema validation command, fixture payloads, and documented Meta validation/upload/publish steps. Do not copy an old sample's Graph API version. Select a supported version during implementation, pin it in configuration, and record the date/source used.

If the selected provider version requires data exchange for a required capability, implement the documented endpoint, encryption/signature handling, key setup, and contract tests instead of inventing a plaintext endpoint. Record the reason. This is a capability decision, not permission to omit multi-select or onboarding.

### 11.3 Opaque action binding

Every invitation quick reply, question control, edit prompt, and result-access control references an opaque, unguessable application action token. Bind it server-side to organization, connection, contact, survey/revision or result snapshot, question where applicable, test/live mode, and expiry.

For buttons and list rows, the binding must identify the selected option as well as its question, or the payload must combine a bound action identifier with a validated option ID. Flow submissions use the question binding plus validated option IDs in the submitted data. Never lose the option-to-action mapping between rendering and response parsing. No phone number, secret, or answer content belongs in a visible action ID. A valid action from one participant or organization must not work for another sender. A Flow token is a correlation input, not independent proof of identity.

For an initial Flow submission, validate the webhook sender and token binding before parsing selected option IDs into an Answer. A form's own success screen is not proof that the server accepted an expired answer; send a clear rejection in chat if it is too late.

### 11.4 Required Meta adapter APIs

Use HTTPS to the configurable Graph version:

```text
POST /{PHONE_NUMBER_ID}/messages
GET  /{WABA_ID}/message_templates
POST /{WABA_ID}/subscribed_apps
POST /{WABA_ID}/flows
POST /{FLOW_ID}/assets
POST /{FLOW_ID}/publish
```

`/messages` is the runtime send path. Template status lookup supports readiness. Subscription and Flow setup operations may be explicit operator commands with dry-run support, not automatic actions on application startup. Templates can be created/approved manually in WhatsApp Manager for MVP; a graphical template editor is out of scope. See W4 and W5.

Required live configuration includes WABA ID, phone number ID, app identifier, app secret reference, access-token reference, verification-token reference, Graph version, language/template bindings, and relevant Flow IDs. Never expose token values in the dashboard.

### 11.5 Invitation and result templates

Provide versioned template specifications, initially in English:

- Survey invitation: organization identity, brief purpose, survey title, voluntary participation, and Start survey quick reply.
- Results available: organization identity, survey title, and View results quick reply.

Templates are proposals until Meta approves them. Store approved name, language, category, status, button position, and parameter mapping. Verify they match the adapter's payload. Do not assume every informational survey is a Utility message or every approved template is permanently available.

## 12. Response storage and answer changes

### 12.1 Canonical answer

Use one canonical Answer per `(organization_id, participation_id, question_id)`. A participation itself is unique per survey revision/contact/run type. Each canonical answer points to the current accepted revision.

Keep AnswerRevision history with accepted time, selections, event reference, and source. Revision history is Admin-only. It supports audit and reproducibility, not double-counting in charts.

Multi-select storage uses answer-option join rows or equivalent normalized selections. Enforce that all selected options belong to the question and tenant. Ratings must be integers 1-5. The API validates shape and the domain layer validates meaning.

### 12.2 Edit-window semantics

For the first accepted answer:

```text
first_accepted_at = authoritative server time
edit_expires_at = min(first_accepted_at + survey.edit_window_seconds,
                      survey.effective_closes_at)
```

An edit is allowed only while the survey is Active, current server time is strictly earlier than both deadlines, the participant is eligible, and the new selection is valid. At the exact deadline, reject. Zero seconds disables editing.

Use an injected clock for deterministic tests. Production uses a consistent server/database time source, never a timestamp supplied by the browser or participant.

Repeated changes inside the window are allowed, but `first_accepted_at` and `edit_expires_at` do not move. Treat resubmitting the same choice as an idempotent no-op, not another revision or another respondent.

Accept direct repeated taps on a bound original button/list question as edits when within the original deadline. `EDIT` must also supply a discoverable route to editing, especially for Flow submissions. Reopened forms preselect the current choices.

Opening an edit control before expiry does not reserve extra time. Submission must still be accepted before expiry. An old Flow or button token cannot reopen a Closed survey.

### 12.3 Transactions and concurrency

In one transaction: validate tenant/sender/action, lock participation/answer as appropriate, verify survey and edit deadlines, check incoming event identity, validate selections, create/update the canonical answer and revision, update participation state, and write resulting outbox work.

Use a unique database constraint plus a transaction to protect first-answer races. Two simultaneous first replies create one Answer. A losing transaction re-reads and follows edit rules; it must not create a second first-answer timestamp.

For distinct user replies, use provider event time when present to reject a clearly older reply that would overwrite a newer accepted selection. When timestamps have equal precision, resolve deterministically using ingress order. Record both provider time and received time. Do not claim to reconstruct an ordering that the provider did not supply.

Duplicate delivery of the same inbound message cannot create another answer/revision, advance another question, or trigger another acknowledgement. An answer edit must not resend the next question already scheduled by the original answer.

### 12.4 Rejection behavior

Late edits receive a brief message such as: "The time to change this answer has ended. Your earlier response remains recorded." Closed-survey replies explain closure and leave existing answers unchanged.

Invalid option IDs, a sender/token mismatch, mismatched tenant, invalid selection count, and forged Flow data must not alter any response. Return a safe participant explanation where appropriate and structured internal diagnostics without recording sensitive values in normal logs.

## 13. Webhooks, durable jobs, and delivery reliability

### 13.1 Webhook endpoints

Implement public HTTPS-compatible GET/POST webhook routes under a configured app key. The GET verification path validates the verification token and returns `hub.challenge`. The POST path validates `X-Hub-Signature-256` using the exact raw request body and the correct app secret before accepting an event. Use a timing-safe comparison. The URL app key selects configuration; it is not the security control.

Do not parse JSON and reserialize it to calculate the signature. An invalid signature is rejected without any domain writes. Request-size limits and safe parser errors are required.

Process every relevant item in `entry[]`, `changes[]`, `messages[]`, and `statuses[]`. Do not assume only element zero exists. One webhook request can contain multiple records and sender connections. Route each verified event to its own tenant scope.

Typical inbound answer locations, to be verified against the configured API version:

```text
Template quick reply:       message.button.payload
Interactive reply button:  message.interactive.button_reply.id
Interactive list:          message.interactive.list_reply.id
Flow completion:           message.interactive.nfm_reply.response_json
Text command/profile:      message.text.body
```

Parse Flow `response_json` as untrusted JSON with a bounded schema. Include sender identity, incoming message ID, timestamp, and original message context where supplied. See W5 and W6 for examples of the response structures.

### 13.2 Durable ingress

After signature verification, persist normalized events or a durable inbox record before returning success. If durable storage fails, do not return a misleading successful acknowledgement.

Return promptly after persistence; perform survey processing asynchronously. Unknown event types are acknowledged safely with minimal diagnostics, not fatal webhook failures. Unknown sender connections are quarantined without attaching them to a default organization. Keep unroutable envelopes in a separate restricted, expiring platform quarantine; do not create tenant InboundEvent rows with a nullable organization ID.

Prioritize normalized opt-out events ahead of bulk send jobs. The opt-out acknowledgement is queued only after withdrawal is committed. Requests already transmitted to Meta cannot be unsent; record that in-flight boundary rather than promising cancellation of an accepted external send. Record inbound message identity with a unique key scoped to provider connection and message ID. Status-event deduplication needs status and event time as well as message ID; otherwise a Delivered update could be discarded merely because Sent was already seen.

Raw webhook storage, if retained for troubleshooting, must be restricted and automatically expire. Default retention is 7 days. A long-lived normalized event record should retain only the data actually required for idempotency, audit, or domain behavior.

### 13.3 Job/outbox model

Persist outgoing Message intent and Job in the same transaction as the triggering domain event. Jobs contain stable object IDs, not copies of phone numbers, answers, access tokens, or entire profile documents.

Job kinds include:

```text
activate_survey
close_survey
send_invitation
process_inbound
send_question
send_acknowledgement
send_results_invitation
send_results_content
sweep_due_work
```

Use one logical outgoing message per intended action, with separate send attempts. Unique deduplication keys prevent double launches, repeated next questions, and duplicate result broadcasts.

The local worker claims due jobs with row locking and expiring leases, processes bounded batches, and supports graceful shutdown. Use PostgreSQL `FOR UPDATE SKIP LOCKED` through safe parameterized SQL where appropriate. Domain processing remains tenant-scoped after the narrow claim step identifies the owning organization.

A job must be safe if executed twice or if its worker crashes. Do not use in-memory arrays, an unpersisted setTimeout, or a process-local "already sent" flag for reliability.

### 13.4 Sending policy gate

Immediately before an outbound provider call, check:

- Tenant, sender connection, and recipient/action binding.
- Contact state and current permission for that purpose.
- Survey/test-run/result state and deadline as appropriate.
- Free-form versus template eligibility using the most recent verified user message time.
- Required approved template/Flow availability.
- Prior successful/ambiguous attempts for this logical message.
- Configured sender pacing and per-recipient conversation ordering.

STOP acknowledgements and user-requested support/consent conversations use an explicit permitted transactional path, not a blanket bypass for all outbound messages. Audit why a message was allowed or suppressed.

Keep reply/question work ahead of new bulk invitations so a 1,000-contact launch does not make an actively responding participant wait behind the entire campaign.

### 13.5 Retry and ambiguous sends

For explicit temporary failures with known non-acceptance, retry with bounded exponential backoff and jitter. Honor provider rate feedback. For authentication errors, paused/rejected templates, invalid recipients, and policy failures, block or fail with a specific reason instead of retrying indefinitely.

A network timeout after request transmission may mean the provider accepted a message but the application did not receive the response. Mark that attempt `outcome_unknown`. Do not blindly resend it. A crash while a send lease is active has the same ambiguity unless non-acceptance is known.

Show unresolved attempts in delivery diagnostics. Admin can explicitly authorize a retry after a duplicate-send warning; preserve the original attempt and audit the decision. Do not invent a provider-side idempotency guarantee that is not documented.

A real provider message ID is stored immediately when returned. Incoming status callbacks must route and reconcile against the same connection. If a status arrives before its message row can be resolved, retain it for bounded reconciliation rather than dropping it.

### 13.6 Delivery state

Store outgoing intent, attempt outcome, and delivery evidence separately. Typical evidence includes provider accepted, sent, delivered, read, failed, and unknown. An API HTTP success is not delivered.

Keep append-only status events and derive the current display state without regressing Read to Sent because callbacks arrived out of order. Delivered/Read evidence may imply earlier stages, but do not fabricate actual missing callback timestamps. Failed attempt history is retained even if a later explicit retry succeeds.

Test messages and follow-up messages must not inflate the number of unique recipients reached by the initial survey invitation.

## 14. Dashboard metrics and analysis

### 14.1 Survey-level cards

Display counts from persisted real data, not synthetic client constants:

| Metric | Definition |
| --- | --- |
| Selected | Unique contacts in the frozen audience. |
| Eligible at launch | Selected contacts that passed the launch eligibility check. |
| Queued | Eligible invitation intents not yet resolved. |
| Provider accepted | Unique recipients with an accepted initial invitation attempt. Label this clearly, not Delivered. |
| Delivered | Unique recipients with Delivered or Read evidence for an initial invitation. |
| Started | Unique participants who started this survey. |
| Responded | Unique participants with at least one valid canonical answer, including partial responses. |
| Completed | Unique participants with a valid answer to every required question. |
| Failed / suppressed / unknown | Separate counts with reason drill-down for authorized staff. |
| Response rate | Respondents with confirmed invitation delivery divided by recipients with confirmed invitation delivery. |
| Completion rate | Completed participants divided by Started participants. |

Use an intersection for the response-rate numerator. A response may arrive before the delivery callback; count it in Responded but do not display a response rate above 100%. Show a tooltip explaining the denominator and a delivery-status-pending indicator when relevant.

Zero denominators display `N/A`, not 0%, infinity, or NaN. All rates include explicit definitions and timestamp of last refresh. Display counts as integers and percentages to one decimal place.

Do not require every staff user to see contact identities to understand these metrics. Viewers receive aggregate diagnostics only.

### 14.2 Per-question results

For single-choice and ratings:

```text
option_count = unique respondents with that current option
valid_answers = unique respondents with a valid answer to that question
option_percentage = option_count / valid_answers * 100
```

For multi-select:

```text
option_count = unique respondents whose current answer includes that option
valid_answers = unique respondents with a valid submitted selection set
option_percentage = option_count / valid_answers * 100
```

Each respondent is counted once per selected option, not once per click or revision. Multi-select percentages can sum to more than 100%; label this explicitly. Option counts must not be divided by the total number of selected options unless a separate clearly labeled measure is added later.

Show answered, unanswered among Started participants, and the question's own valid-answer denominator. Preserve zero-count options. Do not classify unstarted recipients, abandoned participants, or missing answers as Indifferent.

For ratings, show the distribution and mean of valid integer ratings. Do not invent a net-promoter score from a 1-5 scale. Bars and accessible data tables are sufficient; a pie chart is optional, not required.

### 14.3 Demographic analysis

At the first accepted survey answer, snapshot the participant's available profile, including optional onboarding changes already completed. Keep this `analysis_profile` immutable for the survey participation. Later profile edits affect future surveys, not historical distributions.

Maintain a separate audience-at-launch profile snapshot for targeting/audit. Do not mix that snapshot into answer breakdowns without labeling it. Nonresponders have audience data but no analysis-profile snapshot from an answer.

Support one-dimensional breakdowns by city, district, gender, age band, occupation, and membership where data exists. Use the participation's analysis snapshot and current canonical answers. Grouping by tags/groups can use the audience snapshot and must be labeled accordingly.

Show Unknown/not provided instead of dropping missing values. Membership provenance is visible to Admin; self-reported membership does not become verified membership through an aggregate.

MVP breakdowns show answer counts and option percentages within each respondent cohort. Demographic-specific invitation response-rate analysis is not required because audience and response snapshots have different meanings.

Viewer-facing cohort reporting must not support direct name, phone, contact-ID, or arbitrary individual-recipient filters. Apply a minimum cohort threshold of five respondents by default for non-Admin breakdown views/exports. Suppress the entire affected small cohort, including denominator cells; do not display a blank cell next to a trivially reconstructable total as a claim of protection. Admin can inspect full counts with a small-sample warning.

This threshold is a basic disclosure control, not a proof of anonymity or protection against every inference from overlapping results. Do not claim otherwise.

### 14.4 Live refresh and correctness

Refresh active results by polling at a reasonable interval, default 10 seconds, and provide manual refresh. WebSockets are not required.

Compute the MVP aggregates from indexed PostgreSQL queries over canonical answers. Avoid maintaining increment-only counters that drift when edits occur. A short-lived cache is optional if tenant/run/filter keys are correct and invalidation is tested.

Dashboard numbers and exports generated from the same result snapshot must reconcile. Tests must cover partial completion, revised answers, duplicate webhooks, multiple-selection sets, unknown demographics, and mixed test/live data.

### 14.5 Individual answers

Admin can search/filter individual survey responses, inspect a participant's current selections and revision timestamps, and export identifiable responses. The UI includes a visible privacy warning and logs sensitive record access/export events.

Survey Manager delivery drill-down may show recipient identity, delivery state, and completion state for operations, but never selected options, rating values, free-form profile messages, or answer revision content. Verify serializers do not leak these fields.

## 15. Sharing aggregate results with respondents

### 15.1 Action and audience

Only Admin can initiate sharing, and only after the survey is Closed. There is no automatic broadcast on every completed answer or every analytics refresh.

The action creates an immutable ResultSnapshot with current aggregates, question texts, denominators, generated-at time, and a definition/version. Eligible recipients are actual respondents with at least one valid answer in this survey, a live contact, and current `survey_results` permission.

Started-but-unanswered contacts, test participants, excluded contacts, and withdrawn contacts are not recipients. Recheck permission immediately before any send. Existing opt-in must explicitly cover result follow-ups; answering alone is insufficient.

### 15.2 Preview and disclosure

Show Admin exactly what will be shared and how many recipients are eligible. Share whole-survey question aggregates only, not individual answers, names, numbers, demographic slices, or revision history.

Default minimum valid respondents is five per question for a shared numeric summary. If fewer, display "Not enough responses to share this question's results" or exclude it with an explicit preview notice. Do not publish small demographic cohorts. Show a warning that aggregate information is not guaranteed anonymous, particularly for small known audiences.

If every question is below the threshold, disable the numeric-results broadcast and explain why. This is a Raaye disclosure safeguard, not a claim of a Meta-mandated minimum.

### 15.3 Delivery across the messaging window

Inside an open service window, send a short Results available message with a View results control. Outside the window, use the approved Results available template. Do not send free-form aggregate text outside the window.

When the respondent requests View results, validate sender and snapshot eligibility. The inbound action permits sending the bound summary within the current conversation window. Deliver a compact, chunked text summary in question order. Use conservative message-length limits and preserve question context in each chunk.

The 48-hour survey duration does not extend WhatsApp's 24-hour service window. Do not solve this by sending unapproved reminders or assuming every respondent remains reachable with free-form messages.

No public URL is created. An opaque token in a message grants no anonymous web access. A contact may later request RESULTS to see only snapshots already shared with them.

### 15.4 Idempotency and history

One results broadcast per survey in the MVP. Use one recipient record and one logical results invitation per eligible respondent. Double-clicking Share or retrying an HTTP request cannot create another broadcast.

Known failed attempts may be retried through the standard sending rules. An ambiguous outcome requires an explicit Admin decision. Do not recompute the published snapshot during a retry, so all respondents see the same approved summary.

Record who shared, when, which snapshot, eligible/suppressed counts, and delivery outcomes. If an approved privacy correction later invalidates a shared snapshot, support revoking in-app access and document that previously delivered WhatsApp text cannot reliably be retracted by Raaye.

## 16. CSV and Excel exports

Support both CSV and `.xlsx`. Provide:

1. Aggregate results with survey metadata, per-question counts/percentages, denominators, and relevant filters.
2. Demographic breakdowns, subject to the caller's disclosure permissions.
3. Contact exports for Admin/Survey Manager.
4. Identifiable current responses for Admin only, with an optional revision-history export clearly separated from current responses.

Each export is tenant-scoped, run-scoped, and permission-checked at generation and download. A frontend-hidden button is not authorization. Do not include phone numbers or respondent IDs in aggregate exports.

For answer exports, include survey/revision/question/option IDs as stable machine-readable fields, names/text as labels, and timestamps with timezone information. Multiple-selection rows should be unambiguous: use one row per answer-option plus an answer ID, or a documented normalized sheet. Do not concatenate ambiguous comma-containing labels without proper quoting.

Neutralize cells beginning with spreadsheet formula control characters, including `=`, `+`, `-`, `@`, and leading tabs/newlines where relevant. This includes contact names, question labels, and error reports. Phone values must remain text. Generate XLSX string cells, never execute input as formulas.

For this scale, direct authenticated streaming/download is sufficient. Avoid public object-storage URLs. Set `Cache-Control: no-store` for sensitive exports, use safe filenames, and audit actor, organization, export type, survey, filters, row count, and timestamp without logging the exported answer values.

## 17. Administrative UI and interaction requirements

### 17.1 Navigation

Top-level areas: Overview, Surveys, Contacts, Groups/tags, Settings, and role-appropriate Audit. The local simulator appears only in development/test mode and only to an authenticated local Admin.

Display the active organization and Mock/Live mode prominently. A single-tenant MVP must not hide which organization or sender the operator is using.

### 17.2 Screens

| Screen | Required behavior |
| --- | --- |
| Login / reset / invitation acceptance | Working email/password flow, errors, loading states, and logout. |
| Overview | Real aggregate counts, active/recent surveys, failures needing attention. |
| Contacts | Search, filter, pagination, add/edit/archive, consent state, import/export. |
| Import wizard | File validation, mapping, preview, dedupe strategy, consent evidence, confirm, error download. |
| Contact detail | Profile, consent evidence timeline, groups/tags, participation status; answer content only for Admin. |
| Survey list | Search/filter by state/archive, create, clone, open. |
| Survey editor | Ordered question builder, option editing, five types, validation, timings with role controls, save draft. |
| Audience and launch | All selection modes, eligibility counts, exclusions, test status, schedule/send confirmation. |
| Survey detail | Summary, question preview, audience/dispatch, aggregate results, demographic analysis, export. |
| Individual responses | Admin-only current answers and revisions. |
| Share results | Admin-only snapshot preview, disclosure checks, eligible recipients, explicit confirmation. |
| Settings | Organization identity/timezone/privacy/support, staff, defaults, sender readiness and safe credential references. |
| Audit | Admin-readable activity records with search/pagination. |
| Simulator | Select synthetic contact, see conversation, click native controls, open simulated forms, submit/edit, test faults. |

### 17.3 Visual and accessibility direction

Use a restrained, light administrative interface, clear typography, generous spacing, and predictable form layouts. Angular Material is the default component library; do not build a custom design system for the MVP.

Tables need readable empty states, loading states, error states, and pagination. Charts need accessible data tables. Keyboard operation, visible focus, labels, and meaningful validation errors are required. Do not use color as the only indication of status.

Confirm irreversible or externally visible actions: live send, close, archive, staff removal, consent override, unknown-outcome retry, and result sharing. Saving a draft should not ask unnecessary questions.

Use neutral organization branding. Do not scrape a logo, fabricate a Meta approval badge, imply WhatsApp endorsement, or create a public political campaign identity.

UI data must come from the backend. A form that only updates an Angular array or a chart with hard-coded values is not a completed feature.

## 18. Logical data model and constraints

The following is a logical model, not permission to replace important relationships with an unvalidated JSON blob. Prisma field names may follow TypeScript conventions; map physical names consistently.

Use UUIDs for internal IDs, UTC timestamps, explicit enums, indexed foreign keys, and uniqueness constraints. Keep external provider IDs as strings. Business records need created/updated timestamps and meaningful actor references where applicable.

### 18.1 Core entities

| Entity | Essential fields and relationships |
| --- | --- |
| Organization | ID, name, slug, timezone, default locale, privacy/support information, profile-onboarding setting, default timing settings. |
| User | Global ID, unique Firebase UID, normalized email, account state. No organization role here. |
| OrganizationMembership | Organization, user, role, status. Unique organization/user. |
| StaffInvitation | Organization, email, role, token hash, expires/accepted/revoked timestamps, inviter. |
| Contact | Organization, random internal ID, name, E.164 number, optional provider identity, profile values/provenance, locale, archived timestamp. Unique organization/normalized phone. |
| ConsentEvent | Organization, contact, scope, grant/withdraw event, evidence/source, evidence time, record time, wording version, actor. Append-only. |
| Group / Tag | Organization, name, normalized name. Unique name within each type and tenant. |
| ContactGroup / ContactTag | Organization and both parent IDs. Composite foreign keys. |
| Enrollment | Organization, provider sender identity, temporary name/consent/profile state, expiry. Used before a valid contact exists. |
| Survey | Organization, ID, lifecycle state, current revision, archive timestamp, author. |
| SurveyRevision | Organization, survey, revision number, immutable/frozen marker, timing settings, locale, translated title/introduction, created/frozen times. |
| Question | Organization, revision, stable ID, position, normalized type/preset, translated prompt, selection constraints. Unique revision/position. |
| QuestionOption | Organization, question, stable ID/code, position, translated full/short labels, optional rating value, exclusivity flag. |
| SurveyRun | Organization, survey/revision, kind LIVE or TEST, opening/closing instants, actual activation time, frozen audience definition, launch idempotency key. At most one LIVE run per survey. Test runs have independent timing. |
| SurveyRecipient | Organization, run, contact, audience profile/group snapshot, eligibility-at-freeze, exclusion reason, current suppression state. Unique run/contact. |
| Invitation | Organization, recipient, logical message reference, start-action reference, dispatch state. One invitation per recipient per run. |
| Participation | Organization, run, contact, state, started/completed timestamps, current question, immutable analysis-profile snapshot. Unique run/contact. |
| Conversation | Organization, contact/connection, foreground participation, profile offer state, last verified inbound time, control state/version. |
| Answer | Organization, participation, question, first accepted time, fixed edit expiry, current revision/version, current provider event time. Unique participation/question. |
| AnswerRevision | Organization, answer, revision number, accepted time, inbound event, source, rating where applicable. Unique answer/revision number. |
| AnswerSelection | Organization, answer revision, question/option identity. Unique answer revision/option. |
| ActionBinding | Organization, unguessable opaque action identifier, purpose, contact, connection, run/question/option/snapshot as applicable, expiry, mode. It is not a standalone authentication credential. |
| MessagingConnection | Organization, provider/mode, sender IDs, app configuration reference, secret references, enabled/readiness state. |
| TemplateBinding | Organization, connection, purpose, provider name, locale, category/status, parameter/button mapping, last checked time. |
| FlowBinding | Organization, connection, purpose, locale, asset version, provider ID/status, last checked time. |
| Message | Organization, logical action/dedupe key, contact, run or snapshot, direction, kind, provider connection, lifecycle metadata. |
| MessageAttempt | Organization, message, attempt number, provider message ID, attempted time, outcome/error code, reconciliation state. |
| MessageStatusEvent | Organization, connection, provider message ID, status, provider timestamp, received timestamp, error classification. |
| InboundEvent | Non-null organization after routing, connection, unique message/event identity, received/provider times, normalized event, processed state, restricted raw payload expiry. Unroutable envelopes stay in a separate platform quarantine. |
| Job | Organization, kind, entity reference, unique dedupe key, due time, priority, status, attempt count, lease owner/expiry, last error code. |
| ResultSnapshot | Organization, live run, fixed aggregate JSON, format version, creator, generated time, revoked time. No individual-response content. |
| ResultRecipient | Organization, snapshot, respondent contact, invitation message, access/delivery state. Unique snapshot/contact. |
| AuditEvent | Organization, actor/system identity, action, resource IDs, safe metadata, timestamp, correlation ID. Append-only. |
| ImportBatch | Organization, actor, source metadata, column mapping, duplicate mode, counts, state, staging expiry, consent evidence reference. |

Closely related state may be combined where invariants remain enforceable. Do not remove the distinction between canonical answers, revisions, invitations, participation, attempts, and delivery events.

### 18.2 Locale-ready content

Use either typed translation tables or validated JSONB maps keyed by locale. Required maps include survey titles/introductions, question text, option labels, and participant-facing message templates. `en` is required for this release; an Urdu translation can be added later without changing Answer/Selection schemas or stable option IDs.

Do not build a translation editor or machine translation in the MVP. Do not hardcode English labels as enum values in answer records. Preserve UTF-8 throughout import, persistence, export, and UI even though the current interface is English.

### 18.3 Required indexes and relational safeguards

At minimum index:

- Membership by user/status and organization/role.
- Contact by organization/normalized phone, organization/name, organization/archive state.
- Group/tag membership by organization and either parent.
- Effective consent lookup by organization/contact/scope and latest evidence order.
- Survey by organization/state/archive and run by opening/closing time.
- Recipient/participation by organization/run/contact.
- Question/option order and parent links.
- Answer by organization/participation/question; revisions by answer/order.
- Message by organization/run, connection/provider message ID, and logical dedupe key.
- Inbound event by connection/message identity and unprocessed state.
- Job by status/due/priority and lease expiry.
- Audit events by organization/time/resource.

Composite FKs must prohibit a tenant A Answer from referencing tenant B's Question or tenant B's Contact. Also prevent selecting an option from another question in the same tenant. Domain validation and database constraints complement one another.

Migration scripts must be checked in. Use safe deploy migrations, not production `prisma db push`, and do not require destructive resets for ordinary startup.

## 19. API contract

### 19.1 Conventions

Use REST JSON under `/api/v1`. Generate OpenAPI from the implementation. Request validation is mandatory. Return typed error codes, safe messages, field errors where useful, and a correlation ID. Never return raw database exceptions or provider secret-bearing errors.

All admin endpoints require verified authentication, active membership, tenant scoping, and the matrix in section 4. Health endpoints expose only minimal status and may be unauthenticated for infrastructure probes; they must not reveal configuration or tenant data. Accept tenant selection only when authorized. The UI's current organization is not sufficient protection.

Pagination uses a bounded limit, default 25 and maximum 100, with a documented cursor or offset strategy. Long-running imports and dispatch return job/resource identifiers rather than holding the browser request until every recipient is processed.

Use `Idempotency-Key` for launch, results sharing, import confirmation, and other externally consequential create operations. Reusing a key with a different payload returns 409. The same accepted operation returns the existing resource/result.

### 19.2 Required resource routes

Exact route names can follow project conventions, but these capabilities must exist:

```text
GET    /me
GET    /organization
PATCH  /organization
GET    /members
POST   /staff-invitations
POST   /staff-invitations/accept
PATCH  /members/{id}
DELETE /members/{id}                  Revokes membership, not research data

GET    /contacts
POST   /contacts
GET    /contacts/{id}
PATCH  /contacts/{id}
POST   /contacts/{id}/archive
GET    /contacts/{id}/consent-events
POST   /contacts/{id}/consent-events
POST   /contact-imports
POST   /contact-imports/{id}/preview
POST   /contact-imports/{id}/confirm
GET    /contact-imports/{id}
GET    /contact-imports/{id}/errors
GET    /contacts/export
GET/POST/PATCH /groups and /tags
POST/DELETE   /groups/{id}/contacts/{contactId}
POST/DELETE   /tags/{id}/contacts/{contactId}

GET    /surveys
POST   /surveys
GET    /surveys/{id}
PATCH  /surveys/{id}
POST   /surveys/{id}/clone
POST   /surveys/{id}/preview
POST   /surveys/{id}/test-runs
POST   /surveys/{id}/audience-preview
POST   /surveys/{id}/launch             Includes send-now or scheduled instant
POST   /surveys/{id}/unschedule
POST   /surveys/{id}/close
POST   /surveys/{id}/archive
GET    /surveys/{id}/dispatch
GET    /surveys/{id}/results
GET    /surveys/{id}/breakdowns
GET    /surveys/{id}/responses          Admin only
GET    /surveys/{id}/exports/{type}
POST   /surveys/{id}/results-preview
POST   /surveys/{id}/share-results      Admin only
GET    /surveys/{id}/result-sharing

GET    /messaging/readiness
PATCH  /messaging/configuration        Nonsecret fields and secret references only
POST   /messaging/refresh-status
POST   /messages/{id}/retry            Explicit checks for ambiguous outcomes
GET    /audit
GET    /health/live
GET    /health/ready
```

Do not accidentally implement a destructive DELETE survey route by copying a generic CRUD generator.

### 19.3 Non-admin routes

```text
GET  /webhooks/whatsapp/{appKey}        Meta challenge verification
POST /webhooks/whatsapp/{appKey}        Signed Meta callbacks
POST /internal/jobs/{jobId}/execute    Verified service identity only
POST /internal/sweep                   Verified service identity only
```

Development-only simulator routes must additionally require a local-mode flag and authenticated local Admin. Do not expose simulator submission or time-control endpoints in a production build/configuration.

A staff-invitation acceptance endpoint is authorized by the expiring invitation plus verified Firebase identity and email binding; it must not be an open membership-creation endpoint.

### 19.4 Domain error examples

```text
CONTACT_CONSENT_MISSING
CONTACT_WITHDRAWN
SURVEY_NOT_OPEN
SURVEY_CLOSED
ANSWER_EDIT_EXPIRED
QUESTION_OPTION_INVALID
SELECTION_COUNT_INVALID
TENANT_RESOURCE_NOT_FOUND
ROLE_FORBIDDEN
TEMPLATE_NOT_READY
FLOW_NOT_READY
SERVICE_WINDOW_CLOSED
SEND_OUTCOME_UNKNOWN
IDEMPOTENCY_CONFLICT
IMPORT_VALIDATION_FAILED
RESULTS_INSUFFICIENT_SAMPLE
```

Expose enough information to fix the issue without leaking another tenant's data or implementation secrets.

## 20. Security, privacy, and observability

### 20.1 Required controls

- Backend authorization and tenant-qualified data access for every protected operation.
- Firebase token validation, membership revocation checks, invite-token hashing, no public staff signup.
- Strict request validation and bounded uploads/webhook bodies.
- Raw-body webhook HMAC verification and safe JSON parsing.
- CSRF protection if cookies are used; a clear same-origin/CORS policy for token-based requests.
- No secrets in Angular bundles, source control, database plain-text configuration, URLs, or log messages.
- Safe rendering of untrusted question/profile strings. No arbitrary HTML injection.
- Parameterized queries and no unsafe raw SQL construction.
- Bounded retry and task execution, authenticated internal endpoints, and per-connection pacing.
- No mock-auth bypass or simulator route in live configuration.
- Dependency versions pinned in the lockfile; no knowingly vulnerable parser chosen merely for convenience.

Phone numbers and individual responses are sensitive application data. Keep identities in Contact and answers linked by internal IDs, but do not call that separation anonymous. Admin access to those links is an explicit feature.

The approved privacy notice must reflect actual collection, individual access, processing providers, result sharing, and retention. No CNIC, passport, exact address, payment-card details, or unnecessary sensitive identifiers are collected by the MVP.

### 20.2 Retention and erasure boundaries

Raw import staging expires within 24 hours; optional raw webhook payloads expire after seven days by default. Store normalized evidence only as needed. Provide a scheduled cleanup handler and tests for these short-lived artifacts.

Ordinary UI actions archive surveys instead of deleting them. This does not prohibit a separately authorized privacy erasure/anonymization process. Document how an operator can remove or de-identify personal data, revoke result access, and account for backups/provider copies without corrupting retained survey definitions. Do not promise a legal right is satisfied merely by setting `archived_at`.

Comprehensive self-service data-subject request management is out of scope. A published privacy policy, retention decision, and accountable operator procedure are live-deployment prerequisites, not reasons to block local development.

### 20.3 Logging and tracing

Use structured JSON logs and propagate a correlation/trace ID across API request, transaction, job, provider attempt, inbound webhook, and response handling. Record organization ID and internal resource IDs, event type, timings, result/error code, and retry count.

Never log full numbers, consent text, raw answers, access tokens, action tokens, entire imports, or entire webhook bodies in normal application logs. A privileged Admin response-view audit logs that the record was accessed, not its selected answer values.

Expose health/live separately from health/ready. Readiness checks required local dependencies and configuration, without making paid sends. Missing live credentials in mock mode are not a readiness failure. Missing required live credentials in live mode must fail closed.

Track queue age/backlog, job failures, incoming processing latency, outgoing acceptance/delivery failures, unknown outcomes, consent suppression, answer rejection reason counts, and webhook signature failures. No paid observability product is required locally.

## 21. Local runtime, seed data, and simulator

### 21.1 Startup contract

A clean clone must run using Docker Compose without requiring local Node, PostgreSQL, a Firebase account, a Meta account, or GCP credentials. Initial image/dependency downloads may require internet access.

Expected documented sequence:

```bash
cp .env.example .env
docker compose up --build -d
```

Also document the PowerShell equivalent for copying `.env.example`. Do not require the user to edit a long list of secrets merely to run the demo.

Provide health checks and a bootstrap step for safe migrations and idempotent synthetic seeding. Compose waits for dependencies before declaring the app ready. A restart does not overwrite user-created surveys or reset existing answers.

Default local frontend is available at a documented localhost port, preferably 8080, with API reverse proxying. Authentication Emulator and PostgreSQL are bound to loopback where host access is necessary. The normal UI is not exposed to the public internet by default.

### 21.2 Configuration

Include validated environment schemas and `.env.example` entries covering:

```text
APP_ENV=local
MESSAGING_MODE=mock
JOB_DRIVER=postgres
AUTH_MODE=emulator
FIREBASE_PROJECT_ID=demo-raaye
FIREBASE_AUTH_EMULATOR_HOST=auth:9099     Server-side Docker hostname
PUBLIC_AUTH_EMULATOR_URL=http://localhost:9099
DATABASE_URL=<local compose database URL>
WEB_ORIGIN=http://localhost:8080
ENABLE_SIMULATOR=true
DEFAULT_TIMEZONE=Asia/Karachi
```

Frontend and server emulator hostnames need not be identical; document and test both. Use local-only demo credentials with clear warnings. Guard the bootstrap so it cannot seed known demo passwords into a live environment.

Provide optional live variables/secret-reference mappings without filling in fake working credentials. Setting live mode must validate the required production configuration and never fall back silently to mock mode.

### 21.3 Seed data

Seed a clearly marked synthetic PILAP demo with Admin, Survey Manager, and Viewer accounts, plus enough contacts to exercise city, district, age band, gender, occupation, membership, missing data, groups/tags, granted consent, unknown consent, and withdrawal.

Seed at least:

- One editable draft survey containing all five authoring question types.
- One scheduled survey using the default 48-hour duration.
- One active survey with partial and completed responses.
- One closed survey with enough synthetic respondents to share aggregates.
- One archived survey.
- A CSV/XLSX fixture and an intentionally invalid import fixture.
- Delivery failures and one ambiguous-send fixture for the diagnostics screen.

Synthetic phone numbers must never be sent to a live provider. The mock adapter accepts synthetic fixtures even when a real network would not. A seeded synthetic flag blocks every real send path for that contact.

Provide an explicit `seed:scale` command that generates 1,000 synthetic contacts for performance testing. Keep the default demonstration small enough to inspect easily.

### 21.4 Simulator behavior

The browser-based simulator must support:

- Selecting a synthetic contact and viewing its conversation.
- Clicking invitation quick replies, native answer buttons, and list rows.
- Opening/closing/submitting single-choice, multi-select, and profile forms.
- Typing HELP, STOP, START/JOIN, RESUME, PROFILE, EDIT, and RESULTS.
- Changing answers before and after expiry using the test clock.
- Receiving completion acknowledgements and shared aggregate summaries.
- Switching between two survey invitations without cross-wiring answers.
- Inspecting understandable validation errors.
- Simulating duplicates, out-of-order callbacks, known failures, ambiguous sends, and expired service windows.

The simulator adapter emits normalized events through the same authenticated local ingress/domain pipeline as live webhook processing. Add separate contract tests for raw Meta webhook parsing/signature verification; do not pretend a custom simulator event is itself a Meta callback.

A fake/test clock can be used for integration and simulator test runs. Its controls must not alter a production database clock or be reachable in live mode. Scheduled-run and two-minute-window tests must not sleep for 48 hours or 120 seconds.

### 21.5 Developer commands

Provide documented root scripts with equivalent behavior:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm db:migrate
pnpm db:seed
pnpm seed:scale
pnpm verify
pnpm whatsapp:validate
```

`pnpm verify` executes lint, type checking, unit, integration, critical E2E, and production builds, or clearly orchestrates the necessary containers. Provide a Docker-based equivalent so tests do not depend on an undocumented host toolchain.

Migrations and reset commands are separate. Any reset requires an explicit local/test guard and destructive-action confirmation; ordinary verification cannot erase a real database.

## 22. GCP and live WhatsApp readiness, without provisioning

### 22.1 Deliverables

Provide production-capable container images, environment validation, an HTTP worker mode, the Cloud Tasks adapter, Firebase Hosting configuration, and `docs/DEPLOYMENT.md`.

The manual deployment guide covers:

- Selecting project/region, enabling APIs, and estimating actual costs separately.
- Creating a Cloud SQL PostgreSQL instance and running migrations as an explicit operation.
- Deploying API and private worker services to Cloud Run.
- Configuring Firebase Hosting rewrites/API URL and production Firebase Authentication.
- Supplying secrets through Secret Manager and service identities with least privilege.
- Configuring Cloud Tasks OIDC calls to the worker and Cloud Scheduler's periodic due-work sweep.
- Keeping public webhook ingress separate from authenticated administrative/task routes.
- Connection-pool sizing across Cloud Run instances and database limits.
- Backups, restore verification, logging/alerts, configuration changes, and rollback.

Include example commands with placeholders and dry-run notes. Do not execute provisioning, enable billing, deploy public services, or push to a remote repository during the build. Do not add Terraform or GitHub Actions.

### 22.2 Live Meta checklist

`docs/WHATSAPP_SETUP.md` must distinguish code-ready from account-ready:

1. Confirm the organization's permitted use with current Meta policy and any necessary provider review. Do not label PILAP automatically approved.
2. Establish the business portfolio, WABA, sender, app, and appropriate production access token/permissions.
3. Publish genuine organizational privacy and support information.
4. Configure webhook verification, app signature secret, and event subscription.
5. Obtain the actual approved invitation/results templates and bind their precise parameters/language.
6. Validate and publish required Flow assets, record IDs/version/status, and configure bindings.
7. Review actual messaging limits, pricing/category, account quality, and rate settings.
8. Disable demo accounts/simulator/emulator flags for live use.
9. Run explicitly authorized tests against consented real test numbers.
10. Verify live sends, all required response formats, delivery events, opt-outs, and tenant routing.

Some official Meta documentation can require login or rate-limit access. When exact Flow schema/version details cannot be validated during coding, report that external validation limitation and keep the local implementation complete. Do not silently mark the live contract verified or discard a required capability.

## 23. Acceptance tests and definition of done

### 23.1 Test layers

Use unit tests for pure rules and time boundaries; PostgreSQL-backed integration tests for persistence, constraints, workers, and authorization; provider contract tests for payloads/parsing/signatures; and Playwright E2E tests for the critical staff/participant journeys.

Do not mock the database in tests intended to prove relational constraints or transactions. Do not require live Meta/GCP credentials for the local verification suite. Provider contract tests and live acceptance are distinct evidence.

Maintain `plan/acceptance.md` mapping the following IDs to implementation paths, test paths, and pass/fail/not-run evidence. A source file existing is not sufficient evidence of a working feature.

### 23.2 Acceptance matrix

| ID | Observable acceptance condition | Minimum evidence |
| --- | --- | --- |
| R01 | Clean Docker startup reaches a usable dashboard with demo credentials and no cloud secrets. | Startup smoke + E2E. |
| R02 | Restart preserves user-created surveys, answers, schedules, and stable seed identities. | Integration + smoke. |
| R03 | Email/password login, logout, reset, and invitation acceptance work locally. | E2E. |
| R04 | A valid Firebase account without membership cannot access organization data. | API integration. |
| R05 | Removing a membership blocks the next protected request; last Admin cannot be removed. | API integration. |
| R06 | Survey Manager and Viewer cannot obtain individual answer content through APIs, exports, or hidden fields. | Negative API + E2E. |
| R07 | Organization A cannot list, retrieve, update, aggregate, export, or relate Organization B's data. | Two-tenant integration suite. |
| R08 | The same phone number can exist in two tenants with independent consent/profile/answers. | Database + domain integration. |
| R09 | Cross-tenant and cross-question foreign-key violations are rejected by the database. | Real PostgreSQL integration. |
| R10 | Manual contact creation requires name/phone and does not grant consent automatically. | Unit + E2E. |
| R11 | CSV and XLSX import mapping/preview/confirm produce correct counts and row errors. | Integration + E2E. |
| R12 | Duplicate phones, leading-zero numbers, invalid ages, formula cells, and invalid files are handled explicitly. | Import fixtures + tests. |
| R13 | Reimport does not resurrect a withdrawn contact or replace consent with older evidence. | Domain integration. |
| R14 | Consent stores scope, source, dates, wording version, and actor, with effective status derived correctly. | Unit + integration. |
| R15 | STOP cancels pending outreach; the send-time check blocks a message queued before withdrawal. | Worker integration + E2E. |
| R16 | START/JOIN after withdrawal obtains affirmative consent instead of silently opting back in. | Conversation integration. |
| R17 | Participant-initiated enrollment collects a name without creating fabricated active contacts. | E2E + integration. |
| R18 | Optional onboarding can be completed, skipped, abandoned, resumed, and updated without blocking surveys. | E2E. |
| R19 | Staff-managed tags and verified membership cannot be overwritten by participant claims. | Negative API/Flow tests. |
| R20 | All five authoring question types save, preview, deliver, and accept valid answers end to end. | E2E + provider contract. |
| R21 | Native buttons/lists obey capabilities; multi-select uses a form submission and enforces min/max/exclusive options. | Unit + contract + E2E. |
| R22 | Missing required Flow/template binding blocks live readiness with a specific error, not a silent fallback. | Contract + configuration tests. |
| R23 | Everyone, individual, group/tag, and demographic audience modes produce deduplicated tenant-scoped recipients. | Integration + E2E. |
| R24 | Scheduling freezes the audience; later contact creation does not silently add recipients. | Integration. |
| R25 | A schedule survives restarts and sends due invitations once, with timezone-correct opening/closing. | Fake-clock worker integration. |
| R26 | Default closing is exactly 48 hours after intended opening; Admin overrides are respected. | Boundary unit + integration. |
| R27 | An overdue closing job does not allow late answers, and restart after closure does not send stale invites. | Worker/answer integration. |
| R28 | Repeated launch requests are idempotent; different payloads with the same key are rejected. | Concurrent API integration. |
| R29 | Unschedule before outreach cancels old jobs; launched questions cannot be edited in place. | API + worker integration. |
| R30 | Test-run messages, answers, and delivery events never enter live survey reporting or result sharing. | Integration + E2E. |
| R31 | Starting/answering two surveys cannot attach an answer to the wrong question or disrupt a foreground session. | Conversation integration. |
| R32 | Partial responses persist and RESUME continues at the correct next unanswered question. | E2E. |
| R33 | Final acknowledgement occurs once; completion does not wait for edit-window expiry. | Integration + E2E. |
| R34 | An answer at 119 seconds can be edited under the 120-second default; at exactly 120 seconds it cannot. | Fake-clock unit/integration. |
| R35 | Repeated edits do not extend the original window, and editing is disabled when configured to zero. | Unit + integration. |
| R36 | A Flow opened before expiry but submitted after expiry is rejected without changing the earlier answer. | Integration + simulator E2E. |
| R37 | Two simultaneous first replies create one canonical answer; identical resubmission is a no-op. | Concurrency integration. |
| R38 | Duplicate inbound message IDs do not add votes, revisions, acknowledgements, or next questions. | Inbox/worker integration. |
| R39 | Clearly older distinct replies cannot overwrite a newer accepted choice; equal timestamps use documented ordering. | Integration. |
| R40 | Bad webhook signatures are rejected; correct raw-body signatures work; batched messages/statuses are all processed. | Provider contract + integration. |
| R41 | Forged/mismatched action tokens, another sender's Flow token, and invalid option IDs cannot create answers. | Security integration. |
| R42 | Webhook success is sent only after durable persistence; retried ingress is idempotent. | Failure-injection integration. |
| R43 | Outgoing job leases survive crashes; known failures retry safely and ambiguous sends do not auto-resend. | Worker failure-injection tests. |
| R44 | Delivered/Read state does not regress on out-of-order callbacks; unmatched statuses are reconciled. | Integration. |
| R45 | No free-form proactive message is sent outside the 24-hour window; outbound templates do not open it. | Fake-clock provider-policy tests. |
| R46 | Aggregate results count current answers only, handle partial surveys and zero denominators, and never exceed 100% delivery-based response rate. | Known-data query tests. |
| R47 | Multi-select percentages use respondents as denominator and can exceed 100% in total; ratings show correct distribution/mean. | Known-data query tests. |
| R48 | Demographic snapshots remain stable after profile changes; missing fields and small-cohort rules display correctly. | Integration + E2E. |
| R49 | Admin can view/export individual responses and revisions; sensitive accesses are audited without answer values in logs. | API + E2E. |
| R50 | CSV/XLSX exports reconcile with results and neutralize formula injection while preserving phone text. | Parsed export tests. |
| R51 | Admin can share one fixed result snapshot after closure only with actual, consented, non-test respondents. | Integration + E2E. |
| R52 | Results outreach outside the window uses a template; requesting View results returns the bound aggregate snapshot. | Provider contract + simulator E2E. |
| R53 | Repeated Share/retry requests cannot create a second broadcast or recompute an already shared snapshot. | Concurrent API/worker tests. |
| R54 | Shared results never contain identities, individual answers, or demographic slices and enforce the minimum sample rule. | Serializer + snapshot tests. |
| R55 | Archive preserves research history; no destructive survey-delete endpoint exists. | API + persistence test. |
| R56 | Temporary imports/webhooks are cleaned up according to configured retention without removing canonical answers. | Fake-clock cleanup tests. |
| R57 | Live configuration rejects emulator/demo/simulator settings and missing secrets; synthetic contacts cannot receive real sends. | Startup + negative send tests. |
| R58 | Internal task endpoints reject untrusted callers, and routing a job/webhook cannot cross tenant boundaries. | Auth/security integration. |
| R59 | The 1,000-contact local launch is batched, restart-safe, responsive, and has no lost/duplicate logical invitations. | Reproducible local scale test. |
| R60 | README commands, production builds, OpenAPI, checked-in migrations, Flow assets, setup guides, and verification evidence are complete. | Clean-clone smoke + artifact inspection. |

### 23.3 Performance and operational checks

Use 1,000 contacts, a five-question survey including multi-select, and synthetic response/status events. On a documented local reference machine, record bulk-launch request time, queue processing rate, response ingestion latency, aggregate query latency, and resource usage.

Target interactive API/result requests under two seconds at the 95th percentile for this local dataset, excluding file generation and deliberately paced provider sends. Treat this as an engineering target to measure, not a verified promise about all deployment hardware. Investigate slow SQL and unbounded loops before adding infrastructure.

Exercise at least one restart during queued dispatch and one duplicate callback burst. Verify canonical totals by independently querying persisted records. Extrapolating a 1,000-contact test is not proof of 100,000-contact production capacity.

### 23.4 Definition of done

The build is locally complete only when the requested workflows operate through UI, API, persistence, jobs, and simulator; migrations/seeds are reproducible; relevant tests pass; production bundles/containers build; and documentation reflects the actual implementation.

Record actual commands and results in `plan/verification.md`. Separate Passed, Failed, Not run, and Externally blocked. Do not mark live Meta or GCP verification Passed because a mock test succeeded. Repair local failures where feasible; disclose any remaining gaps by requirement ID.

An unavailable cloud account does not justify stopping after scaffolding. Finish and verify the local scope, retain the real adapter and setup guide, and identify the remaining external activation steps accurately.

## 24. Explicit post-MVP scope

Do not build self-service organization registration, billing/subscriptions, tenant-switching UI, Google/Microsoft login, public results links, Urdu translations/RTL UI, arbitrary workflow branching, survey free text, automated reminders, cross-channel messaging, sentiment analysis, AI question generation, automatic political-opinion inference, research weighting, or national-polling claims.

Do not build Terraform, CI/CD, GitHub Actions, production infrastructure, or a live external deployment. Do not scrape contact numbers or use unofficial WhatsApp browser libraries.

The tenant model, locale-ready content, provider boundary, durable jobs, and indexed/paginated queries are in scope now because they prevent predictable structural rework. Other SaaS infrastructure is not.

## 25. External references and verification notes

Product choices and acceptance rules above are Raaye requirements. The references below support external platform facts and integration entry points; they are not a substitute for validating the exact dependency and Graph versions used by the implementation.

Reference check date: 7 October 2026. Some Meta developer pages returned access/rate-limit errors during preparation. Public policy, official examples, and available primary-source documentation were used. Recheck exact Flow component schemas and current message limits during implementation and before live activation.

### WhatsApp / Meta

- **W1. WhatsApp Business Messaging Policy.** Permission, templates, service window, privacy/support obligations, and restricted political/government uses. Retrieved policy states last updated 23 September 2026. <https://whatsappbusiness.com/policy/>
- **W2. Meta's archived SDK ActionObject reference.** Documents reply-button structure and three-button limit. Structural reference only; do not install the archived SDK as the implementation strategy. <https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/ActionObject/>
- **W3. Meta interactive list messages reference.** Official indexed documentation describes ten rows total. Full-page access was rate-limited during preparation; verify current payload limits. <https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages>
- **W4. Meta's WhatsApp Cloud API Postman collection.** Account prerequisites, messaging endpoints, examples, and linked management APIs. <https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api>
- **W5. Meta's WhatsApp Flows survey example.** Demonstrates creating/publishing/sending a Flow and processing `nfm_reply.response_json`. Example versions are historical, not version recommendations. <https://github.com/WhatsApp/WhatsApp-Flows-Tools/blob/main/articles/creating-surveys/main.py>
- **W6. Meta quick-reply webhook example.** Shows the template-button `button.payload` response and sender/context metadata. <https://www.postman.com/meta/whatsapp-business-platform/request/5qal58f/received-callback-from-a-quick-reply-button-click>
- **W7. Meta Flows component reference.** Implementation reference for checkbox/radio groups, optional inputs, and supported schema. Full page not retrieved during preparation. <https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/reference/components>
- **W8. Meta's archived webhook reference.** Illustrates GET verification and POST signature authentication. Do not copy its raw-message logging examples into Raaye. <https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/>

### Google Cloud / Firebase

- **G1. Cloud Tasks issues and limitations.** Duplicate execution and retry behavior require idempotent application handling. <https://docs.cloud.google.com/tasks/docs/common-pitfalls>
- **G2. Executing asynchronous tasks with Cloud Run.** Cloud Tasks delivery to authenticated service handlers. <https://docs.cloud.google.com/run/docs/triggering/using-tasks>
- **G3. Running services on a schedule.** Cloud Scheduler invocation of Cloud Run. <https://docs.cloud.google.com/run/docs/triggering/using-scheduler>
- **G4. Firebase Authentication Emulator.** Local email/password behavior and the prohibition on accepting emulator tokens/configuration in production. <https://firebase.google.com/docs/emulator-suite/connect_auth>

### Coding-agent instruction discovery

- **A1. OpenAI Codex project instructions.** `AGENTS.md` discovery and instruction-size behavior. <https://developers.openai.com/codex/guides/agents-md/>
- **A2. Claude Code project memory/instructions.** `AGENTS.md` behavior and the `@AGENTS.md` import supported from `CLAUDE.md`. <https://code.claude.com/docs/en/memory>

The separate `CLAUDE.md` in this pack is a compatibility bridge, not a second copy of the agent rules. Its only job is to import the canonical `AGENTS.md`.

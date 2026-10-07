# Raaye: Product Vision

Version: 1.0  
Date: 7 October 2026  
Initial organization: Public Interest Law Association of Pakistan (PILAP)  
Status: Approved product direction translated from the founder's decisions

## 1. Purpose

Raaye helps organizations ask structured questions through WhatsApp, collect permission-based responses, and understand the results without requiring participants to install another application.

The first deployment serves PILAP, described by the product owner as an apolitical, nonprofit civil-society organization. Its use case is voluntary public-interest research and citizen consultation. The product must use the organization's real identity and purpose, not disguise its activities to obtain platform approval.

**Product statement:** An organization can create a survey, choose a consented audience, deliver it through WhatsApp, and examine accurate, traceable results from one dashboard.

Raaye is the product. PILAP is its first tenant, not a hard-coded exception.

## 2. The problem

An organization should not need to manually message a contact list, reconcile screenshots and chat replies, remove duplicate answers, and build a spreadsheet after every survey. Participants should not need to understand a new survey platform simply to give an opinion.

The difficult part is not displaying a poll. It is maintaining consent, associating every response with the correct question, handling deliveries and retries, supporting limited answer changes, protecting identities, and explaining exactly what the results represent.

Raaye brings those responsibilities into a single workflow.

## 3. Who it serves

### Organization administrators

Administrators manage their organization, staff access, contacts, consent, messaging configuration, and surveys. They may inspect identifiable individual responses. They can decide to share an aggregate result summary with respondents after a survey closes.

### Survey managers

Survey managers maintain contacts and run surveys. They need audience selection, scheduling, test sends, delivery visibility, aggregate analysis, demographic breakdowns, and exports. In the MVP they do not receive identifiable individual-response access or administrator privileges.

### Viewers

Viewers examine aggregate results and permitted aggregate exports. They cannot access contact directories, individual responses, credentials, or sending controls.

### Participants

Participants receive a recognizable invitation from the organization, choose whether to begin, answer a short sequence of questions, optionally supply profile information, and stop receiving messages whenever they choose. They do not need a Raaye account.

## 4. The essential product experience

### For staff

1. Sign in using email and password.
2. Add contacts manually or import CSV/XLSX files, with explicit consent evidence rather than assuming that imported numbers are eligible.
3. Create a multi-question survey and preview its actual messaging formats.
4. Choose everyone, specific contacts, groups/tags, or a demographic filter. Everyone is the default selection mode, not permission to message everyone.
5. Send a test, review eligibility, then launch immediately or schedule delivery.
6. Monitor delivery and participation, examine aggregate results, and export permitted data.
7. Close or automatically finish the survey. Optionally share a frozen aggregate summary with eligible respondents.
8. Archive surveys instead of deleting their research history.

### For participants

1. Receive an invitation identifying the organization and the voluntary nature of the survey.
2. Tap Start survey.
3. Optionally complete or skip a short demographic onboarding step.
4. Answer one question at a time. Use simple choices for simple questions and an in-WhatsApp form for multiple selection.
5. Change a recent answer within the survey's configured edit window, when necessary.
6. Receive confirmation that the response has been recorded.
7. Optionally receive access to aggregate results if the administrator shares them and the participant has the relevant permission recorded.

No participant-facing public results website is required for the MVP.

## 5. Product principles

### Permission before outreach

Possessing a phone number, importing a spreadsheet, or enrolling someone as a member is not the same as permission to send WhatsApp surveys. Consent evidence, purpose, status, and withdrawal are first-class records. The system rechecks permission immediately before sending.

### Low participant effort

Default to one question at a time. Keep instructions brief, show progress, do not interrupt every answer with a separate administrative step, and make optional profiling genuinely skippable. Never force a person to disclose demographics to complete an otherwise eligible survey.

### Correctness before attractive charts

A duplicate webhook is not a second vote. A revised answer replaces the current answer without adding another respondent. No response is not an indifferent response. Multiple-selection percentages need not sum to 100%. Delivery, participation, and completion are different measures.

### Privacy without false promises

Raaye is not an anonymous survey system in this MVP. Authorized organization Admins can link responses to contacts. Tell participants this clearly. Separate contact information from response records, restrict identifiable access, and audit sensitive actions. Aggregate presentation is not a guarantee of anonymity.

### Tenant isolation from the first migration

Every tenant-owned object belongs to an organization. A person participating with two organizations has separate contact and consent records. Authorization and database relationships must prevent cross-organization access, including jobs, webhooks, exports, and simulator traffic.

### Local execution is the first delivery contract

The application must run completely locally using Docker, a local database, emulated authentication, and a WhatsApp simulator. Real credentials and platform approvals must not be prerequisites for demonstrating every requested product capability.

### Honest integration boundaries

A working simulator does not prove that Meta has approved an organization, template, or Flow. Real integration code, contract tests, configuration validation, and a production setup guide are required. Account-specific approval and actual live delivery remain separate verification steps.

### A simple architecture with deliberate extension points

Use an Angular frontend, a NestJS modular backend, and PostgreSQL. Separate provider integration, persistence, scheduling, authentication, and business rules where that boundary has a concrete purpose. Do not build a microservice platform, generic workflow language, AI assistant, or billing system for the first release.

## 6. MVP outcome

A team of four or five PILAP staff should be able to run a survey against approximately 1,000 contacts and complete the entire administrative and participant journey locally before connecting a live WhatsApp account.

The MVP includes:

- Email/password access with Admin, Survey Manager, and Viewer roles.
- Organization-scoped contacts, CSV/XLSX imports, consent, groups/tags, and optional demographic onboarding.
- Multi-question surveys supporting Yes/No, Yes/No/Indifferent, single-choice MCQ, multiple-selection MCQ, and ratings from 1 to 5.
- Draft, Scheduled, Active, and Closed states, with archiving as a separate property.
- A configurable answer-change window, default 120 seconds per question, and a configurable survey duration, default 48 hours.
- Audience filters, scheduled sending, test sends, automatic closing, delivery tracking, and reliable response collection.
- Aggregate reporting, demographic breakdowns where data exists, CSV/XLSX export, and Admin-only individual-response access.
- Admin-initiated sharing of aggregate results with eligible respondents.
- A usable simulator and seeded examples, not disconnected mock screens.

`MVP.md` is the detailed and testable contract. Defaults introduced there fill implementation gaps; they must not silently remove one of these capabilities.

## 7. Success measures

### Primary outcome

**Completed research cycles:** Surveys an organization can create, distribute, collect, analyze, and archive without manually reconciling individual chat messages.

### Supporting measures

- Launch preparation time after the contact list is ready.
- Count and proportion of contacts eligible for outreach.
- Invitation acceptance and confirmed delivery.
- Participants who start, provide at least one valid answer, and complete all questions.
- Question-level completion and drop-off.
- Opt-outs, delivery failures, and unresolved sending outcomes.
- Optional profile completion.
- Staff success in completing the principal dashboard tasks.

These are product measures, not promises of response rates or representative national polling. A selected WhatsApp audience and its voluntary respondents do not automatically represent the wider population. The MVP does not calculate population weighting, a margin of error, or statistical representativeness.

## 8. Longer-term direction

Raaye may become a SaaS product supporting multiple independent organizations and eventually 100,000 or more contacts per organization.

The MVP must preserve the foundations for this direction:

- Shared schema with explicit organization ownership and organization-scoped uniqueness.
- Membership-based staff authorization, allowing one user to belong to multiple organizations later.
- Independent organization branding, consent wording, sender configuration, and reporting boundaries.
- Stable question/option identifiers separate from translated text.
- Locale-ready content records with English implemented first and Urdu possible without changing the response schema.
- Durable jobs, bounded batch processing, pagination, and indexed queries.
- A provider abstraction that keeps survey logic independent of Meta payload details.

Future features can include self-service tenant registration, billing, organization switching, Google/Microsoft sign-in, Urdu and right-to-left presentation, advanced survey logic, public results pages, additional channels, and more sophisticated analysis.

Do not implement these future features merely because the data model can accommodate them.

## 9. Explicit boundaries

Raaye is not an election voting system, campaign targeting engine, WhatsApp scraping tool, or permissionless bulk sender. It must not impersonate an organization, infer political beliefs from names or profiles, or use unofficial WhatsApp browser automation.

Raaye does not require an LLM at runtime. Codex and Claude Code are development tools for building it, not application dependencies.

No cloud provisioning, Terraform, GitHub Actions, or production deployment is authorized by this MVP build. The repository must be suitable for GitHub, but the coding agent must not create a remote repository or push code without a separate instruction.

Survey archiving preserves research history. It is not an instruction to retain all personal data forever or ignore a later approved privacy/erasure process.

## 10. Delivery definition

The first build is successful when another engineer can use the documented Docker commands, sign in, create or import contacts, run a survey, act as a participant in the simulator, revise answers within the configured time, inspect correct results, export data, and verify tenant/role restrictions.

The same implementation must include a real WhatsApp Cloud API adapter and documented GCP deployment path, while clearly labeling integrations that have not been exercised against live accounts.

Source priority within this repository: explicit product-owner changes, then `MVP.md` for scope and behavior, `VISION.md` for purpose, and `AGENTS.md` for implementation discipline. Platform limits and security constraints must be surfaced honestly rather than bypassed.

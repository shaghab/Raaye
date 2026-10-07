# Security and privacy notes

## Identity and roles

- Staff sign in with Firebase email/password; the API verifies ID tokens (emulator locally, live project in production). There is no self-registration: Admins create single-use, 72-hour, hashed invitation links bound to an email address.
- Roles per `MVP.md`: **Admin** (everything, including identifiable answers, exports, sharing, staff, messaging configuration, timing defaults), **Survey Manager** (contacts, imports, surveys, dispatch, aggregates; never identifiable answers or Admin-only settings), **Viewer** (aggregates and aggregate exports only). Field-level permissions are enforced server-side; Managers cannot change duration or edit-window settings through the survey update DTO.
- Membership revocation takes effect on the next request; the last Admin cannot be demoted or removed.

## Tenant isolation

- Every tenant-owned row carries `organization_id`; composite foreign keys and unique constraints are organization-qualified.
- All domain code receives a scoped Prisma client that injects the organization into every query. Unscoped access is limited to documented control-plane helpers (membership resolution, webhook connection mapping, due-job claims, retention, seed).
- Integration tests prove two organizations with the same phone number stay separate across direct object access, lists, mutations, relation connects, reporting, exports, workers and webhooks.

## Participant data

- Raaye is **not anonymous**. Authorized Admins can link answers to contacts; invitations say so. Aggregate views, the 5-respondent cohort threshold and result-sharing minimums reduce disclosure risk but do not guarantee anonymity.
- Imported data is not consent. Permission has scope, source, evidence date, wording version and withdrawal history. It is rechecked right before every send. STOP overrides everything and cancels queued sends.
- Logs, job payloads, URLs and audit metadata contain identifiers, never names, phone numbers or selected answers. No third-party analytics or tracking is included.
- Raw import files are purged after 24 hours, raw webhook payloads after 7 days, quarantined payloads after 7 days.
- Exports are authenticated, served with `Cache-Control: no-store`, audited, and formula-neutralized (`= + - @` prefixes) to prevent spreadsheet injection; phone numbers are exported as text.
- Surveys are archived, never deleted, to preserve research history. This is not a claim that personal data must be retained indefinitely; a separate approved privacy/erasure process may remove contact data.

## Messaging and webhooks

- Webhook signatures are verified over the exact raw request bytes with a timing-safe comparison before anything is written. Unknown sender connections are quarantined without touching any organization, and so is traffic for a connection an Admin disabled; the send policy refuses to use a disabled sender.
- Action tokens are opaque, bound to connection + contact + participation + question, and expire. A reply is attached only where its binding says; never "the most recent survey".
- Synthetic (seeded) contacts can never be sent to a live provider. Live configuration refuses emulator flags, simulator routes, demo bootstrap and weak internal tokens, and never falls back to mock.
- The first organization and Admin of a live deployment come from the operator command `bootstrap:org`, which needs database access, issues a single-use 72-hour Admin invitation, refuses once an active Admin exists, writes an audit event and prints the acceptance link once to stdout (never to the structured log). Every later membership comes from an Admin invitation.
- A timed-out send is recorded as `UNKNOWN`; it is never retried automatically. An Admin must explicitly acknowledge the duplicate risk to retry.

## Development conveniences that must stay local

- The Firebase Auth emulator, the WhatsApp simulator (`/api/v1/dev/simulator/*`, hidden unless `ENABLE_SIMULATOR=true` in a non-live configuration), the simulated clock and fault injection, and the demo accounts (`*.demo` emails, `ALLOW_DEMO_BOOTSTRAP=true`).

## Reporting a vulnerability

Open a private report to the repository owner. Do not include real participant data in reports.

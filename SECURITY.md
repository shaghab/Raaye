# Security and privacy notes

## Identity and roles

- Staff sign in with Firebase email/password; the API verifies ID tokens (emulator locally, live project in production). There is no self-registration: Admins create single-use, 72-hour, hashed invitation links bound to an email address.
- Roles per `MVP.md`: **Admin** (everything, including identifiable answers, exports, sharing, staff, messaging configuration, timing defaults), **Survey Manager** (contacts, imports, surveys, dispatch, aggregates; never identifiable answers or Admin-only settings), **Viewer** (aggregates and aggregate exports only). Field-level permissions are enforced server-side; Managers cannot change duration or edit-window settings through the survey update DTO. Viewers see published surveys only: drafts are absent from their list and overview, and a draft read by id is reported as not found.
- Membership revocation takes effect on the next request; the last Admin cannot be demoted or removed.

## Tenant isolation

- Every tenant-owned row carries `organization_id`; composite foreign keys and unique constraints are organization-qualified.
- All domain code receives a scoped Prisma client that injects the organization into every query. Unscoped access (the plain `PrismaService`, outside the scoped client) is limited to control-plane code that runs before an organization is known or across organizations: membership resolution, staff-invitation inspection and acceptance and the `bootstrap:org` command, webhook connection mapping and inbox persistence and quarantine, due-job claims and the periodic sweep, user lookups for display emails, simulator state, the health probe, retention and seed. Business rows are read and written through the scoped client.
- Integration tests prove two organizations with the same phone number stay separate across direct object access, lists, mutations, relation connects, reporting, exports, workers and webhooks (`tenant-isolation.int-spec.ts`, with `tenant-constraints.int-spec.ts` for the database constraints and `contacts.int-spec.ts` for consent).

## Participant data

- Raaye is **not anonymous**. Authorized Admins can link answers to contacts; the participant notice that participants agree to says so, and so does the checked-in invitation template. Aggregate views, the 5-respondent cohort threshold and result-sharing minimums reduce disclosure risk but do not guarantee anonymity.
- Imported data is not consent. Permission has scope, source, evidence date, wording version and withdrawal history. It is rechecked right before every send. STOP overrides everything and cancels queued sends.
- Logs, job payloads, URLs and audit metadata contain identifiers, never names, phone numbers or selected answers. No third-party analytics or tracking is included.
- Raw import files are dropped when processing ends and, together with the staged rows (normalized names and numbers, the row-error report), at the latest 24 hours after upload; raw webhook payloads are purged after 7 days, quarantined payloads after 7 days.
- Exports are authenticated, served with `Cache-Control: no-store`, audited, and formula-neutralized (`= + - @` prefixes) to prevent spreadsheet injection; phone numbers are exported as text.
- Surveys are archived, never deleted, to preserve research history. This is not a claim that personal data must be retained indefinitely; a separate approved privacy/erasure process may remove contact data.

## Messaging and webhooks

- Webhook signatures are verified over the exact raw request bytes with a timing-safe comparison before anything is written. Unknown sender connections are quarantined without touching any organization, and so is traffic for a connection an Admin disabled; the send policy refuses to use a disabled sender. A connection whose bound secret reference does not resolve is refused outright; the process-wide `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` apply only to a connection that binds no reference.
- Action tokens are opaque, bound to connection + contact + participation + question, and expire. A reply is attached only where its binding says; never "the most recent survey".
- Synthetic (seeded) contacts can never be sent to a live provider. Live messaging configuration (`MESSAGING_MODE=live`) refuses the simulator, demo bootstrap, emulator authentication and missing Meta values, and never falls back to mock; a production configuration (`APP_ENV=production`) additionally refuses weak internal task tokens and demo Firebase project ids.
- The first organization and Admin of a live deployment come from the operator command `bootstrap:org`, which needs database access, issues a single-use 72-hour Admin invitation, refuses once an active Admin exists, writes an audit event and prints the acceptance link once to stdout (never to the structured log). Every later membership comes from an Admin invitation.
- A timed-out send is recorded as `UNKNOWN`; it is never retried automatically. An Admin must explicitly acknowledge the duplicate risk to retry.

## Development conveniences that must stay local

- The Firebase Auth emulator, the WhatsApp simulator (`/api/v1/dev/simulator/*`, hidden unless `ENABLE_SIMULATOR=true` in a non-live configuration), the simulated clock and fault injection, and the demo accounts (`*.demo` emails, `ALLOW_DEMO_BOOTSTRAP=true`).

## Reporting a vulnerability

Open a private report to the repository owner. Do not include real participant data in reports.

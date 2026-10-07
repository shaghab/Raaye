# Raaye: Start the build

This pack contains the specifications for Raaye. The repository now also contains the implementation built from them; see `README.md` for how to run it and `plan/` for acceptance and verification evidence.

## Files

| File | Purpose |
| --- | --- |
| `VISION.md` | Product purpose, users, principles, MVP outcome, and future SaaS direction. |
| `MVP.md` | Detailed behavior, architecture, schema, APIs, security, platform integration, and R01-R60 acceptance conditions. |
| `AGENTS.md` | Canonical instructions for the coding agent. |
| `CLAUDE.md` | Small compatibility bridge containing `@AGENTS.md`. No duplicate rules. |
| `START-HERE.md` | This guide and the initial build prompt. |

Place these files at the root of the local repository in which the application should be built. Keep the capitalization shown. Do not maintain separate `agent.md` and `AGENTS.md` copies that can drift.

Codex discovers `AGENTS.md`. Claude Code supports project instruction files and the `@AGENTS.md` import from `CLAUDE.md`; the bridge also accommodates sessions that do not load `AGENTS.md` directly. See the official references A1 and A2 in `MVP.md`.

## Prompt to use in Codex or Claude Code

```text
Build Raaye in this repository.

Read AGENTS.md, VISION.md, and the entire MVP.md before implementing. Treat
MVP.md as the implementation contract, including acceptance conditions R01-R60.

Implement the complete locally working MVP, not only scaffolding. Make reasonable
implementation decisions without asking further product questions, and record
material decisions in docs/DECISIONS.md.

Use the specified Angular/NestJS/PostgreSQL stack, tenant isolation, email/password
authentication emulator, durable local jobs, and WhatsApp simulator. Implement all
question types, onboarding, consent, scheduling, answer edits, reporting, exports,
and result sharing. Include the real Meta adapter and setup documentation, but do
not require live credentials for local operation.

Work in tested vertical slices. Run the application, exercise the important UI
journeys, run the tests and production build, fix failures, and verify the documented
Docker startup. Map R01-R60 to code/tests in plan/acceptance.md and record actual
verification outcomes in plan/verification.md.

Do not provision GCP, send real WhatsApp messages, change Meta assets, add Terraform
or CI/CD, or create a new remote repository. Preserve unrelated existing work.

Finish with local startup instructions, demo access, actual verification results,
and a precise list of any remaining gaps. Do not claim that unrun tests passed or
that mock success proves live Meta approval.
```

## Defaults made explicit in the specification

These decisions fill implementation gaps; the product owner's stated requirements remain intact:

- Up to 20 questions and 10 options per question in this MVP. All five requested question types are included.
- One-at-a-time questions, native buttons/lists where suitable, and compact Flows for multi-select and optional profiling.
- A 120-second default editing window per question. It starts at the first accepted answer and never resets after an edit.
- A 48-hour default deadline measured from the intended opening time, not from each recipient's delivery time.
- Audience membership freezes when scheduling/launching; permission is checked again immediately before sending.
- Only Admin can see identifiable individual answers and share results. Managers can operate surveys; Viewers see aggregates.
- Result sharing happens after closure, uses a fixed snapshot, and honors sample-size, permission, and messaging-window checks.
- English runs first; tenant ownership and locale-ready content exist in the first database model.

## What to verify after the coding run

Use the generated application's README to start Docker. Sign in as each role. Run a survey through the simulator, including optional onboarding and a multi-select question. Test an edit before and after its deadline, STOP after scheduling, aggregate exports, and result sharing after closure.

Check `plan/acceptance.md` and `plan/verification.md`, not only the agent's summary.

## Execution policy for this repository

The product owner's build instruction (7 October 2026) authorized the coding agent to commit, push the designated feature branch, open and update a pull request, create GitHub issues for deferred review findings, reply to review comments, and resolve review threads. Merging, force-pushing, changing branch protections, provisioning GCP, enabling billing, sending real WhatsApp messages, modifying Meta assets, and adding Terraform or CI/CD remain prohibited. `AGENTS.md` §2 records the same policy. Local implementation and tests can be complete while real-account onboarding, published templates/Flows, and live-delivery verification remain outstanding.

Do not run two coding agents concurrently against the same working tree. Use one agent as the initial implementer. A later verification pass in the other tool should use a clean commit/worktree and the same requirements, without silently changing the scope.

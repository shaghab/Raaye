# Message template specifications

These JSON files are **proposals**. Meta decides whether a template is approved, which category it receives and whether it stays available. Nothing in this repository can mark a template as approved; the dashboard only records what the Graph API reports.

| File | Purpose | Used when |
| --- | --- | --- |
| `survey_invitation.v1.json` | `SURVEY_INVITATION` | Every live survey invitation (business-initiated). |
| `results_available.v1.json` | `RESULTS_AVAILABLE` | Results sharing when the respondent's 24-hour service window is closed. Inside an open window a free-form message with a *View results* button is used instead. |

## How the adapter uses them

The Meta adapter (`libs/server/src/messaging/planner.ts` and `meta-payload.ts`) sends:

- body parameters, positional: `organization_name`, `survey_title`
- one quick-reply button at the bound `buttonPosition` (default `0`) whose payload is the opaque action token that routes the participant's reply back to the correct survey run

`pnpm whatsapp:validate` checks that these files still match that mapping (two body parameters, one quick-reply button, the expected purpose names) so the specification and the adapter cannot drift apart silently.

## Registering a template

1. Open WhatsApp Manager → Account tools → Message templates, or call `POST /{WABA_ID}/message_templates` with the `name`, `language`, `category`, `components` and `allow_category_change` fields from the file (drop the `$comment`, `purpose`, `assetVersion` and `adapterMapping` keys, which are repository metadata).
2. Wait for the review outcome. Meta may re-categorize a template (for example to `MARKETING`); the category reported by Meta is the one that applies.
3. In the dashboard open **Settings → Messaging**, bind the approved template name, language and button position for the purpose, then press **Refresh status**. The status shown comes from `GET /{WABA_ID}/message_templates?name=...`.
4. Readiness stays blocked (`TEMPLATE_NOT_READY`) until the invitation template reports `APPROVED`. The results template is required only when results outreach is attempted.

Templates may be paused, disabled or rejected later. Refresh the status before launching and treat a paused template as unavailable.

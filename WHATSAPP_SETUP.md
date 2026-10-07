# WhatsApp Cloud API setup

This guide takes an organization from the local mock provider to live WhatsApp messaging. Every step here is an **external prerequisite**: the application records what Meta reports and never assumes an approval. Nothing in this repository has been run against a live Meta account.

Follow the current official documentation for the Graph API version you configure (`META_GRAPH_VERSION`, default `v24.0`). Policy review (WhatsApp Business Messaging Policy, including permission, templates and the restricted uses for political or government content) is the organization's responsibility; record the review date in **Settings → Messaging → Policy review**.

## 1. Meta assets

1. Create a Meta Business portfolio and complete business verification.
2. Create a Meta developer app of type *Business* and add the **WhatsApp** product.
3. Create or connect a WhatsApp Business Account (WABA) and register a dedicated phone number. Note the **WABA ID**, **phone number ID** and **display phone number**.
4. Create a **system user** with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions and generate a long-lived access token. Store it in your secret manager, never in the dashboard or in git.
5. Note the **app ID** and **app secret** (webhook signatures are verified with the app secret).

## 2. Environment configuration (API and worker)

```text
MESSAGING_MODE=live
AUTH_MODE=live
ENABLE_SIMULATOR=false
ALLOW_DEMO_BOOTSTRAP=false
APP_ENV=production
META_GRAPH_VERSION=v24.0
META_APP_ID=<app id>
META_APP_SECRET=<app secret value from the secret manager>
META_ACCESS_TOKEN=<system user token value from the secret manager>
META_WEBHOOK_VERIFY_TOKEN=<random string you choose>
META_WABA_ID=<waba id>
META_PHONE_NUMBER_ID=<phone number id>
META_WEBHOOK_APP_KEY=<random URL-safe key>
```

Configuration validation fails closed: live mode with an emulator host, the simulator enabled, demo bootstrap, a short internal task token, or any missing `META_*` value stops the process with a readable reason. There is no fallback to mock mode.

In the dashboard (Admin) open **Settings → Messaging** and enter the non-secret identifiers plus the **names of the environment variables** holding the secrets (`appSecretRef`, `accessTokenRef`, `verifyTokenRef`). The readiness panel shows blockers until everything is bound.

## 3. Webhook

1. Deploy the API so that `https://<api-host>/api/v1/webhooks/whatsapp/<META_WEBHOOK_APP_KEY>` is reachable over HTTPS.
2. In the app dashboard → WhatsApp → Configuration, set the callback URL to that path and the verify token to `META_WEBHOOK_VERIFY_TOKEN`. Meta sends `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`; the API echoes the challenge only when the token matches.
3. Subscribe to the `messages` field (message and status events).
4. Subscribe the app to the WABA (`POST /{WABA_ID}/subscribed_apps`). `pnpm whatsapp:validate --live` describes this request; it is not executed automatically.

Every `POST` is verified with `X-Hub-Signature-256` (HMAC-SHA256 of the raw bytes with the app secret). Payloads whose `phone_number_id` does not match the configured connection are quarantined, not attributed to the organization. All messages and statuses in a batch are processed; duplicates by `wamid` are ignored.

## 4. Message templates

Two template proposals live in `whatsapp/templates/`:

| Purpose | Default name | Used for |
| --- | --- | --- |
| `SURVEY_INVITATION` | `raaye_survey_invitation` | Every live invitation (business-initiated) |
| `RESULTS_AVAILABLE` | `raaye_results_available` | Results sharing outside the 24-hour service window |

1. Submit each template in WhatsApp Manager (or via `POST /{WABA_ID}/message_templates`) with the body text, two positional parameters (organization name, survey title), the sample values and one **quick reply** button.
2. Wait for Meta's review. Meta decides the category (`UTILITY` or `MARKETING`) and may change it.
3. Bind the approved name, language and quick-reply button index in **Settings → Messaging → Template bindings** and press **Refresh status**. The status shown comes from `GET /{WABA_ID}/message_templates?name=…`.
4. Launching stays blocked (`TEMPLATE_NOT_READY`) until the invitation template is `APPROVED`. A paused or disabled template blocks sending again.

Sending a template does not open a customer service window; the participant's reply does.

## 5. Flows

Three versioned Flow JSON assets live in `whatsapp/flows/`:

| Purpose | File | Entry screen |
| --- | --- | --- |
| `SINGLE_CHOICE` | `single-choice.v1.json` | `QUESTION` |
| `MULTI_CHOICE` | `multi-choice.v1.json` | `QUESTION` |
| `PROFILE` | `profile.v1.json` | `PROFILE` |

1. Run `pnpm whatsapp:validate` locally (structure, dynamic references, payload keys, fixtures).
2. Create a Flow per purpose in WhatsApp Manager → Flows (categories `SURVEY` / `OTHER`), or `POST /{WABA_ID}/flows`.
3. Upload the JSON as the Flow asset (`POST /{FLOW_ID}/assets` with `asset_type=FLOW_JSON`). `pnpm whatsapp:validate --live --upload-flow=MULTI_CHOICE=<flowId> --apply` performs exactly this upload and prints Meta's `validation_errors`. It modifies a **draft** Flow asset and is never run automatically.
4. Test the Flow from the builder, then **publish** it.
5. Bind each published Flow ID in **Settings → Messaging → Flow bindings**. Readiness reports `FLOW_NOT_READY` until a question needs a Flow that is not published and bound, and warns when the published asset version differs from the repository asset.

Flow responses arrive as `nfm_reply` interactive messages carrying the `action_token` (also sent as `flow_token`), which binds the submission to the exact participation and question. Submissions with an unknown or foreign token are rejected.

## 6. Going live checklist

1. Policy review recorded in the dashboard; privacy notice URL and support contact set.
2. Templates approved and bound; Flows published and bound; readiness green.
3. `MESSAGING_MODE=live` configuration validated at startup (no emulator, no simulator, no demo bootstrap).
4. Webhook verified and subscribed; a test message from the WhatsApp test number confirmed end to end.
5. Contacts with **recorded permission** only; synthetic seed data must not exist in the live database (the demo bootstrap is refused in live mode, and synthetic contacts are blocked by the send policy regardless).
6. Use **Send test** with a staff member's own number (with permission recorded) before launching to an audience; live test sends are charged like any other message.

## 7. What remains unverified in this repository

- Template approval, category assignment and availability for a real WABA.
- Flow builder validation and publication of the three assets.
- Live webhook delivery, signature verification against real Meta payloads (verified only against the documented format and fixtures), and delivery status reconciliation on a real number.
- Rate limits, conversation charges and quality-rating effects.

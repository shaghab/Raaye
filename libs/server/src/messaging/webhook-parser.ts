import { z } from 'zod';

/** Normalized inbound message produced from a Meta webhook or the local simulator. */
export interface NormalizedInbound {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  providerMessageId: string;
  senderIdentity: string;
  senderProfileName: string | null;
  providerAt: Date;
  kind: 'TEXT' | 'BUTTON_REPLY' | 'LIST_REPLY' | 'TEMPLATE_BUTTON' | 'FLOW_REPLY' | 'UNSUPPORTED';
  text: string | null;
  actionId: string | null;
  flowResponse: Record<string, unknown> | null;
  contextMessageId: string | null;
  rawType: string;
}

export interface NormalizedStatus {
  phoneNumberId: string;
  providerMessageId: string;
  recipientIdentity: string | null;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  providerAt: Date;
  errorCode: string | null;
  errorTitle: string | null;
}

export interface ParsedWebhook {
  inbound: NormalizedInbound[];
  statuses: NormalizedStatus[];
  unsupported: number;
}

const stringish = z.union([z.string(), z.number()]).transform(String);

const messageSchema = z
  .object({
    id: z.string().min(1).max(200),
    from: stringish,
    timestamp: stringish,
    type: z.string().max(40).optional(),
    text: z.object({ body: z.string().max(8192) }).partial().optional(),
    button: z.object({ payload: z.string().max(512).optional(), text: z.string().max(512).optional() }).optional(),
    interactive: z
      .object({
        type: z.string().max(40).optional(),
        button_reply: z.object({ id: z.string().max(512), title: z.string().max(512).optional() }).optional(),
        list_reply: z.object({ id: z.string().max(512), title: z.string().max(512).optional(), description: z.string().max(512).optional() }).optional(),
        nfm_reply: z.object({ response_json: z.string().max(16384), name: z.string().max(100).optional(), body: z.string().max(512).optional() }).optional(),
      })
      .optional(),
    context: z.object({ id: z.string().max(200).optional(), from: stringish.optional() }).partial().optional(),
  })
  .passthrough();

const statusSchema = z
  .object({
    id: z.string().min(1).max(200),
    status: z.string().max(40),
    timestamp: stringish,
    recipient_id: stringish.optional(),
    errors: z.array(z.object({ code: z.union([z.number(), z.string()]).optional(), title: z.string().max(300).optional(), message: z.string().max(300).optional() }).passthrough()).optional(),
  })
  .passthrough();

const changeValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z.object({ display_phone_number: stringish.optional(), phone_number_id: stringish }).passthrough(),
    contacts: z.array(z.object({ wa_id: stringish.optional(), profile: z.object({ name: z.string().max(300).optional() }).partial().optional() }).passthrough()).optional(),
    messages: z.array(messageSchema).optional(),
    statuses: z.array(statusSchema).optional(),
  })
  .passthrough();

const webhookSchema = z
  .object({
    object: z.string().optional(),
    entry: z.array(
      z
        .object({
          id: stringish.optional(),
          changes: z.array(z.object({ field: z.string().optional(), value: changeValueSchema }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function toDate(timestamp: string): Date {
  const seconds = Number(timestamp);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * (seconds > 1e12 ? 1 : 1000));
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** Parse untrusted webhook JSON into normalized events. Every entry, change, message and status is processed. */
export function parseMetaWebhook(payload: unknown): ParsedWebhook | { error: string } {
  const result = webhookSchema.safeParse(payload);
  if (!result.success) return { error: 'Unrecognized webhook payload' };
  const inbound: NormalizedInbound[] = [];
  const statuses: NormalizedStatus[] = [];
  let unsupported = 0;
  for (const entry of result.data.entry) {
    for (const change of entry.changes) {
      const value = change.value;
      const phoneNumberId = String(value.metadata.phone_number_id);
      const displayPhoneNumber = value.metadata.display_phone_number ? String(value.metadata.display_phone_number) : null;
      const profileNames = new Map((value.contacts ?? []).map((contact) => [String(contact.wa_id ?? ''), contact.profile?.name ?? null]));
      for (const message of value.messages ?? []) {
        const normalized = normalizeMessage(message, phoneNumberId, displayPhoneNumber, profileNames.get(message.from) ?? null);
        if (normalized.kind === 'UNSUPPORTED') unsupported += 1;
        inbound.push(normalized);
      }
      for (const status of value.statuses ?? []) {
        const mapped = mapStatus(status.status);
        if (!mapped) {
          unsupported += 1;
          continue;
        }
        const error = status.errors?.[0];
        statuses.push({
          phoneNumberId,
          providerMessageId: status.id,
          recipientIdentity: status.recipient_id ? String(status.recipient_id) : null,
          status: mapped,
          providerAt: toDate(status.timestamp),
          errorCode: error?.code !== undefined ? String(error.code) : null,
          errorTitle: error?.title ?? error?.message ?? null,
        });
      }
    }
  }
  return { inbound, statuses, unsupported };
}

function mapStatus(status: string): NormalizedStatus['status'] | null {
  switch (status.toLowerCase()) {
    case 'sent':
      return 'SENT';
    case 'delivered':
      return 'DELIVERED';
    case 'read':
      return 'READ';
    case 'failed':
      return 'FAILED';
    default:
      return null;
  }
}

function normalizeMessage(message: z.infer<typeof messageSchema>, phoneNumberId: string, displayPhoneNumber: string | null, profileName: string | null): NormalizedInbound {
  const base = {
    phoneNumberId,
    displayPhoneNumber,
    providerMessageId: message.id,
    senderIdentity: message.from,
    senderProfileName: profileName,
    providerAt: toDate(message.timestamp),
    contextMessageId: message.context?.id ?? null,
    rawType: message.type ?? 'unknown',
    text: null as string | null,
    actionId: null as string | null,
    flowResponse: null as Record<string, unknown> | null,
  };
  if (message.type === 'text' && typeof message.text?.body === 'string') {
    return { ...base, kind: 'TEXT', text: message.text.body };
  }
  if (message.type === 'button' && message.button?.payload) {
    return { ...base, kind: 'TEMPLATE_BUTTON', actionId: message.button.payload, text: message.button.text ?? null };
  }
  if (message.type === 'interactive' && message.interactive) {
    const interactive = message.interactive;
    if (interactive.button_reply) return { ...base, kind: 'BUTTON_REPLY', actionId: interactive.button_reply.id, text: interactive.button_reply.title ?? null };
    if (interactive.list_reply) return { ...base, kind: 'LIST_REPLY', actionId: interactive.list_reply.id, text: interactive.list_reply.title ?? null };
    if (interactive.nfm_reply) {
      return { ...base, kind: 'FLOW_REPLY', flowResponse: parseFlowResponse(interactive.nfm_reply.response_json) };
    }
  }
  return { ...base, kind: 'UNSUPPORTED' };
}

const flowResponseSchema = z
  .object({
    flow_token: z.string().max(512).optional(),
    action_token: z.string().max(512).optional(),
    selected: z.array(z.string().max(100)).max(50).optional(),
    selected_option_ids: z.array(z.string().max(100)).max(50).optional(),
    selection: z.string().max(100).optional(),
    city: z.string().max(100).optional(),
    district: z.string().max(100).optional(),
    gender: z.string().max(40).optional(),
    age_band: z.string().max(40).optional(),
    occupation: z.string().max(120).optional(),
    membership: z.string().max(40).optional(),
  })
  .strict();

/** Flow `response_json` is untrusted JSON with a bounded schema; unknown keys are rejected. */
export function parseFlowResponse(json: string): Record<string, unknown> | null {
  if (json.length > 16384) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    const result = flowResponseSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

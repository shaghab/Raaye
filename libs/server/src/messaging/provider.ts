import type { RenderedMessage } from './rendered';

export interface SendRequest {
  /** The organization-owned sender; `accessTokenRef` names the secret that authenticates its sends. */
  connection: { id: string; phoneNumberId: string | null; graphVersion: string | null; appKey: string; accessTokenRef: string | null };
  /** Digit-only destination (wa_id). */
  to: string;
  message: RenderedMessage;
  messageId: string;
  contactId: string;
  attemptNumber: number;
  isTest: boolean;
  /** Provider Flow id for flow messages, resolved from the organization's FlowBinding. */
  flowId?: string | null;
}

export type SendResult =
  | { outcome: 'ACCEPTED'; providerMessageId: string }
  | { outcome: 'FAILED'; errorCode: string; retryable: boolean; detail?: string }
  | { outcome: 'UNKNOWN'; errorCode: string; detail?: string };

/** Narrow provider boundary. The domain never sees provider JSON. */
export interface ProviderAdapter {
  readonly mode: 'mock' | 'live';
  send(request: SendRequest): Promise<SendResult>;
}

export const MESSAGING_PROVIDER = Symbol('MESSAGING_PROVIDER');

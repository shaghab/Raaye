import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { getLogger } from '../observability/logger';
import { buildMetaMessagePayload } from './meta-payload';
import type { ProviderAdapter, SendRequest, SendResult } from "./provider";

export interface MetaHttp {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<{ status: number; text(): Promise<string> }>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Error codes that must not be retried automatically (auth, policy, template, recipient). */
const NON_RETRYABLE = new Set([190, 10, 200, 100, 131026, 131047, 131051, 131053, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 133000, 133004, 133005, 135000, 131031, 131042, 131045]);
const RETRYABLE = new Set([1, 2, 4, 33, 80007, 130429, 131016, 131056, 131000, 131005]);

export interface MetaErrorInfo {
  code: number | null;
  message: string;
  retryable: boolean;
}

export function classifyMetaError(status: number, body: string): MetaErrorInfo {
  let code: number | null = null;
  let message = `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: number; message?: string; error_subcode?: number } };
    if (parsed.error) {
      code = typeof parsed.error.code === 'number' ? parsed.error.code : null;
      message = parsed.error.message ?? message;
    }
  } catch {
    // keep http status
  }
  if (code !== null && NON_RETRYABLE.has(code)) return { code, message, retryable: false };
  if (code !== null && RETRYABLE.has(code)) return { code, message, retryable: true };
  if (status === 429 || status >= 500) return { code, message, retryable: true };
  if (status === 401 || status === 403) return { code, message, retryable: false };
  return { code, message, retryable: false };
}

/**
 * WhatsApp Cloud API adapter. HTTPS only, pinned Graph version, secrets resolved by
 * reference. A timeout after the request was transmitted is reported as UNKNOWN so the
 * caller never resends automatically.
 */
@Injectable()
export class MetaMessagingProvider implements ProviderAdapter {
  readonly mode = 'live' as const;
  private readonly logger = getLogger('meta');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly http: MetaHttp = { fetch: (url, init) => fetch(url, init) },
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async send(request: SendRequest): Promise<SendResult> {
    if (!request.connection.phoneNumberId) return { outcome: 'FAILED', errorCode: 'CONNECTION_NOT_CONFIGURED', retryable: false };
    const token = this.config.META_ACCESS_TOKEN ?? null;
    if (!token) return { outcome: 'FAILED', errorCode: 'ACCESS_TOKEN_MISSING', retryable: false };
    const version = request.connection.graphVersion ?? this.config.META_GRAPH_VERSION ?? 'v24.0';
    let payload: Record<string, unknown>;
    try {
      payload = buildMetaMessagePayload(request.to, request.message, request.flowId ?? undefined);
    } catch (error) {
      return { outcome: 'FAILED', errorCode: error instanceof Error ? error.message : 'PAYLOAD_INVALID', retryable: false };
    }
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(request.connection.phoneNumberId)}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let transmitted = false;
    try {
      transmitted = true;
      const response = await this.http.fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.status >= 200 && response.status < 300) {
        const parsed = JSON.parse(text) as { messages?: { id?: string }[] };
        const id = parsed.messages?.[0]?.id;
        if (!id) return { outcome: 'UNKNOWN', errorCode: 'NO_MESSAGE_ID', detail: 'Provider accepted the request without a message id' };
        return { outcome: 'ACCEPTED', providerMessageId: id };
      }
      const info = classifyMetaError(response.status, text);
      this.logger.warn({ status: response.status, code: info.code, messageId: request.messageId }, 'Meta rejected message');
      return { outcome: 'FAILED', errorCode: info.code !== null ? `META_${info.code}` : `HTTP_${response.status}`, retryable: info.retryable, detail: info.message.slice(0, 300) };
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      if (name === 'AbortError' || /timeout/i.test(message)) {
        return { outcome: 'UNKNOWN', errorCode: 'TIMEOUT', detail: 'No response before the timeout; the provider may have accepted the message' };
      }
      // Only failures that provably happened before any bytes reached Meta are safe to retry
      // automatically (connection refused, DNS, TLS handshake). A reset or hang-up after the
      // request was attempted may follow an accepted message, so it takes the ambiguous path
      // and needs an explicit, acknowledged retry.
      const beforeConnection = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|certificate|TLS|SSL|CERT_/i.test(message);
      if (!transmitted || beforeConnection) {
        return { outcome: 'FAILED', errorCode: 'NETWORK', retryable: true, detail: message.slice(0, 200) };
      }
      return { outcome: 'UNKNOWN', errorCode: 'NETWORK_AFTER_SEND', detail: message.slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }
}

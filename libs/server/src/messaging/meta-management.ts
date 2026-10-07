import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env';

export interface TemplateStatusResult {
  name: string;
  language: string;
  status: string;
  category: string | null;
}

export interface ManagementRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown> | FormData;
}

/**
 * Explicit operator commands against the Graph management APIs (templates, webhook
 * subscription, Flows). Nothing here runs automatically at startup; every mutation
 * supports a dry run that only describes the request.
 */
@Injectable()
export class MetaManagementClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get version(): string {
    return this.config.META_GRAPH_VERSION ?? 'v24.0';
  }

  private token(): string {
    const token = this.config.META_ACCESS_TOKEN ?? null;
    if (!token) throw new Error('META_ACCESS_TOKEN is not configured');
    return token;
  }

  describe(request: ManagementRequest): string {
    const body = request.body instanceof FormData ? '[multipart form data]' : JSON.stringify(request.body ?? {});
    return `${request.method} https://graph.facebook.com/${this.version}/${request.path} ${request.method === 'POST' ? body : ''}`.trim();
  }

  async call<T>(request: ManagementRequest): Promise<T> {
    const url = `https://graph.facebook.com/${this.version}/${request.path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token()}` };
    let body: string | FormData | undefined;
    if (request.body instanceof FormData) body = request.body;
    else if (request.body) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.body);
    }
    const response = await fetch(url, { method: request.method, headers, body });
    const text = await response.text();
    if (!response.ok) throw new Error(`Meta API ${request.method} ${request.path} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  /** GET /{WABA_ID}/message_templates filtered by name. */
  async templateStatus(wabaId: string, name: string): Promise<TemplateStatusResult[]> {
    const result = await this.call<{ data?: { name: string; language: string; status: string; category?: string }[] }>({
      method: 'GET',
      path: `${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,language,category`,
    });
    return (result.data ?? []).map((item) => ({ name: item.name, language: item.language, status: item.status, category: item.category ?? null }));
  }

  subscribeAppRequest(wabaId: string): ManagementRequest {
    return { method: 'POST', path: `${encodeURIComponent(wabaId)}/subscribed_apps` };
  }

  createFlowRequest(wabaId: string, name: string, categories: string[]): ManagementRequest {
    return { method: 'POST', path: `${encodeURIComponent(wabaId)}/flows`, body: { name, categories } };
  }

  uploadFlowAssetsRequest(flowId: string, flowJson: string): ManagementRequest {
    const form = new FormData();
    form.append('name', 'flow.json');
    form.append('asset_type', 'FLOW_JSON');
    form.append('file', new Blob([flowJson], { type: 'application/json' }), 'flow.json');
    return { method: 'POST', path: `${encodeURIComponent(flowId)}/assets`, body: form };
  }

  publishFlowRequest(flowId: string): ManagementRequest {
    return { method: 'POST', path: `${encodeURIComponent(flowId)}/publish` };
  }
}

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildMetaMessagePayload } from '../meta-payload';
import { classifyMetaError, MetaMessagingProvider } from '../meta.provider';
import { signWebhookBody, verifyWebhookSignature } from '../signature';
import { parseFlowResponse, parseMetaWebhook } from '../webhook-parser';
import { loadConfig } from '../../config/env';

const SECRET = 'test-app-secret';

const liveConfig = () =>
  loadConfig({
    APP_ENV: 'test',
    AUTH_MODE: 'test',
    DATABASE_URL: 'postgresql://x',
    INTERNAL_TASK_TOKEN: 'x'.repeat(40),
    META_GRAPH_VERSION: 'v24.0',
    META_ACCESS_TOKEN: 'EAAtesttoken',
    FIREBASE_AUTH_EMULATOR_HOST: '',
  });

describe('Meta webhook contract (R40)', () => {
  it('verifies signatures over the exact raw bytes with a timing-safe comparison', () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account","entry":[]}', 'utf8');
    const header = signWebhookBody(raw, SECRET);
    expect(verifyWebhookSignature(raw, header, SECRET)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString())), 'utf8'), header, SECRET)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(' ' + raw.toString(), 'utf8'), header, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, header, 'other-secret')).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, 'sha256=zz', SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, header.replace('sha256=', 'sha1='), SECRET)).toBe(false);
  });

  it('parses every message and status across multiple entries, changes and senders', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550000000', phone_number_id: '111' },
                contacts: [{ profile: { name: 'Ayesha' }, wa_id: '923001234567' }],
                messages: [
                  { from: '923001234567', id: 'wamid.1', timestamp: '1760000000', type: 'text', text: { body: 'STOP' } },
                  { from: '923001234567', id: 'wamid.2', timestamp: '1760000001', type: 'button', button: { payload: 'tok123', text: 'Start survey' } },
                  { from: '923001234567', id: 'wamid.3', timestamp: '1760000002', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'tok.opt', title: 'Yes' } } },
                  { from: '923001234567', id: 'wamid.4', timestamp: '1760000003', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'tok.opt2', title: 'Roads', description: 'desc' } } },
                  { from: '923001234567', id: 'wamid.5', timestamp: '1760000004', type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"flow_token":"tok","selected":["a","b"]}', body: 'Sent', name: 'flow' } } },
                  { from: '923001234567', id: 'wamid.6', timestamp: '1760000005', type: 'image', image: { id: 'x' } },
                ],
              },
            },
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550000001', phone_number_id: '222' },
                statuses: [
                  { id: 'wamid.out1', status: 'delivered', timestamp: '1760000010', recipient_id: '923001234567' },
                  { id: 'wamid.out1', status: 'sent', timestamp: '1760000009', recipient_id: '923001234567' },
                  { id: 'wamid.out2', status: 'failed', timestamp: '1760000011', recipient_id: '923001234568', errors: [{ code: 131047, title: 'Re-engagement message' }] },
                  { id: 'wamid.out3', status: 'warning', timestamp: '1760000012' },
                ],
              },
            },
          ],
        },
        { id: 'WABA2', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '333' }, messages: [{ from: '15551112222', id: 'wamid.7', timestamp: '1760000020', type: 'text', text: { body: 'HELP' } }] } }] },
      ],
    };
    const parsed = parseMetaWebhook(payload);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.inbound.map((event) => [event.phoneNumberId, event.kind, event.actionId ?? event.text])).toEqual([
      ['111', 'TEXT', 'STOP'],
      ['111', 'TEMPLATE_BUTTON', 'tok123'],
      ['111', 'BUTTON_REPLY', 'tok.opt'],
      ['111', 'LIST_REPLY', 'tok.opt2'],
      ['111', 'FLOW_REPLY', null],
      ['111', 'UNSUPPORTED', null],
      ['333', 'TEXT', 'HELP'],
    ]);
    expect(parsed.inbound[0].senderProfileName).toBe('Ayesha');
    expect(parsed.inbound[0].providerAt.toISOString()).toBe('2025-10-09T08:53:20.000Z');
    expect(parsed.inbound[4].flowResponse).toEqual({ flow_token: 'tok', selected: ['a', 'b'] });
    expect(parsed.statuses.map((status) => [status.phoneNumberId, status.providerMessageId, status.status, status.errorCode])).toEqual([
      ['222', 'wamid.out1', 'DELIVERED', null],
      ['222', 'wamid.out1', 'SENT', null],
      ['222', 'wamid.out2', 'FAILED', '131047'],
    ]);
    expect(parsed.unsupported).toBe(2);
    expect(parseMetaWebhook({ hello: 'world' })).toEqual({ error: 'Unrecognized webhook payload' });
  });

  it('parses Flow responses with a bounded schema and rejects unknown keys and oversized input', () => {
    expect(parseFlowResponse(readFileSync(path.resolve(__dirname, '../../../../../whatsapp/fixtures/flow-response-multi.json'), 'utf8'))).toMatchObject({ selected: expect.any(Array) });
    expect(parseFlowResponse(readFileSync(path.resolve(__dirname, '../../../../../whatsapp/fixtures/flow-response-profile.json'), 'utf8'))).toMatchObject({ gender: 'WOMAN', membership: 'MEMBER' });
    expect(parseFlowResponse('{"flow_token":"t","evil":"x"}')).toBeNull();
    expect(parseFlowResponse('not json')).toBeNull();
    expect(parseFlowResponse(`{"flow_token":"${'x'.repeat(20000)}"}`)).toBeNull();
  });
});

describe('Meta send payloads and error classification', () => {
  it('builds text, button, list, flow and template payloads', () => {
    expect(buildMetaMessagePayload('923001234567', { type: 'text', body: 'Hi' })).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '923001234567', type: 'text', text: { preview_url: false, body: 'Hi' } });
    const buttons = buildMetaMessagePayload('923001234567', { type: 'buttons', body: 'Q', buttons: [{ id: 'a', title: 'Yes' }, { id: 'b', title: 'No' }] }) as { interactive: { type: string; action: { buttons: unknown[] } } };
    expect(buttons.interactive.type).toBe('button');
    expect(buttons.interactive.action.buttons).toHaveLength(2);
    const list = buildMetaMessagePayload('923001234567', { type: 'list', body: 'Q', buttonText: 'Choose', sections: [{ rows: [{ id: 'r1', title: '1', description: 'Very poor' }] }] }) as { interactive: { type: string; action: { button: string; sections: { rows: { id: string; description?: string }[] }[] } } };
    expect(list.interactive.action.button).toBe('Choose');
    expect(list.interactive.action.sections[0].rows[0]).toEqual({ id: 'r1', title: '1', description: 'Very poor' });
    const flow = buildMetaMessagePayload('923001234567', { type: 'flow', body: 'Q', cta: 'Open form', purpose: 'MULTI_CHOICE', flowToken: 'tok', screen: 'QUESTION', assetVersion: 'multi-choice.v1', data: { prompt: 'Q' } }, 'FLOW123') as { interactive: { type: string; action: { name: string; parameters: Record<string, unknown> } } };
    expect(flow.interactive.type).toBe('flow');
    expect(flow.interactive.action.parameters).toMatchObject({ flow_message_version: '3', flow_token: 'tok', flow_id: 'FLOW123', flow_cta: 'Open form', flow_action: 'navigate', flow_action_payload: { screen: 'QUESTION', data: { prompt: 'Q' } } });
    expect(() => buildMetaMessagePayload('923001234567', { type: 'flow', body: 'Q', cta: 'Open', purpose: 'MULTI_CHOICE', flowToken: 'tok', screen: 'QUESTION', assetVersion: 'v', data: {} })).toThrow('FLOW_NOT_READY');
    const template = buildMetaMessagePayload('923001234567', {
      type: 'template',
      name: 'raaye_survey_invitation',
      language: 'en',
      category: 'UTILITY',
      components: [
        { type: 'body', parameters: [{ type: 'text', text: 'PILAP' }, { type: 'text', text: 'Transport survey' }] },
        { type: 'button', subType: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'tok' }] },
      ],
      previewText: 'x',
      previewButtons: [],
    }) as { template: { name: string; language: { code: string }; components: unknown[] } };
    expect(template.template.name).toBe('raaye_survey_invitation');
    expect(template.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'PILAP' }, { type: 'text', text: 'Transport survey' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'tok' }] },
    ]);
  });

  it('classifies provider errors into retryable, permanent and unknown outcomes', async () => {
    expect(classifyMetaError(401, JSON.stringify({ error: { code: 190, message: 'Invalid OAuth access token' } }))).toMatchObject({ code: 190, retryable: false });
    expect(classifyMetaError(400, JSON.stringify({ error: { code: 131047, message: 'Re-engagement' } }))).toMatchObject({ retryable: false });
    expect(classifyMetaError(429, JSON.stringify({ error: { code: 130429, message: 'Rate limit hit' } }))).toMatchObject({ retryable: true });
    expect(classifyMetaError(500, 'oops')).toMatchObject({ code: null, retryable: true });

    const calls: { url: string; body: string }[] = [];
    const provider = new MetaMessagingProvider(liveConfig(), {
      fetch: async (url, init) => {
        calls.push({ url, body: init.body ?? '' });
        return { status: 200, text: async () => JSON.stringify({ messages: [{ id: 'wamid.live.1' }] }) };
      },
    });
    const accepted = await provider.send({ connection: { id: 'c', phoneNumberId: '111', graphVersion: 'v24.0', appKey: 'k', accessTokenRef: null }, to: '923001234567', message: { type: 'text', body: 'Hi' }, messageId: 'm1', contactId: 'contact-1', attemptNumber: 1, isTest: false });
    expect(accepted).toEqual({ outcome: 'ACCEPTED', providerMessageId: 'wamid.live.1' });
    expect(calls[0].url).toBe('https://graph.facebook.com/v24.0/111/messages');
    expect(calls[0].body).toContain('923001234567');

    const failing = new MetaMessagingProvider(liveConfig(), { fetch: async () => ({ status: 400, text: async () => JSON.stringify({ error: { code: 131026, message: 'Receiver incapable' } }) }) });
    expect(await failing.send({ connection: { id: 'c', phoneNumberId: '111', graphVersion: null, appKey: 'k', accessTokenRef: null }, to: '1', message: { type: 'text', body: 'Hi' }, messageId: 'm2', contactId: 'contact-1', attemptNumber: 1, isTest: false })).toMatchObject({ outcome: 'FAILED', errorCode: 'META_131026', retryable: false });

    const timingOut = new MetaMessagingProvider(liveConfig(), { fetch: () => new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 5)) }, 1);
    expect(await timingOut.send({ connection: { id: 'c', phoneNumberId: '111', graphVersion: null, appKey: 'k', accessTokenRef: null }, to: '1', message: { type: 'text', body: 'Hi' }, messageId: 'm3', contactId: 'contact-1', attemptNumber: 1, isTest: false })).toMatchObject({ outcome: 'UNKNOWN', errorCode: 'TIMEOUT' });

    const refused = new MetaMessagingProvider(liveConfig(), { fetch: async () => { throw new Error('connect ECONNREFUSED'); } });
    expect(await refused.send({ connection: { id: 'c', phoneNumberId: '111', graphVersion: null, appKey: 'k', accessTokenRef: null }, to: '1', message: { type: 'text', body: 'Hi' }, messageId: 'm4', contactId: 'contact-1', attemptNumber: 1, isTest: false })).toMatchObject({ outcome: 'FAILED', errorCode: 'NETWORK', retryable: true });
  });

  it('authenticates each send with the sender connection\'s own token reference', async () => {
    process.env['TENANT_A_WA_TOKEN'] = 'tenant-a-token';
    const seen: string[] = [];
    const provider = new MetaMessagingProvider(liveConfig(), { fetch: async (_url, init) => { seen.push(init.headers['Authorization']); return { status: 200, text: async () => JSON.stringify({ messages: [{ id: 'wamid.t' }] }) }; } });
    const base = { to: '1', message: { type: 'text' as const, body: 'Hi' }, messageId: 'm6', contactId: 'contact-1', attemptNumber: 1, isTest: false };
    expect(await provider.send({ ...base, connection: { id: 'c', phoneNumberId: '111', graphVersion: null, appKey: 'k', accessTokenRef: 'TENANT_A_WA_TOKEN' } })).toMatchObject({ outcome: 'ACCEPTED' });
    expect(seen).toEqual(['Bearer tenant-a-token']);
    expect(await provider.send({ ...base, connection: { id: 'c', phoneNumberId: '111', graphVersion: null, appKey: 'k', accessTokenRef: null } })).toMatchObject({ outcome: 'ACCEPTED' });
    expect(seen[1]).toBe('Bearer EAAtesttoken');
    const unresolved = await provider.send({ ...base, connection: { id: 'c', phoneNumberId: '111', graphVersion: null, appKey: 'k', accessTokenRef: 'MISSING_TENANT_TOKEN' } });
    expect(unresolved).toMatchObject({ outcome: 'FAILED', errorCode: 'ACCESS_TOKEN_MISSING', retryable: false });
    expect(seen).toHaveLength(2);
    delete process.env['TENANT_A_WA_TOKEN'];
  });

  it('treats a connection reset after the request was attempted as an ambiguous send (R43)', async () => {
    const request = { connection: { id: 'c', phoneNumberId: '111', graphVersion: null, appKey: 'k', accessTokenRef: null }, to: '1', message: { type: 'text' as const, body: 'Hi' }, messageId: 'm5', contactId: 'contact-1', attemptNumber: 1, isTest: false };
    for (const detail of ['fetch failed: read ECONNRESET', 'socket hang up', 'write EPIPE', 'other side closed']) {
      const reset = new MetaMessagingProvider(liveConfig(), { fetch: async () => { throw new Error(detail); } });
      expect(await reset.send(request)).toMatchObject({ outcome: 'UNKNOWN', errorCode: 'NETWORK_AFTER_SEND' });
    }
    for (const detail of ['getaddrinfo ENOTFOUND graph.facebook.com', 'getaddrinfo EAI_AGAIN graph.facebook.com', 'unable to verify the first certificate']) {
      const unreachable = new MetaMessagingProvider(liveConfig(), { fetch: async () => { throw new Error(detail); } });
      expect(await unreachable.send(request)).toMatchObject({ outcome: 'FAILED', errorCode: 'NETWORK', retryable: true });
    }
  });
});

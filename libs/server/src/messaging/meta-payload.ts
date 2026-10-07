import type { RenderedMessage } from './rendered';

/**
 * Pure builders from the provider-neutral message to the WhatsApp Cloud API
 * `/{PHONE_NUMBER_ID}/messages` payload. Verified by contract tests. The Graph version
 * is pinned in configuration (see docs/WHATSAPP_SETUP.md).
 */
export function buildMetaMessagePayload(to: string, message: RenderedMessage, flowId?: string): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  switch (message.type) {
    case 'text':
      return { ...base, type: 'text', text: { preview_url: Boolean(message.previewUrl), body: message.body } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
          body: { text: message.body },
          ...(message.footer ? { footer: { text: message.footer } } : {}),
          action: { buttons: message.buttons.map((button) => ({ type: 'reply', reply: { id: button.id, title: button.title } })) },
        },
      };
    case 'list':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
          body: { text: message.body },
          ...(message.footer ? { footer: { text: message.footer } } : {}),
          action: {
            button: message.buttonText,
            sections: message.sections.map((section) => ({
              ...(section.title ? { title: section.title } : {}),
              rows: section.rows.map((row) => ({ id: row.id, title: row.title, ...(row.description ? { description: row.description } : {}) })),
            })),
          },
        },
      };
    case 'flow':
      if (!flowId) throw new Error('FLOW_NOT_READY');
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'flow',
          ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
          body: { text: message.body },
          ...(message.footer ? { footer: { text: message.footer } } : {}),
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3',
              flow_token: message.flowToken,
              flow_id: flowId,
              flow_cta: message.cta,
              flow_action: 'navigate',
              flow_action_payload: { screen: message.screen, data: message.data },
            },
          },
        },
      };
    case 'template':
      return {
        ...base,
        type: 'template',
        template: {
          name: message.name,
          language: { code: message.language },
          components: message.components.map((component) =>
            component.type === 'button'
              ? { type: 'button', sub_type: component.subType ?? 'quick_reply', index: String(component.index ?? 0), parameters: component.parameters.map((p) => ({ type: 'payload', payload: p.payload })) }
              : { type: 'body', parameters: component.parameters.map((p) => ({ type: 'text', text: p.text })) },
          ),
        },
      };
  }
}

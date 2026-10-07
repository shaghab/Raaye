import type { FlowPurpose } from '@raaye/contracts';

export interface RenderedButton {
  id: string;
  title: string;
}

export interface RenderedListRow {
  id: string;
  title: string;
  description?: string;
}

export interface RenderedTemplateComponent {
  type: 'body' | 'button';
  parameters: { type: 'text' | 'payload'; text?: string; payload?: string }[];
  subType?: 'quick_reply';
  index?: number;
}

/** Provider-neutral outbound message. Adapters translate this into provider payloads. */
export type RenderedMessage =
  | { type: 'text'; body: string; previewUrl?: boolean }
  | { type: 'buttons'; body: string; header?: string; footer?: string; buttons: RenderedButton[] }
  | { type: 'list'; body: string; header?: string; footer?: string; buttonText: string; sections: { title?: string; rows: RenderedListRow[] }[] }
  | {
      type: 'flow';
      body: string;
      header?: string;
      footer?: string;
      cta: string;
      purpose: FlowPurpose;
      flowToken: string;
      screen: string;
      data: Record<string, unknown>;
      assetVersion: string;
    }
  | {
      type: 'template';
      name: string;
      language: string;
      category: string | null;
      components: RenderedTemplateComponent[];
      /** Human-readable rendering for previews and the simulator. */
      previewText: string;
      previewButtons: RenderedButton[];
    };

/** True when the message is free-form (requires an open customer service window). */
export function isFreeForm(message: RenderedMessage): boolean {
  return message.type !== 'template';
}

/** Plain-text summary used by the simulator, previews and diagnostics. */
export function summarize(message: RenderedMessage): string {
  switch (message.type) {
    case 'text':
      return message.body;
    case 'buttons':
      return [message.header, message.body, message.footer].filter(Boolean).join('\n');
    case 'list':
      return [message.header, message.body, message.footer].filter(Boolean).join('\n');
    case 'flow':
      return [message.header, message.body, message.footer].filter(Boolean).join('\n');
    case 'template':
      return message.previewText;
  }
}

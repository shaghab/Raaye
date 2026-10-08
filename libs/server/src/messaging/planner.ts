import { Injectable } from '@nestjs/common';
import { LIMITS, WHATSAPP_LIMITS, pickLocale, type LocalizedText, type Renderer } from '@raaye/contracts';
import { copy, describeSeconds, fullLabel, truncate, visibleLabel, type OrgCopyContext } from '@raaye/domain';
import type { ActionMode, Question, QuestionOption, TemplateBinding } from '../persistence/prisma.service';
import type { TenantTx } from '../persistence/tenant-db';
import { ActionBindingService, type MintInput } from './action-bindings';
import { flowAssetVersion, loadFlowAsset } from './flow-assets';
import type { RenderedMessage } from './rendered';

export interface PlannerContact {
  id: string;
  connectionId: string;
}

export interface QuestionWithOptions extends Question {
  options: QuestionOption[];
}

export interface QuestionPlanInput {
  organizationId: string;
  contact: PlannerContact;
  mode: ActionMode;
  runId: string;
  participationId: string;
  question: QuestionWithOptions;
  position: number;
  total: number;
  locale: string;
  expiresAt: Date;
  /** Current selection for edits; the control preselects it. */
  currentOptionIds: string[];
  prefix: string;
  isEdit: boolean;
}

/** Template names the adapter uses until an organization binds its own approved names. */
export const DEFAULT_TEMPLATE_NAMES = { SURVEY_INVITATION: 'raaye_survey_invitation', RESULTS_AVAILABLE: 'raaye_results_available' } as const;

/**
 * Builds provider-neutral messages for every participant interaction and mints the
 * opaque action bindings they reference. The same planner serves live and mock sends and
 * the preview/simulator paths.
 */
@Injectable()
export class MessagePlanner {
  constructor(private readonly bindings: ActionBindingService) {}

  /** Mint a binding, or return a placeholder when rendering a preview (tx null). */
  private async mint(tx: TenantTx | null, input: MintInput): Promise<{ id: string; token: string }> {
    if (!tx) return { id: 'preview', token: 'preview-token' };
    return this.bindings.mint(tx, input);
  }

  org(org: { name: string; supportContact: string | null; privacyUrl: string | null }): OrgCopyContext {
    return { organizationName: org.name, supportContact: org.supportContact, privacyUrl: org.privacyUrl };
  }

  async invitation(
    tx: TenantTx | null,
    input: {
      organizationId: string;
      contact: PlannerContact;
      mode: ActionMode;
      runId: string;
      org: OrgCopyContext;
      surveyTitle: string;
      template: TemplateBinding | null;
      expiresAt: Date;
      isTest: boolean;
    },
  ): Promise<{ rendered: RenderedMessage; bindingId: string }> {
    const binding = await this.mint(tx, {
      organizationId: input.organizationId,
      connectionId: input.contact.connectionId,
      contactId: input.contact.id,
      purpose: 'START_SURVEY',
      mode: input.mode,
      runId: input.runId,
      expiresAt: input.expiresAt,
    });
    const prefix = input.isTest ? `${copy.testLabel} ` : '';
    const body = `${prefix}${copy.invitation(input.org, input.surveyTitle)}`;
    const rendered: RenderedMessage = {
      type: 'template',
      name: input.template?.providerName ?? DEFAULT_TEMPLATE_NAMES.SURVEY_INVITATION,
      language: input.template?.locale ?? 'en',
      category: input.template?.category ?? 'UTILITY',
      components: [
        { type: 'body', parameters: [{ type: 'text', text: input.org.organizationName }, { type: 'text', text: input.surveyTitle }] },
        { type: 'button', subType: 'quick_reply', index: input.template?.buttonPosition ?? 0, parameters: [{ type: 'payload', payload: binding.token }] },
      ],
      previewText: body,
      previewButtons: [{ id: binding.token, title: copy.invitationButton }],
    };
    return { rendered, bindingId: binding.id };
  }

  introduction(org: OrgCopyContext, title: LocalizedText, introduction: LocalizedText, questionCount: number, editWindowSeconds: number, locale: string, prefix: string): RenderedMessage {
    return { type: 'text', body: truncate(`${prefix}${copy.introduction(org, title, introduction, questionCount, editWindowSeconds, locale)}`, WHATSAPP_LIMITS.textMessage.chars) };
  }

  async profileOffer(tx: TenantTx | null, input: { organizationId: string; contact: PlannerContact; mode: ActionMode; participationId: string | null; org: OrgCopyContext; expiresAt: Date; prefix: string }): Promise<RenderedMessage> {
    const accept = await this.mint(tx, { organizationId: input.organizationId, connectionId: input.contact.connectionId, contactId: input.contact.id, purpose: 'PROFILE_OFFER_ACCEPT', mode: input.mode, participationId: input.participationId, expiresAt: input.expiresAt });
    const skip = await this.mint(tx, { organizationId: input.organizationId, connectionId: input.contact.connectionId, contactId: input.contact.id, purpose: 'PROFILE_OFFER_SKIP', mode: input.mode, participationId: input.participationId, expiresAt: input.expiresAt });
    return {
      type: 'buttons',
      body: `${input.prefix}${copy.profileOffer(input.org)}`,
      buttons: [
        { id: accept.token, title: copy.profileOfferAccept },
        { id: skip.token, title: copy.profileOfferSkip },
      ],
    };
  }

  async profileFlow(
    tx: TenantTx | null,
    input: { organizationId: string; contact: PlannerContact; mode: ActionMode; participationId: string | null; expiresAt: Date; prefix: string; current: Record<string, string | null> },
  ): Promise<RenderedMessage> {
    const binding = await this.mint(tx, { organizationId: input.organizationId, connectionId: input.contact.connectionId, contactId: input.contact.id, purpose: 'PROFILE_FLOW', mode: input.mode, participationId: input.participationId, expiresAt: input.expiresAt });
    const asset = loadFlowAsset('PROFILE');
    const example = (asset.json['screens'] as { data: Record<string, { __example__: unknown }> }[])[0].data;
    return {
      type: 'flow',
      body: `${input.prefix}Share any details you are comfortable with. Every field is optional.`,
      cta: 'Add details',
      purpose: 'PROFILE',
      flowToken: binding.token,
      screen: asset.screen,
      assetVersion: flowAssetVersion('PROFILE'),
      data: {
        intro: 'Every field is optional. Leave anything blank.',
        action_token: binding.token,
        city: input.current['city'] ?? '',
        district: input.current['district'] ?? '',
        occupation: input.current['occupation'] ?? '',
        gender: input.current['gender'] ?? '',
        age_band: input.current['ageBand'] ?? '',
        membership: input.current['membership'] ?? '',
        genders: example['genders'].__example__,
        age_bands: example['age_bands'].__example__,
        memberships: example['memberships'].__example__,
      },
    };
  }

  /** Render one question with bound controls according to the frozen renderer plan. */
  async question(tx: TenantTx | null, input: QuestionPlanInput): Promise<{ rendered: RenderedMessage; renderer: Renderer }> {
    const renderer = (input.question.renderer as Renderer | null) ?? 'LIST';
    const options = [...input.question.options].sort((a, b) => a.position - b.position);
    const header = copy.questionHeader(input.position, input.total);
    const promptText = pickLocale(input.question.prompt as LocalizedText, input.locale);
    const instruction = copy.instruction(renderer);
    const lead = input.isEdit ? '' : input.position > 1 ? `${copy.recorded} ` : '';
    const body = truncate(`${input.prefix}${lead}${header}\n\n${promptText}\n\n${instruction}`, WHATSAPP_LIMITS.body.chars);
    const purpose = renderer === 'FLOW_MULTI' || renderer === 'FLOW_SINGLE' ? 'QUESTION_FLOW' : 'ANSWER_OPTION';
    const binding = await this.mint(tx, {
      organizationId: input.organizationId,
      connectionId: input.contact.connectionId,
      contactId: input.contact.id,
      purpose,
      mode: input.mode,
      runId: input.runId,
      participationId: input.participationId,
      questionId: input.question.id,
      expiresAt: input.expiresAt,
    });
    if (renderer === 'BUTTONS') {
      return {
        renderer,
        rendered: {
          type: 'buttons',
          body,
          buttons: options.map((option) => ({ id: this.bindings.controlId(binding.token, option.id), title: truncate(visibleLabel(labelOf(option), input.locale), WHATSAPP_LIMITS.replyButtons.titleChars) })),
        },
      };
    }
    if (renderer === 'LIST') {
      const rows = options.map((option) => {
        const visible = visibleLabel(labelOf(option), input.locale);
        const full = fullLabel(labelOf(option), input.locale);
        let title = truncate(visible, WHATSAPP_LIMITS.list.rowTitleChars);
        let description: string | undefined = full !== visible ? truncate(full, WHATSAPP_LIMITS.list.rowDescriptionChars) : undefined;
        if (input.question.type === 'RATING') {
          const endpoint = option.ratingValue === 1 ? pickLocale(input.question.ratingMinLabel as LocalizedText | null, input.locale) : option.ratingValue === 5 ? pickLocale(input.question.ratingMaxLabel as LocalizedText | null, input.locale) : '';
          title = String(option.ratingValue ?? visible);
          if (endpoint) {
            const combined = `${title} - ${endpoint}`;
            if (combined.length <= WHATSAPP_LIMITS.list.rowTitleChars) title = combined;
            else description = truncate(endpoint, WHATSAPP_LIMITS.list.rowDescriptionChars);
          }
        }
        return { id: this.bindings.controlId(binding.token, option.id), title, description };
      });
      return { renderer, rendered: { type: 'list', body, buttonText: copy.listButton, sections: [{ rows }] } };
    }
    const flowPurpose = renderer === 'FLOW_MULTI' ? 'MULTI_CHOICE' : 'SINGLE_CHOICE';
    const asset = loadFlowAsset(flowPurpose);
    const items = options.map((option) => {
      const visible = visibleLabel(labelOf(option), input.locale);
      const full = fullLabel(labelOf(option), input.locale);
      return { id: option.id, title: truncate(visible, WHATSAPP_LIMITS.flowItem.titleChars), description: full !== visible ? truncate(full, WHATSAPP_LIMITS.flowItem.descriptionChars) : '' };
    });
    const min = input.question.minSelections ?? 1;
    const max = input.question.maxSelections ?? options.length;
    const data: Record<string, unknown> =
      flowPurpose === 'MULTI_CHOICE'
        ? { prompt: promptText, options: items, initial: input.currentOptionIds, min, max, instruction: `Select between ${min} and ${max} option${max === 1 ? '' : 's'}`, action_token: binding.token, progress: header }
        : { prompt: promptText, options: items, initial: input.currentOptionIds[0] ?? '', action_token: binding.token, progress: header };
    return {
      renderer,
      rendered: { type: 'flow', body, cta: copy.flowButton, purpose: flowPurpose, flowToken: binding.token, screen: asset.screen, assetVersion: flowAssetVersion(flowPurpose), data },
    };
  }

  completion(editWindowSeconds: number, prefix: string): RenderedMessage {
    const hint = copy.completionEditHint(editWindowSeconds);
    return { type: 'text', body: `${prefix}${copy.completion}${hint ? ` ${hint}` : ''}` };
  }

  text(body: string): RenderedMessage {
    return { type: 'text', body: truncate(body, WHATSAPP_LIMITS.textMessage.chars) };
  }

  async menu(
    tx: TenantTx | null,
    input: { organizationId: string; contact: PlannerContact; mode: ActionMode; body: string; buttonText: string; items: { label: string; description?: string; purpose: 'MENU_SELECT' | 'CONTINUE_SURVEY' | 'SWITCH_SURVEY' | 'EDIT_QUESTION' | 'VIEW_RESULTS' | 'START_SURVEY'; runId?: string | null; participationId?: string | null; questionId?: string | null; snapshotId?: string | null; payload?: Record<string, unknown> }[]; expiresAt: Date; page?: number; pageSize?: number },
  ): Promise<RenderedMessage> {
    const pageSize = input.pageSize ?? LIMITS.menuPageSize;
    const page = input.page ?? 0;
    const slice = input.items.slice(page * pageSize, page * pageSize + pageSize);
    const rows = [] as { id: string; title: string; description?: string }[];
    for (const item of slice) {
      const binding = await this.mint(tx, { organizationId: input.organizationId, connectionId: input.contact.connectionId, contactId: input.contact.id, purpose: item.purpose, mode: input.mode, runId: item.runId ?? null, participationId: item.participationId ?? null, questionId: item.questionId ?? null, snapshotId: item.snapshotId ?? null, payload: item.payload ?? null, expiresAt: input.expiresAt });
      rows.push({ id: binding.token, title: truncate(item.label, WHATSAPP_LIMITS.list.rowTitleChars), description: item.description ? truncate(item.description, WHATSAPP_LIMITS.list.rowDescriptionChars) : undefined });
    }
    if (input.items.length > (page + 1) * pageSize) {
      // A results menu's page control is itself about shared results: withdrawals and the permission
      // recheck before the next page recognize it by this flag.
      const results = input.items.every((item) => item.purpose === 'VIEW_RESULTS');
      const next = await this.mint(tx, { organizationId: input.organizationId, connectionId: input.contact.connectionId, contactId: input.contact.id, purpose: 'MENU_SELECT', mode: input.mode, payload: { menu: 'next', page: page + 1, items: input.items, ...(results ? { results: true } : {}) }, expiresAt: input.expiresAt });
      rows.push({ id: next.token, title: copy.pageNext });
    }
    if (rows.length <= WHATSAPP_LIMITS.replyButtons.max && rows.every((row) => row.title.length <= WHATSAPP_LIMITS.replyButtons.titleChars && !row.description)) {
      return { type: 'buttons', body: input.body, buttons: rows.map((row) => ({ id: row.id, title: row.title })) };
    }
    return { type: 'list', body: input.body, buttonText: input.buttonText, sections: [{ rows }] };
  }

  async resultsInvitation(tx: TenantTx | null, input: { organizationId: string; contact: PlannerContact; snapshotId: string; org: OrgCopyContext; surveyTitle: string; template: TemplateBinding | null; useTemplate: boolean; expiresAt: Date }): Promise<RenderedMessage> {
    const binding = await this.mint(tx, { organizationId: input.organizationId, connectionId: input.contact.connectionId, contactId: input.contact.id, purpose: 'VIEW_RESULTS', mode: 'LIVE', snapshotId: input.snapshotId, expiresAt: input.expiresAt });
    const body = copy.resultsAvailable(input.org, input.surveyTitle);
    if (input.useTemplate) {
      return {
        type: 'template',
        name: input.template?.providerName ?? DEFAULT_TEMPLATE_NAMES.RESULTS_AVAILABLE,
        language: input.template?.locale ?? 'en',
        category: input.template?.category ?? 'UTILITY',
        components: [
          { type: 'body', parameters: [{ type: 'text', text: input.org.organizationName }, { type: 'text', text: input.surveyTitle }] },
          { type: 'button', subType: 'quick_reply', index: input.template?.buttonPosition ?? 0, parameters: [{ type: 'payload', payload: binding.token }] },
        ],
        previewText: body,
        previewButtons: [{ id: binding.token, title: copy.resultsButton }],
      };
    }
    return { type: 'buttons', body, buttons: [{ id: binding.token, title: copy.resultsButton }] };
  }

  editWindowText(seconds: number): string {
    return describeSeconds(seconds);
  }
}

function labelOf(option: QuestionOption): { label: LocalizedText; shortLabel: LocalizedText | null } {
  return { label: option.label as LocalizedText, shortLabel: (option.shortLabel as LocalizedText | null) ?? null };
}

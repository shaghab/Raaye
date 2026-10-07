import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { SimulatorConversationMessageDto, SimulatorStateDto } from '@raaye/contracts';
import { e164ToWaId, normalizePhone, type Clock } from '@raaye/domain';
import { AppClock, CLOCK } from '../clock/clock.service';
import type { TenantContext } from '../common/context';
import { DomainError, notFound } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { InboxService } from '../conversation/inbox.service';
import { JobRunner } from '../jobs/job-runner';
import { SweepService } from '../jobs/sweep.service';
import { MessagingReadinessService } from '../messaging/readiness.service';
import type { RenderedMessage } from '../messaging/rendered';
import { summarize } from '../messaging/rendered';
import type { NormalizedInbound, NormalizedStatus } from '../messaging/webhook-parser';
import { asJson } from '../persistence/json';
import { PrismaService } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';

/**
 * Development-only participant simulator. It emits normalized inbound events through the
 * same durable ingress and domain pipeline as live webhooks; it never writes answers.
 * Unavailable unless ENABLE_SIMULATOR=true in a non-live, non-production configuration.
 */
@Injectable()
export class SimulatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dbFactory: TenantDbFactory,
    private readonly inbox: InboxService,
    private readonly readiness: MessagingReadinessService,
    private readonly runner: JobRunner,
    private readonly sweep: SweepService,
    private readonly appClock: AppClock,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  assertEnabled(): void {
    if (!this.config.simulatorEnabled) throw new DomainError('SIMULATOR_DISABLED', 'The simulator is not available in this configuration');
  }

  async state(ctx: TenantContext): Promise<SimulatorStateDto> {
    this.assertEnabled();
    const row = await this.prisma.simulatorState.findUnique({ where: { id: 1 } });
    const connection = await this.readiness.connection(ctx);
    return { enabled: true, now: this.clock.now().toISOString(), clockOffsetSeconds: row?.clockOffsetSeconds ?? 0, faults: (row?.faults as Record<string, unknown>) ?? {}, connectionAppKey: connection?.appKey ?? '' };
  }

  async setClock(ctx: TenantContext, input: { advanceSeconds?: number; reset?: boolean }): Promise<SimulatorStateDto> {
    this.assertEnabled();
    const row = await this.prisma.simulatorState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const offset = input.reset ? 0 : row.clockOffsetSeconds + (input.advanceSeconds ?? 0);
    await this.prisma.simulatorState.update({ where: { id: 1 }, data: { clockOffsetSeconds: offset } });
    await this.appClock.refresh();
    return this.state(ctx);
  }

  async setFaults(ctx: TenantContext, faults: Record<string, unknown>): Promise<SimulatorStateDto> {
    this.assertEnabled();
    const row = await this.prisma.simulatorState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const merged: Record<string, unknown> = { ...((row.faults as Record<string, unknown>) ?? {}) };
    for (const [key, value] of Object.entries(faults)) {
      if (value === null || value === undefined) delete merged[key];
      else merged[key] = value;
    }
    await this.prisma.simulatorState.update({ where: { id: 1 }, data: { faults: asJson(merged) } });
    if (typeof merged['expireServiceWindowForContactId'] === 'string') {
      await this.dbFactory.for(ctx).conversation.updateMany({ where: { contactId: merged['expireServiceWindowForContactId'] }, data: { lastInboundAt: new Date(this.clock.now().getTime() - 25 * 3600_000) } });
    }
    return this.state(ctx);
  }

  /** Process every due job inline so simulator interactions resolve immediately. */
  async drain(ctx: TenantContext, rounds = 10): Promise<{ processed: number }> {
    this.assertEnabled();
    void ctx;
    await this.sweep.run();
    let processed = 0;
    for (let i = 0; i < rounds; i += 1) {
      const count = await this.runner.runOnce(50, 4);
      processed += count;
      if (count === 0) break;
    }
    return { processed };
  }

  async conversation(ctx: TenantContext, contactId: string): Promise<SimulatorConversationMessageDto[]> {
    this.assertEnabled();
    const db = this.dbFactory.for(ctx);
    const contact = await db.contact.findUnique({ where: { id: contactId } });
    if (!contact) throw notFound('Contact');
    const [messages, inbound] = await Promise.all([
      db.message.findMany({ where: { contactId }, include: { statusEvents: true }, orderBy: { createdAt: 'asc' }, take: 300 }),
      db.inboundEvent.findMany({ where: { senderIdentity: e164ToWaId(contact.phoneE164) }, orderBy: { receivedAt: 'asc' }, take: 300 }),
    ]);
    const outbound: SimulatorConversationMessageDto[] = messages.map((message) => {
      const rendered = message.rendered as RenderedMessage;
      return {
        id: message.id,
        direction: 'OUTBOUND',
        kind: message.kind,
        state: message.state,
        deliveryState: message.deliveryState,
        isTest: message.isTest,
        createdAt: message.createdAt.toISOString(),
        text: summarize(rendered),
        controls: controlsOf(rendered),
        flow: rendered.type === 'flow' ? flowOf(rendered) : null,
        providerMessageId: message.providerMessageId,
        templateName: rendered.type === 'template' ? rendered.name : null,
        suppressionReason: message.suppressionReason,
        errorCode: message.lastErrorCode,
      };
    });
    const inboundDtos: SimulatorConversationMessageDto[] = inbound.map((event) => {
      const normalized = event.normalized as { kind: string; text: string | null; actionId: string | null; flowResponse: Record<string, unknown> | null };
      return {
        id: event.id,
        direction: 'INBOUND',
        kind: normalized.kind,
        state: event.processingState,
        deliveryState: null,
        isTest: false,
        createdAt: event.receivedAt.toISOString(),
        text: normalized.text ?? (normalized.flowResponse ? `Form submitted: ${JSON.stringify(normalized.flowResponse)}` : normalized.actionId ? `Tapped: ${normalized.actionId.slice(0, 12)}…` : `[${normalized.kind}]`),
        controls: [],
        flow: null,
        providerMessageId: event.providerMessageId,
        templateName: null,
        suppressionReason: null,
        errorCode: event.outcomeCode,
      };
    });
    return [...outbound, ...inboundDtos].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.direction === 'INBOUND' ? -1 : 1));
  }

  async sendText(ctx: TenantContext, input: { contactId?: string; phone?: string; profileName?: string; text: string; providerMessageId?: string; providerAtOffsetSeconds?: number }): Promise<{ eventId: string | null; duplicate: boolean }> {
    this.assertEnabled();
    const sender = await this.senderFor(ctx, input.contactId, input.phone);
    return this.emit(ctx, { ...sender, kind: 'TEXT', text: input.text, actionId: null, flowResponse: null, profileName: input.profileName ?? null }, input.providerMessageId, input.providerAtOffsetSeconds);
  }

  async tap(ctx: TenantContext, input: { contactId: string; messageId: string; controlId: string; providerMessageId?: string; providerAtOffsetSeconds?: number }): Promise<{ eventId: string | null; duplicate: boolean }> {
    this.assertEnabled();
    const db = this.dbFactory.for(ctx);
    const message = await db.message.findUnique({ where: { id: input.messageId } });
    if (!message) throw notFound('Message');
    const rendered = message.rendered as RenderedMessage;
    const kind = rendered.type === 'template' ? 'TEMPLATE_BUTTON' : rendered.type === 'list' ? 'LIST_REPLY' : 'BUTTON_REPLY';
    const sender = await this.senderFor(ctx, input.contactId, undefined);
    return this.emit(ctx, { ...sender, kind, text: null, actionId: input.controlId, flowResponse: null, profileName: null, contextMessageId: message.providerMessageId }, input.providerMessageId, input.providerAtOffsetSeconds);
  }

  async submitFlow(ctx: TenantContext, input: { contactId: string; messageId: string; flowToken: string; selectedOptionIds?: string[]; profile?: Record<string, string | undefined>; overrideSenderContactId?: string; providerMessageId?: string; providerAtOffsetSeconds?: number }): Promise<{ eventId: string | null; duplicate: boolean }> {
    this.assertEnabled();
    const db = this.dbFactory.for(ctx);
    const message = await db.message.findUnique({ where: { id: input.messageId } });
    if (!message) throw notFound('Message');
    const rendered = message.rendered as RenderedMessage;
    const response: Record<string, unknown> = { flow_token: input.flowToken, action_token: input.flowToken };
    if (rendered.type === 'flow' && rendered.purpose === 'PROFILE') {
      for (const [key, value] of Object.entries({ city: input.profile?.['city'], district: input.profile?.['district'], gender: input.profile?.['gender'], age_band: input.profile?.['ageBand'], occupation: input.profile?.['occupation'], membership: input.profile?.['membership'] })) response[key] = value ?? '';
    } else if (rendered.type === 'flow' && rendered.purpose === 'MULTI_CHOICE') {
      response['selected'] = input.selectedOptionIds ?? [];
    } else {
      response['selection'] = input.selectedOptionIds?.[0] ?? '';
    }
    const sender = await this.senderFor(ctx, input.overrideSenderContactId ?? input.contactId, undefined);
    return this.emit(ctx, { ...sender, kind: 'FLOW_REPLY', text: null, actionId: null, flowResponse: response, profileName: null, contextMessageId: message.providerMessageId }, input.providerMessageId, input.providerAtOffsetSeconds);
  }

  async status(ctx: TenantContext, input: { messageId: string; status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'; providerAtOffsetSeconds?: number; errorCode?: string; duplicate?: boolean }): Promise<{ results: string[] }> {
    this.assertEnabled();
    const db = this.dbFactory.for(ctx);
    const message = await db.message.findUnique({ where: { id: input.messageId }, include: { connection: true } });
    if (!message) throw notFound('Message');
    if (!message.providerMessageId) throw new DomainError('VALIDATION_FAILED', 'The message has no provider id yet (not accepted)');
    const status: NormalizedStatus = {
      phoneNumberId: message.connection.phoneNumberId ?? '',
      providerMessageId: message.providerMessageId,
      recipientIdentity: null,
      status: input.status,
      providerAt: new Date(this.clock.now().getTime() + (input.providerAtOffsetSeconds ?? 0) * 1000),
      errorCode: input.errorCode ?? null,
      errorTitle: input.errorCode ? 'Simulated provider failure' : null,
    };
    const results: string[] = [];
    const repeats = input.duplicate ? 2 : 1;
    for (let i = 0; i < repeats; i += 1) {
      const result = await this.inbox.ingest([], [status], { appKey: message.connection.appKey, simulated: true, connectionOverride: message.connection });
      results.push(result.statuses > 0 ? 'RECORDED' : 'IGNORED');
    }
    return { results };
  }

  private async senderFor(ctx: TenantContext, contactId: string | undefined, phone: string | undefined): Promise<{ senderIdentity: string }> {
    const db = this.dbFactory.for(ctx);
    if (contactId) {
      const contact = await db.contact.findUnique({ where: { id: contactId } });
      if (!contact) throw notFound('Contact');
      return { senderIdentity: e164ToWaId(contact.phoneE164) };
    }
    const parsed = normalizePhone(phone ?? '', 'PK');
    if (!parsed.ok) throw new DomainError('PHONE_INVALID', 'Provide a valid phone number for the unknown sender');
    return { senderIdentity: parsed.waId };
  }

  private async emit(ctx: TenantContext, input: { senderIdentity: string; kind: NormalizedInbound['kind']; text: string | null; actionId: string | null; flowResponse: Record<string, unknown> | null; profileName: string | null; contextMessageId?: string | null }, providerMessageId?: string, offsetSeconds?: number): Promise<{ eventId: string | null; duplicate: boolean }> {
    const connection = await this.readiness.connection(ctx);
    if (!connection) throw notFound('Messaging connection');
    // The live webhook only resolves enabled senders; the simulator refuses the same traffic.
    if (!connection.enabled) throw new DomainError('CONNECTION_DISABLED', 'The messaging connection is disabled; enable it in Settings before simulating inbound messages');
    const id = providerMessageId ?? `wamid.sim.${randomUUID()}`;
    const inbound: NormalizedInbound = {
      phoneNumberId: connection.phoneNumberId ?? '',
      displayPhoneNumber: connection.displayPhoneNumber,
      providerMessageId: id,
      senderIdentity: input.senderIdentity,
      senderProfileName: input.profileName,
      providerAt: new Date(this.clock.now().getTime() + (offsetSeconds ?? 0) * 1000),
      kind: input.kind,
      text: input.text,
      actionId: input.actionId,
      flowResponse: input.flowResponse,
      contextMessageId: input.contextMessageId ?? null,
      rawType: input.kind.toLowerCase(),
    };
    const result = await this.inbox.ingest([inbound], [], { appKey: connection.appKey, simulated: true, connectionOverride: connection });
    if (result.duplicates > 0) return { eventId: null, duplicate: true };
    const event = await this.dbFactory.for(ctx).inboundEvent.findUnique({ where: { organizationId_connectionId_providerMessageId: { organizationId: ctx.organizationId, connectionId: connection.id, providerMessageId: id } }, select: { id: true } });
    return { eventId: event?.id ?? null, duplicate: false };
  }

  /** Local outbox: password reset / verification links issued by the Authentication Emulator. */
  async emulatorOutbox(): Promise<{ email: string; requestType: string; oobLink: string }[]> {
    this.assertEnabled();
    const host = this.config.FIREBASE_AUTH_EMULATOR_HOST;
    if (!host) return [];
    try {
      const response = await fetch(`http://${host}/emulator/v1/projects/${encodeURIComponent(this.config.FIREBASE_PROJECT_ID)}/oobCodes`);
      if (!response.ok) return [];
      const body = (await response.json()) as { oobCodes?: { email: string; requestType: string; oobLink: string }[] };
      return (body.oobCodes ?? []).map((code) => ({ email: code.email, requestType: code.requestType, oobLink: code.oobLink })).reverse();
    } catch {
      return [];
    }
  }
}

function controlsOf(rendered: RenderedMessage): SimulatorConversationMessageDto['controls'] {
  switch (rendered.type) {
    case 'buttons':
      return rendered.buttons.map((button) => ({ id: button.id, label: button.title, type: 'BUTTON' as const }));
    case 'list':
      return rendered.sections.flatMap((section) => section.rows.map((row) => ({ id: row.id, label: row.title, description: row.description, type: 'LIST_ROW' as const })));
    case 'flow':
      return [{ id: rendered.flowToken, label: rendered.cta, type: 'FLOW_CTA' as const }];
    case 'template':
      return rendered.previewButtons.map((button) => ({ id: button.id, label: button.title, type: 'BUTTON' as const }));
    default:
      return [];
  }
}

function flowOf(rendered: Extract<RenderedMessage, { type: 'flow' }>): SimulatorConversationMessageDto['flow'] {
  const data = rendered.data as { options?: { id: string; title: string; description?: string }[]; initial?: string[] | string; min?: number; max?: number; city?: string; district?: string; gender?: string; age_band?: string; occupation?: string; membership?: string };
  if (rendered.purpose === 'PROFILE') {
    return { token: rendered.flowToken, purpose: 'PROFILE', questionId: null, options: [], initialSelectedOptionIds: [], minSelections: null, maxSelections: null, profile: { city: data.city ?? null, district: data.district ?? null, gender: data.gender ?? null, ageBand: data.age_band ?? null, occupation: data.occupation ?? null, membership: data.membership ?? null } };
  }
  const initial = Array.isArray(data.initial) ? data.initial : data.initial ? [data.initial] : [];
  return {
    token: rendered.flowToken,
    purpose: rendered.purpose,
    questionId: null,
    options: (data.options ?? []).map((option) => ({ id: option.id, label: option.description ? `${option.title} — ${option.description}` : option.title, exclusive: false })),
    initialSelectedOptionIds: initial,
    minSelections: data.min ?? null,
    maxSelections: data.max ?? null,
    profile: null,
  };
}

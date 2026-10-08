import { Inject, Injectable } from '@nestjs/common';
import { LIMITS, pickLocale, type AgeBand, type Gender, type LocalizedText, type MembershipKind } from '@raaye/contracts';
import { buildAnalysisProfile, copy, normalizeText, parseCommand, parseConsentReply, waIdToE164, type Clock, type OrgCopyContext } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { SystemContext } from '../common/context';
import { ConsentService } from '../contacts/consent.service';
import type { JobHandler } from '../jobs/job-handler';
import { JOB_PRIORITY, type ClaimedJob } from '../jobs/jobs.service';
import { ActionBindingService } from '../messaging/action-bindings';
import { resultsReplyKey } from '../messaging/dedupe';
import { DeliveryService } from '../messaging/delivery.service';
import { MessagePlanner } from '../messaging/planner';
import type { RenderedMessage } from '../messaging/rendered';
import { getLogger } from '../observability/logger';
import { asJson, asJsonOrNull } from '../persistence/json';
import type { ActionBinding, Contact, Conversation, InboundEvent, MessagingConnection, Organization, Participation, Prisma } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import type { TenantTx } from '../persistence/tenant-db';
import { revisionInclude, type RevisionWithQuestions } from '../surveys/survey-mapper';
import { AnswerService } from './answer.service';
import { ResultsAccessService } from './results-access.service';

interface NormalizedPayload {
  kind: string;
  text: string | null;
  actionId: string | null;
  flowResponse: Record<string, unknown> | null;
}

interface Session {
  tx: TenantTx;
  ctx: SystemContext;
  org: Organization;
  orgCopy: OrgCopyContext;
  connection: MessagingConnection;
  event: InboundEvent;
  payload: NormalizedPayload;
  now: Date;
  contact: Contact | null;
  conversation: Conversation | null;
  replies: number;
}

type ParticipationWithRun = Prisma.ParticipationGetPayload<{ include: { run: true; revision: { include: typeof revisionInclude } } }>;

function isPlaceholder(contact: Contact): boolean {
  const provenance = contact.profileProvenance as { placeholder?: boolean } | null;
  return Boolean(provenance?.placeholder) && contact.archivedAt !== null;
}

const PARTICIPATION_INCLUDE = { run: true, revision: { include: revisionInclude } } as const;
const ENROLLMENT_TTL_HOURS = 48;

/**
 * Participant conversation engine. Every inbound event is processed once, inside one
 * transaction, with explicit action bindings deciding where a reply belongs. STOP has
 * precedence over all other input. Replies are queued as outbound messages that go
 * through the normal delivery gate.
 */
@Injectable()
export class ConversationService implements JobHandler {
  readonly kind = 'PROCESS_INBOUND' as const;
  private readonly logger = getLogger('conversation');

  constructor(
    private readonly dbFactory: TenantDbFactory,
    private readonly planner: MessagePlanner,
    private readonly bindings: ActionBindingService,
    private readonly delivery: DeliveryService,
    private readonly answers: AnswerService,
    private readonly consent: ConsentService,
    private readonly results: ResultsAccessService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async handle(job: ClaimedJob, ctx: SystemContext): Promise<void> {
    if (!job.entityId) return;
    await this.processEvent(ctx, job.entityId);
  }

  async processEvent(ctx: SystemContext, eventId: string): Promise<string> {
    const db = this.dbFactory.for(ctx);
    const event = await db.inboundEvent.findUnique({ where: { id: eventId } });
    if (!event) return 'MISSING';
    if (event.processingState === 'PROCESSED' || event.processingState === 'IGNORED') return event.outcomeCode ?? 'ALREADY_PROCESSED';
    const outcome = await db.$transaction(async (tx) => {
      const [org, connection] = await Promise.all([tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }), tx.messagingConnection.findUniqueOrThrow({ where: { id: event.connectionId } })]);
      const payload = event.normalized as unknown as NormalizedPayload;
      const now = this.clock.now();
      const phone = waIdToE164(event.senderIdentity);
      const found = phone ? await tx.contact.findFirst({ where: { OR: [{ phoneE164: phone }, { providerIdentity: event.senderIdentity }] } }) : null;
      // A placeholder created to answer an unknown sender is not a real contact yet.
      const contact = found && !isPlaceholder(found) ? found : null;
      let conversation: Conversation | null = null;
      const inboundAt = event.providerAt ?? event.receivedAt;
      if (contact) {
        if (!contact.providerIdentity) await tx.contact.update({ where: { id: contact.id }, data: { providerIdentity: event.senderIdentity } });
        conversation = await tx.conversation.upsert({
          where: { organizationId_contactId: { organizationId: ctx.organizationId, contactId: contact.id } },
          create: { organizationId: ctx.organizationId, contactId: contact.id, connectionId: connection.id, lastInboundAt: inboundAt },
          update: { lastInboundAt: inboundAt, connectionId: connection.id },
        });
      }
      const session: Session = { tx, ctx, org, orgCopy: this.planner.org(org), connection, event, payload, now, contact, conversation, replies: 0 };
      const code = await this.dispatch(session);
      await tx.inboundEvent.update({ where: { id: event.id }, data: { processingState: 'PROCESSED', processedAt: now, outcomeCode: code } });
      return code;
    }, { timeout: 30_000 });
    this.logger.debug({ eventId, outcome }, 'Inbound processed');
    return outcome;
  }

  private async dispatch(s: Session): Promise<string> {
    const command = s.payload.kind === 'TEXT' ? parseCommand(s.payload.text) : null;
    if (command?.kind === 'STOP') return this.handleStop(s);
    if (s.payload.kind === 'BUTTON_REPLY' || s.payload.kind === 'LIST_REPLY' || s.payload.kind === 'TEMPLATE_BUTTON') return this.handleAction(s, s.payload.actionId ?? '');
    if (s.payload.kind === 'FLOW_REPLY') return this.handleFlow(s);
    if (s.payload.kind === 'TEXT') return this.handleText(s, command);
    await this.replyText(s, copy.unrecognized, 'unsupported');
    return 'UNSUPPORTED_INPUT';
  }

  // ---- STOP -----------------------------------------------------------------

  private async handleStop(s: Session): Promise<string> {
    if (s.contact) {
      await this.consent.withdrawAll(s.ctx, s.contact.id, 'PARTICIPANT_STOP', s.now, s.event.providerMessageId, s.tx);
      await s.tx.conversation.update({ where: { id: s.conversation?.id ?? '' }, data: { foregroundParticipationId: null, pendingInput: null, pendingContext: undefined } }).catch(() => undefined);
      await this.queue(s, 'OPT_OUT_ACK', this.planner.text(copy.stopAck(s.orgCopy)), `optout-ack:${s.event.id}`, { priority: JOB_PRIORITY.optOut });
      return 'STOPPED';
    }
    await s.tx.enrollment.updateMany({ where: { connectionId: s.connection.id, senderIdentity: s.event.senderIdentity, state: { in: ['AWAITING_NAME', 'AWAITING_CONSENT'] } }, data: { state: 'DECLINED' } });
    await this.queue(s, 'OPT_OUT_ACK', this.planner.text(copy.consentDeclined), `optout-ack:${s.event.id}`, { priority: JOB_PRIORITY.optOut });
    return 'STOPPED_UNKNOWN_SENDER';
  }

  // ---- Text and commands ----------------------------------------------------

  private async handleText(s: Session, command: ReturnType<typeof parseCommand>): Promise<string> {
    if (!s.contact) return this.handleEnrollmentText(s, command);
    const contact = s.contact;
    const needsConsent = contact.consentInvitations !== 'GRANTED';
    if (command?.kind === 'HELP') {
      await this.replyText(s, copy.help(s.orgCopy), 'help');
      return 'HELP';
    }
    if (command?.kind === 'START') {
      if (needsConsent) return this.offerConsent(s);
      return this.showOpenInvitations(s, contact);
    }
    if (s.conversation?.pendingInput === 'CONSENT') {
      const reply = parseConsentReply(s.payload.text);
      if (reply) return this.applyConsentReply(s, reply);
    }
    if (command?.kind === 'RESUME') return this.resume(s, contact);
    if (command?.kind === 'PROFILE') return this.offerProfileFlow(s, contact, null);
    if (command?.kind === 'EDIT') return this.handleEditCommand(s, contact, command.questionNumber);
    if (command?.kind === 'RESULTS') return this.showResults(s, contact);
    if (needsConsent && command === null && !s.conversation?.foregroundParticipationId) {
      // A plain message from an unconsented contact may only start a consent conversation.
      return this.offerConsent(s);
    }
    const foreground = await this.foreground(s);
    await this.replyText(s, copy.unrecognized, 'unrecognized');
    if (foreground && foreground.state !== 'COMPLETED' && foreground.currentQuestionId) await this.sendQuestion(s, foreground, foreground.currentQuestionId, { reason: `resend:${s.event.id}`, isEdit: false });
    return 'UNRECOGNIZED';
  }

  private async handleEnrollmentText(s: Session, command: ReturnType<typeof parseCommand>): Promise<string> {
    const tx = s.tx;
    const existing = await tx.enrollment.findUnique({ where: { organizationId_connectionId_senderIdentity: { organizationId: s.ctx.organizationId, connectionId: s.connection.id, senderIdentity: s.event.senderIdentity } } });
    const active = existing && existing.expiresAt.getTime() > s.now.getTime() && (existing.state === 'AWAITING_NAME' || existing.state === 'AWAITING_CONSENT') ? existing : null;
    if (command?.kind === 'HELP') {
      await this.replyText(s, copy.help(s.orgCopy), 'help');
      return 'HELP';
    }
    if (!active || command?.kind === 'START') {
      await tx.enrollment.upsert({
        where: { organizationId_connectionId_senderIdentity: { organizationId: s.ctx.organizationId, connectionId: s.connection.id, senderIdentity: s.event.senderIdentity } },
        create: { organizationId: s.ctx.organizationId, connectionId: s.connection.id, senderIdentity: s.event.senderIdentity, state: 'AWAITING_NAME', profileDisplayName: s.event.senderProfileName, noticeVersion: s.org.participantNoticeVersion, lastInboundAt: s.now, expiresAt: new Date(s.now.getTime() + ENROLLMENT_TTL_HOURS * 3600_000) },
        update: { state: 'AWAITING_NAME', proposedName: null, profileDisplayName: s.event.senderProfileName, noticeVersion: s.org.participantNoticeVersion, lastInboundAt: s.now, expiresAt: new Date(s.now.getTime() + ENROLLMENT_TTL_HOURS * 3600_000) },
      });
      const hint = s.event.senderProfileName ? ` ${copy.enrollmentConfirmName(s.event.senderProfileName)}` : '';
      await this.queue(s, 'ENROLLMENT', this.planner.text(`${copy.enrollmentAskName(s.orgCopy)}${hint}`), `enroll:${s.event.id}`);
      return 'ENROLLMENT_STARTED';
    }
    if (active.state === 'AWAITING_NAME') {
      const typed = (s.payload.text ?? '').replace(/\s+/g, ' ').trim();
      const confirmsProfileName = active.profileDisplayName && parseConsentReply(typed) === 'ACCEPT';
      const name = confirmsProfileName ? (active.profileDisplayName ?? '') : typed;
      if (!name || name.length > LIMITS.contactName.max || parseCommand(name)) {
        await this.queue(s, 'ENROLLMENT', this.planner.text(copy.enrollmentNameInvalid), `enroll:${s.event.id}`);
        return 'ENROLLMENT_NAME_INVALID';
      }
      // The notice version is bound to the prompt that renders it, not to the moment of acceptance.
      await tx.enrollment.update({ where: { id: active.id }, data: { proposedName: name, state: 'AWAITING_CONSENT', lastInboundAt: s.now, noticeVersion: s.org.participantNoticeVersion } });
      await this.queueConsentPrompt(s, null);
      return 'ENROLLMENT_NAME_RECORDED';
    }
    const reply = parseConsentReply(s.payload.text);
    if (!reply) {
      await tx.enrollment.update({ where: { id: active.id }, data: { lastInboundAt: s.now, noticeVersion: s.org.participantNoticeVersion } });
      await this.queueConsentPrompt(s, null);
      return 'ENROLLMENT_CONSENT_REPROMPT';
    }
    if (reply === 'DECLINE') {
      await tx.enrollment.update({ where: { id: active.id }, data: { state: 'DECLINED', lastInboundAt: s.now } });
      await this.queue(s, 'ENROLLMENT', this.planner.text(copy.consentDeclined), `enroll:${s.event.id}`);
      return 'ENROLLMENT_DECLINED';
    }
    return this.completeEnrollment(s, active.id, active.proposedName ?? 'Participant', active.noticeVersion);
  }

  private async completeEnrollment(s: Session, enrollmentId: string, name: string, shownNoticeVersion: number): Promise<string> {
    const phone = waIdToE164(s.event.senderIdentity);
    // A placeholder row may exist from earlier enrollment replies; it becomes the real contact now.
    const contact = await s.tx.contact.upsert({
      where: { organizationId_phoneE164: { organizationId: s.ctx.organizationId, phoneE164: phone } },
      create: { organizationId: s.ctx.organizationId, name, phoneE164: phone, providerIdentity: s.event.senderIdentity, profileProvenance: asJson({}) },
      update: { name, providerIdentity: s.event.senderIdentity, archivedAt: null, profileProvenance: asJson({}) },
    });
    await this.consent.grantFromParticipant(s.tx, contact.id, s.now, String(shownNoticeVersion), s.event.providerMessageId);
    await s.tx.enrollment.update({ where: { id: enrollmentId }, data: { state: 'COMPLETED', lastInboundAt: s.now } });
    await s.tx.conversation.upsert({
      where: { organizationId_contactId: { organizationId: s.ctx.organizationId, contactId: contact.id } },
      create: { organizationId: s.ctx.organizationId, contactId: contact.id, connectionId: s.connection.id, lastInboundAt: s.now },
      update: { lastInboundAt: s.now, pendingInput: null },
    });
    s.contact = contact;
    await this.audit.record(s.ctx, { action: 'participant.enrolled', resourceType: 'contact', resourceId: contact.id, metadata: { source: 'whatsapp' } }, s.tx);
    await this.queue(s, 'ENROLLMENT', this.planner.text(copy.consentGranted(s.orgCopy)), `enroll:${s.event.id}`);
    return 'ENROLLMENT_COMPLETED';
  }

  private async offerConsent(s: Session): Promise<string> {
    if (!s.contact || !s.conversation) return 'NO_CONTACT';
    // Remember which notice version this prompt shows; the reply grants consent to that wording.
    await s.tx.conversation.update({ where: { id: s.conversation.id }, data: { pendingInput: 'CONSENT', pendingContext: asJson({ noticeVersion: s.org.participantNoticeVersion }) } });
    await this.queueConsentPrompt(s, s.contact);
    return 'CONSENT_OFFERED';
  }

  private async queueConsentPrompt(s: Session, contact: Contact | null): Promise<void> {
    const body = copy.consentPrompt(s.orgCopy, s.org.participantNotice);
    if (!contact) {
      await this.queue(s, 'ENROLLMENT', this.planner.text(body), `consent-prompt:${s.event.id}`);
      return;
    }
    const expiresAt = new Date(s.now.getTime() + ENROLLMENT_TTL_HOURS * 3600_000);
    // Each button carries the version of the notice it was rendered with: a later re-prompt never
    // changes what an earlier button agrees to.
    const payload = { noticeVersion: s.org.participantNoticeVersion };
    const accept = await this.bindings.mint(s.tx, { organizationId: s.ctx.organizationId, connectionId: s.connection.id, contactId: contact.id, purpose: 'CONSENT_ACCEPT', mode: 'LIVE', expiresAt, payload });
    const decline = await this.bindings.mint(s.tx, { organizationId: s.ctx.organizationId, connectionId: s.connection.id, contactId: contact.id, purpose: 'CONSENT_DECLINE', mode: 'LIVE', expiresAt, payload });
    await this.queue(s, 'ENROLLMENT', { type: 'buttons', body, buttons: [{ id: accept.token, title: copy.consentAccept }, { id: decline.token, title: copy.consentDecline }] }, `consent-prompt:${s.event.id}`);
  }

  /** `boundNoticeVersion` comes from the tapped button; a typed reply uses the version of the open prompt. */
  private async applyConsentReply(s: Session, reply: 'ACCEPT' | 'DECLINE', boundNoticeVersion?: number): Promise<string> {
    if (!s.contact || !s.conversation) return 'NO_CONTACT';
    const shownNoticeVersion = boundNoticeVersion ?? (s.conversation.pendingContext as { noticeVersion?: number } | null)?.noticeVersion ?? s.org.participantNoticeVersion;
    await s.tx.conversation.update({ where: { id: s.conversation.id }, data: { pendingInput: null, pendingContext: asJsonOrNull(null) } });
    if (reply === 'DECLINE') {
      await this.replyText(s, copy.consentDeclined, 'consent');
      return 'CONSENT_DECLINED';
    }
    await this.consent.grantFromParticipant(s.tx, s.contact.id, s.now, String(shownNoticeVersion), s.event.providerMessageId);
    await this.audit.record(s.ctx, { action: 'consent.granted', resourceType: 'contact', resourceId: s.contact.id, metadata: { source: 'participant_reply', noticeVersion: shownNoticeVersion } }, s.tx);
    await this.replyText(s, copy.consentGranted(s.orgCopy), 'consent');
    return 'CONSENT_GRANTED';
  }

  // ---- Bound actions --------------------------------------------------------

  private async handleAction(s: Session, controlId: string): Promise<string> {
    if (!s.contact) {
      await this.replyText(s, copy.notEligible, 'action');
      return 'ACTION_UNKNOWN_SENDER';
    }
    const { token, optionId } = this.bindings.parseControlId(controlId);
    const binding = await this.bindings.resolve(s.tx, token, { connectionId: s.connection.id, contactId: s.contact.id });
    if (!binding) {
      await this.replyText(s, copy.notEligible, 'action');
      return 'ACTION_INVALID';
    }
    switch (binding.purpose) {
      case 'START_SURVEY':
        return binding.runId ? this.startSurvey(s, s.contact, binding.runId, binding) : 'ACTION_INVALID';
      case 'CONTINUE_SURVEY':
        return this.continueParticipation(s, s.contact, binding.participationId);
      case 'SWITCH_SURVEY':
        return binding.runId ? this.startSurvey(s, s.contact, binding.runId, binding, true) : 'ACTION_INVALID';
      case 'ANSWER_OPTION':
        if (!binding.participationId || !binding.questionId || !optionId) return this.invalidAction(s);
        return this.submitAnswer(s, binding.participationId, binding.questionId, [optionId], s.payload.kind === 'LIST_REPLY' ? 'LIST' : s.payload.kind === 'TEMPLATE_BUTTON' ? 'TEMPLATE_BUTTON' : 'BUTTON');
      case 'EDIT_QUESTION':
        if (!binding.participationId || !binding.questionId) return this.invalidAction(s);
        return this.reopenQuestion(s, binding.participationId, binding.questionId);
      case 'PROFILE_OFFER_ACCEPT':
        return this.offerProfileFlow(s, s.contact, binding.participationId);
      case 'PROFILE_OFFER_SKIP':
        return this.skipProfile(s, s.contact, binding.participationId);
      case 'CONSENT_ACCEPT':
        return this.applyConsentReply(s, 'ACCEPT', (binding.payload as { noticeVersion?: number } | null)?.noticeVersion);
      case 'CONSENT_DECLINE':
        return this.applyConsentReply(s, 'DECLINE', (binding.payload as { noticeVersion?: number } | null)?.noticeVersion);
      case 'VIEW_RESULTS':
        return binding.snapshotId ? this.results.deliver(s.tx, s.ctx, s.contact, s.connection, binding.snapshotId, s.event.id) : 'ACTION_INVALID';
      case 'MENU_SELECT':
        return this.menuSelect(s, s.contact, binding);
      default:
        return this.invalidAction(s);
    }
  }

  private async invalidAction(s: Session): Promise<string> {
    await this.replyText(s, copy.notEligible, 'action');
    return 'ACTION_INVALID';
  }

  private async handleFlow(s: Session): Promise<string> {
    if (!s.contact) return 'ACTION_UNKNOWN_SENDER';
    const response = s.payload.flowResponse;
    const token = typeof response?.['action_token'] === 'string' ? response['action_token'] : typeof response?.['flow_token'] === 'string' ? response['flow_token'] : '';
    const binding = token ? await this.bindings.resolve(s.tx, token, { connectionId: s.connection.id, contactId: s.contact.id }) : null;
    if (!binding || !response) {
      await this.replyText(s, copy.notEligible, 'action');
      return 'ACTION_INVALID';
    }
    if (binding.purpose === 'QUESTION_FLOW') {
      if (!binding.participationId || !binding.questionId) return this.invalidAction(s);
      const selected = Array.isArray(response['selected']) ? (response['selected'] as string[]) : Array.isArray(response['selected_option_ids']) ? (response['selected_option_ids'] as string[]) : typeof response['selection'] === 'string' && response['selection'] ? [response['selection']] : [];
      return this.submitAnswer(s, binding.participationId, binding.questionId, selected, 'FLOW');
    }
    if (binding.purpose === 'PROFILE_FLOW') return this.applyProfileFlow(s, s.contact, binding, response);
    return this.invalidAction(s);
  }

  // ---- Survey flow ----------------------------------------------------------

  private async startSurvey(s: Session, contact: Contact, runId: string, binding: ActionBinding, forceSwitch = false): Promise<string> {
    const run = await s.tx.surveyRun.findUnique({ where: { id: runId }, include: { revision: { include: revisionInclude } } });
    if (!run) return this.invalidAction(s);
    const title = pickLocale(run.revision.title as LocalizedText, run.revision.locale);
    if (run.state === 'SCHEDULED') {
      await this.replyText(s, copy.surveyNotOpen, 'survey');
      return 'SURVEY_NOT_OPEN';
    }
    if (run.state !== 'ACTIVE' || s.now.getTime() >= run.closesAt.getTime()) {
      await this.replyText(s, copy.surveyClosed(title), 'survey');
      return 'SURVEY_CLOSED';
    }
    const recipient = await s.tx.surveyRecipient.findUnique({ where: { organizationId_runId_contactId: { organizationId: s.ctx.organizationId, runId, contactId: contact.id } } });
    if (!recipient) return this.invalidAction(s);
    const existing = await s.tx.participation.findUnique({ where: { organizationId_runId_contactId: { organizationId: s.ctx.organizationId, runId, contactId: contact.id } }, include: PARTICIPATION_INCLUDE });
    if (existing?.state === 'COMPLETED') {
      await this.replyText(s, copy.alreadyCompleted(title), 'survey');
      return 'ALREADY_COMPLETED';
    }
    const foreground = await this.foreground(s);
    if (!forceSwitch && foreground && foreground.state !== 'COMPLETED' && foreground.runId !== runId && foreground.run.state === 'ACTIVE' && s.now.getTime() < foreground.run.closesAt.getTime()) {
      const currentTitle = pickLocale(foreground.revision.title as LocalizedText, foreground.revision.locale);
      const menu = await this.planner.menu(s.tx, {
        organizationId: s.ctx.organizationId,
        contact: { id: contact.id, connectionId: s.connection.id },
        mode: binding.mode,
        body: copy.continueOrSwitch(currentTitle, title),
        buttonText: 'Choose',
        items: [
          { label: copy.continueButton, purpose: 'CONTINUE_SURVEY', participationId: foreground.id, runId: foreground.runId },
          { label: copy.switchButton, purpose: 'SWITCH_SURVEY', runId },
        ],
        expiresAt: run.closesAt,
      });
      await this.queue(s, 'COMMAND_REPLY', menu, `switch-offer:${s.event.id}`);
      return 'SWITCH_OFFERED';
    }
    const participation = existing ?? (await s.tx.participation.create({ data: { organizationId: s.ctx.organizationId, runId, revisionId: run.revisionId, contactId: contact.id, startedAt: s.now, currentQuestionId: run.revision.questions[0]?.id ?? null, lastInboundAt: s.now }, include: PARTICIPATION_INCLUDE }));
    await this.setForeground(s, participation.id);
    if (!existing) await this.audit.record(s.ctx, { action: 'participation.started', resourceType: 'participation', resourceId: participation.id, metadata: { runId, kind: run.kind } }, s.tx);
    const prefix = run.kind === 'TEST' ? `${copy.testLabel} ` : '';
    if (!existing) {
      await this.queue(s, 'COMMAND_REPLY', this.planner.introduction(s.orgCopy, run.revision.title as LocalizedText, run.revision.introduction as LocalizedText, run.revision.questions.length, run.revision.editWindowSeconds, run.revision.locale, prefix), `intro:${participation.id}`, { runId, participationId: participation.id, isTest: run.kind === 'TEST' });
      if (s.org.profileOnboardingEnabled && s.conversation?.profileOfferState === 'NOT_OFFERED' && (await this.profileFlowReady(s))) {
        await s.tx.conversation.update({ where: { id: s.conversation.id }, data: { profileOfferState: 'OFFERED', profileOfferedAt: s.now } });
        const offer = await this.planner.profileOffer(s.tx, { organizationId: s.ctx.organizationId, contact: { id: contact.id, connectionId: s.connection.id }, mode: binding.mode, participationId: participation.id, org: s.orgCopy, expiresAt: run.closesAt, prefix });
        await this.queue(s, 'PROFILE_OFFER', offer, `profile-offer:${participation.id}`, { runId, participationId: participation.id, isTest: run.kind === 'TEST' });
        return 'STARTED_PROFILE_OFFERED';
      }
    }
    if (participation.currentQuestionId) await this.sendQuestion(s, participation, participation.currentQuestionId, { reason: existing ? `resend:${s.event.id}` : null, isEdit: false });
    return existing ? 'RESUMED' : 'STARTED';
  }

  private async continueParticipation(s: Session, contact: Contact, participationId: string | null): Promise<string> {
    if (!participationId) return this.invalidAction(s);
    const participation = await s.tx.participation.findUnique({ where: { id: participationId }, include: PARTICIPATION_INCLUDE });
    if (!participation || participation.contactId !== contact.id) return this.invalidAction(s);
    await this.setForeground(s, participation.id);
    if (participation.state === 'COMPLETED' || !participation.currentQuestionId) {
      await this.replyText(s, copy.alreadyCompleted(pickLocale(participation.revision.title as LocalizedText, participation.revision.locale)), 'survey');
      return 'ALREADY_COMPLETED';
    }
    await this.sendQuestion(s, participation, participation.currentQuestionId, { reason: `resend:${s.event.id}`, isEdit: false });
    return 'CONTINUED';
  }

  private async resume(s: Session, contact: Contact): Promise<string> {
    const foreground = await this.foreground(s);
    if (foreground && foreground.state !== 'COMPLETED' && foreground.currentQuestionId && foreground.run.state === 'ACTIVE' && s.now.getTime() < foreground.run.closesAt.getTime()) {
      await this.sendQuestion(s, foreground, foreground.currentQuestionId, { reason: `resend:${s.event.id}`, isEdit: false });
      return 'RESUMED';
    }
    return this.showOpenInvitations(s, contact, true);
  }

  private async showOpenInvitations(s: Session, contact: Contact, fromResume = false): Promise<string> {
    const invitations = await s.tx.invitation.findMany({
      where: { contactId: contact.id, run: { state: 'ACTIVE', closesAt: { gt: s.now } }, state: { in: ['ACCEPTED', 'QUEUED', 'PENDING', 'UNKNOWN', 'FAILED'] } },
      include: { run: { include: { revision: { select: { title: true, locale: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    const completed = new Set((await s.tx.participation.findMany({ where: { contactId: contact.id, state: 'COMPLETED' }, select: { runId: true } })).map((row) => row.runId));
    const open = invitations.filter((invitation) => !completed.has(invitation.runId));
    if (open.length === 0) {
      await this.replyText(s, fromResume ? copy.resumeNothing : copy.noOpenSurveys(s.orgCopy), 'menu');
      return 'NO_OPEN_SURVEYS';
    }
    const menu = await this.planner.menu(s.tx, {
      organizationId: s.ctx.organizationId,
      contact: { id: contact.id, connectionId: s.connection.id },
      mode: 'LIVE',
      body: copy.openSurveysMenu,
      buttonText: 'Surveys',
      items: open.map((invitation) => ({ label: pickLocale(invitation.run.revision.title as LocalizedText, invitation.run.revision.locale), purpose: 'START_SURVEY' as const, runId: invitation.runId })),
      expiresAt: new Date(s.now.getTime() + 7 * 86_400_000),
    });
    await this.queue(s, 'COMMAND_REPLY', menu, `menu:${s.event.id}`);
    return 'MENU_SENT';
  }

  private async menuSelect(s: Session, contact: Contact, binding: ActionBinding): Promise<string> {
    const payload = (binding.payload as { menu?: string; page?: number; items?: Parameters<MessagePlanner['menu']>[1]['items'] } | null) ?? null;
    if (payload?.menu === 'next' && payload.items) {
      const menu = await this.planner.menu(s.tx, { organizationId: s.ctx.organizationId, contact: { id: contact.id, connectionId: s.connection.id }, mode: binding.mode, body: copy.openSurveysMenu, buttonText: 'Choose', items: payload.items, expiresAt: binding.expiresAt, page: payload.page ?? 1 });
      await this.queue(s, 'COMMAND_REPLY', menu, `menu:${s.event.id}`);
      return 'MENU_PAGE';
    }
    return this.invalidAction(s);
  }

  private async submitAnswer(s: Session, participationId: string, questionId: string, optionIds: string[], source: 'BUTTON' | 'LIST' | 'FLOW' | 'TEMPLATE_BUTTON'): Promise<string> {
    const participation = await s.tx.participation.findUnique({ where: { id: participationId }, include: PARTICIPATION_INCLUDE });
    if (!participation || participation.contactId !== s.contact?.id) return this.invalidAction(s);
    const title = pickLocale(participation.revision.title as LocalizedText, participation.revision.locale);
    const result = await this.answers.submit(s.tx, { organizationId: s.ctx.organizationId, participationId, questionId, optionIds, source, inboundEventId: s.event.id, providerAt: s.event.providerAt, receivedAt: s.event.receivedAt });
    const isTest = participation.run.kind === 'TEST';
    const prefix = isTest ? `${copy.testLabel} ` : '';
    const meta = { runId: participation.runId, participationId, isTest };
    switch (result.outcome) {
      case 'REJECTED': {
        const text =
          result.code === 'ANSWER_EDIT_EXPIRED' ? copy.editExpired
          : result.code === 'SURVEY_CLOSED' ? copy.surveyClosed(title)
          : result.code === 'SURVEY_NOT_OPEN' ? copy.surveyNotOpen
          : result.code === 'ANSWER_STALE' ? copy.staleReply
          : copy.invalidSelection(result.message);
        await this.queue(s, 'COMMAND_REPLY', this.planner.text(`${prefix}${text}`), `reject:${s.event.id}`, meta);
        await this.audit.record(s.ctx, { action: 'answer.rejected', resourceType: 'participation', resourceId: participationId, metadata: { code: result.code, questionId } }, s.tx);
        return `ANSWER_${result.code}`;
      }
      case 'UNCHANGED':
        await this.queue(s, 'COMMAND_REPLY', this.planner.text(`${prefix}${copy.answerUnchanged}`), `unchanged:${s.event.id}`, meta);
        return 'ANSWER_UNCHANGED';
      case 'EDITED':
        await this.queue(s, 'COMMAND_REPLY', this.planner.text(`${prefix}Answer updated. ${copy.recorded}`), `edited:${s.event.id}`, meta);
        return 'ANSWER_EDITED';
      case 'CREATED': {
        if (!participation.analysisProfile && s.contact) {
          await s.tx.participation.update({ where: { id: participationId }, data: { analysisProfile: asJson(buildAnalysisProfile(s.contact)), analysisProfileAt: s.now } });
        }
        const isForeground = s.conversation?.foregroundParticipationId === participationId;
        if (result.completed) {
          await s.tx.participation.update({ where: { id: participationId }, data: { completionAckedAt: s.now } });
          await this.queue(s, 'ACKNOWLEDGEMENT', this.planner.completion(participation.revision.editWindowSeconds, prefix), `complete:${participationId}`, meta);
          return 'ANSWER_COMPLETED';
        }
        if (!isForeground) {
          await this.queue(s, 'COMMAND_REPLY', this.planner.text(`${prefix}${copy.recorded} Reply RESUME to continue "${title}".`), `bg-ack:${s.event.id}`, meta);
          return 'ANSWER_BACKGROUND';
        }
        if (result.nextQuestionId) await this.sendQuestion(s, { ...participation, currentQuestionId: result.nextQuestionId }, result.nextQuestionId, { reason: null, isEdit: false });
        return 'ANSWER_RECORDED';
      }
    }
  }

  private async reopenQuestion(s: Session, participationId: string, questionId: string): Promise<string> {
    const participation = await s.tx.participation.findUnique({ where: { id: participationId }, include: PARTICIPATION_INCLUDE });
    if (!participation || participation.contactId !== s.contact?.id) return this.invalidAction(s);
    const answer = await s.tx.answer.findUnique({ where: { organizationId_participationId_questionId: { organizationId: s.ctx.organizationId, participationId, questionId } } });
    if (!answer || s.now.getTime() >= answer.editExpiresAt.getTime() || participation.run.state !== 'ACTIVE' || s.now.getTime() >= participation.run.closesAt.getTime()) {
      await this.replyText(s, copy.editQuestionNotEditable, 'edit');
      return 'EDIT_NOT_EDITABLE';
    }
    await this.sendQuestion(s, participation, questionId, { reason: `edit:${s.event.id}`, isEdit: true });
    return 'EDIT_REOPENED';
  }

  private async handleEditCommand(s: Session, contact: Contact, questionNumber: number | null): Promise<string> {
    const foreground = await this.foreground(s);
    if (!foreground) {
      await this.replyText(s, copy.editNothing, 'edit');
      return 'EDIT_NOTHING';
    }
    const answers = await s.tx.answer.findMany({ where: { participationId: foreground.id, editExpiresAt: { gt: s.now } }, include: { question: true } });
    const editable = answers.filter(() => foreground.run.state === 'ACTIVE' && s.now.getTime() < foreground.run.closesAt.getTime()).sort((a, b) => a.question.position - b.question.position);
    if (questionNumber !== null) {
      const target = foreground.revision.questions.find((question) => question.position === questionNumber - 1);
      const answer = target ? editable.find((candidate) => candidate.questionId === target.id) : undefined;
      if (!target || !answer) {
        await this.replyText(s, copy.editQuestionNotEditable, 'edit');
        return 'EDIT_NOT_EDITABLE';
      }
      return this.reopenQuestion(s, foreground.id, target.id);
    }
    if (editable.length === 0) {
      await this.replyText(s, copy.editNothing, 'edit');
      return 'EDIT_NOTHING';
    }
    const menu = await this.planner.menu(s.tx, {
      organizationId: s.ctx.organizationId,
      contact: { id: contact.id, connectionId: s.connection.id },
      mode: foreground.run.kind === 'TEST' ? 'TEST' : 'LIVE',
      body: copy.editMenu,
      buttonText: 'Questions',
      items: editable.map((answer) => ({ label: `Q${answer.question.position + 1}`, description: pickLocale(answer.question.prompt as LocalizedText, foreground.revision.locale), purpose: 'EDIT_QUESTION' as const, participationId: foreground.id, questionId: answer.questionId, runId: foreground.runId })),
      expiresAt: foreground.run.closesAt,
    });
    await this.queue(s, 'COMMAND_REPLY', menu, `edit-menu:${s.event.id}`, { runId: foreground.runId, participationId: foreground.id, isTest: foreground.run.kind === 'TEST' });
    return 'EDIT_MENU';
  }

  // ---- Profile --------------------------------------------------------------

  private async offerProfileFlow(s: Session, contact: Contact, participationId: string | null): Promise<string> {
    if (!s.org.profileOnboardingEnabled) {
      await this.replyText(s, 'Optional profile details are not collected by this organization.', 'profile');
      return 'PROFILE_DISABLED';
    }
    if (!(await this.profileFlowReady(s))) {
      await this.replyText(s, 'Optional profile details cannot be collected right now; please try again later.', 'profile');
      return 'PROFILE_FLOW_UNAVAILABLE';
    }
    const participation = participationId ? await s.tx.participation.findUnique({ where: { id: participationId }, include: PARTICIPATION_INCLUDE }) : await this.foreground(s);
    const isTest = participation?.run.kind === 'TEST';
    const flow = await this.planner.profileFlow(s.tx, {
      organizationId: s.ctx.organizationId,
      contact: { id: contact.id, connectionId: s.connection.id },
      mode: isTest ? 'TEST' : 'LIVE',
      participationId: participation?.id ?? null,
      expiresAt: new Date(s.now.getTime() + 7 * 86_400_000),
      prefix: isTest ? `${copy.testLabel} ` : '',
      current: { city: contact.city, district: contact.district, occupation: contact.occupation, gender: contact.gender, ageBand: contact.ageBand, membership: contact.selfReportedMembership ?? (contact.membership === 'UNKNOWN' ? null : contact.membership) },
    });
    await this.queue(s, 'PROFILE_FLOW', flow, `profile-flow:${s.event.id}`, { runId: participation?.runId ?? null, participationId: participation?.id ?? null, isTest: Boolean(isTest) });
    return 'PROFILE_FLOW_SENT';
  }

  /**
   * Readiness refuses to launch while onboarding is enabled and the profile Flow is unpublished;
   * this guards the live conversation against a Flow unpublished later, so no offer is made that
   * the follow-up form could not fulfil. Mock connections render Flows locally.
   */
  private async profileFlowReady(s: Session): Promise<boolean> {
    if (s.connection.mode !== 'LIVE') return true;
    const flow = await s.tx.flowBinding.findFirst({ where: { connectionId: s.connection.id, purpose: 'PROFILE' }, select: { status: true, providerFlowId: true } });
    if (flow?.status === 'PUBLISHED' && flow.providerFlowId) return true;
    this.logger.warn({ connectionId: s.connection.id }, 'Profile onboarding skipped: the profile Flow is not published and bound');
    return false;
  }

  private async skipProfile(s: Session, contact: Contact, participationId: string | null): Promise<string> {
    if (s.conversation) await s.tx.conversation.update({ where: { id: s.conversation.id }, data: { profileOfferState: 'SKIPPED' } });
    await this.replyText(s, copy.profileSkipped, 'profile');
    return this.continueAfterProfile(s, contact, participationId, 'PROFILE_SKIPPED');
  }

  private async applyProfileFlow(s: Session, contact: Contact, binding: ActionBinding, response: Record<string, unknown>): Promise<string> {
    const text = (key: string) => (typeof response[key] === 'string' ? (response[key] as string).replace(/\s+/g, ' ').trim().slice(0, 120) : '');
    const genders: Gender[] = ['WOMAN', 'MAN', 'ANOTHER_IDENTITY', 'PREFER_NOT_TO_SAY'];
    const ageBands: AgeBand[] = ['UNDER_18', 'AGE_18_24', 'AGE_25_34', 'AGE_35_44', 'AGE_45_54', 'AGE_55_64', 'AGE_65_PLUS', 'PREFER_NOT_TO_SAY'];
    const memberships: MembershipKind[] = ['MEMBER', 'NON_MEMBER', 'UNKNOWN'];
    const gender = genders.find((value) => value === text('gender')) ?? null;
    const ageBand = ageBands.find((value) => value === text('age_band')) ?? null;
    const membership = memberships.find((value) => value === text('membership')) ?? null;
    const city = text('city') || null;
    const district = text('district') || null;
    const occupation = text('occupation') || null;
    const provenance = { ...((contact.profileProvenance as Record<string, unknown> | null) ?? {}) };
    const stamp = { source: 'SELF_REPORTED', at: s.now.toISOString() };
    for (const [field, value] of Object.entries({ city, district, gender, ageBand, occupation })) {
      if (value !== null) provenance[field] = stamp;
      else delete provenance[field];
    }
    // Participants update their own optional fields; staff-maintained tags, groups and the
    // verified membership value are never touched by a self-report.
    const updated = await s.tx.contact.update({
      where: { id: contact.id },
      data: { city, cityNormalized: normalizeText(city), district, districtNormalized: normalizeText(district), gender, ageBand, occupation, selfReportedMembership: membership, selfReportedMembershipAt: membership ? s.now : null, profileProvenance: asJson(provenance) },
    });
    s.contact = updated;
    if (s.conversation) await s.tx.conversation.update({ where: { id: s.conversation.id }, data: { profileOfferState: 'COMPLETED' } });
    await this.audit.record(s.ctx, { action: 'profile.self_reported', resourceType: 'contact', resourceId: contact.id, metadata: { fields: Object.entries({ city, district, gender, ageBand, occupation, membership }).filter(([, value]) => value !== null).map(([key]) => key) } }, s.tx);
    await this.replyText(s, copy.profileSaved, 'profile');
    return this.continueAfterProfile(s, updated, binding.participationId, 'PROFILE_SAVED');
  }

  private async continueAfterProfile(s: Session, _contact: Contact, participationId: string | null, code: string): Promise<string> {
    const participation = participationId ? await s.tx.participation.findUnique({ where: { id: participationId }, include: PARTICIPATION_INCLUDE }) : null;
    if (participation && participation.state !== 'COMPLETED' && participation.currentQuestionId && participation.run.state === 'ACTIVE' && s.now.getTime() < participation.run.closesAt.getTime()) {
      const answered = await s.tx.answer.count({ where: { participationId: participation.id } });
      if (answered === 0) await this.sendQuestion(s, participation, participation.currentQuestionId, { reason: null, isEdit: false });
    }
    return code;
  }

  // ---- Results --------------------------------------------------------------

  private async showResults(s: Session, contact: Contact): Promise<string> {
    const available = await this.results.availableFor(s.tx, contact.id);
    if (available.length === 0) {
      await this.queue(s, 'COMMAND_REPLY', this.planner.text(copy.resultsNone), resultsReplyKey('none', s.event.id));
      return 'RESULTS_NONE';
    }
    if (available.length === 1) return this.results.deliver(s.tx, s.ctx, contact, s.connection, available[0].snapshotId, s.event.id);
    const menu = await this.planner.menu(s.tx, {
      organizationId: s.ctx.organizationId,
      contact: { id: contact.id, connectionId: s.connection.id },
      mode: 'LIVE',
      body: copy.resultsMenu,
      buttonText: 'Results',
      items: available.map((item) => ({ label: item.title, purpose: 'VIEW_RESULTS' as const, snapshotId: item.snapshotId })),
      expiresAt: new Date(s.now.getTime() + LIMITS.actionBindingDays * 86_400_000),
    });
    await this.queue(s, 'COMMAND_REPLY', menu, resultsReplyKey('menu', s.event.id));
    return 'RESULTS_MENU';
  }

  // ---- Helpers --------------------------------------------------------------

  private async foreground(s: Session): Promise<ParticipationWithRun | null> {
    const id = s.conversation?.foregroundParticipationId;
    if (!id) return null;
    return s.tx.participation.findUnique({ where: { id }, include: PARTICIPATION_INCLUDE });
  }

  private async setForeground(s: Session, participationId: string): Promise<void> {
    if (!s.conversation) return;
    if (s.conversation.foregroundParticipationId === participationId) return;
    s.conversation = await s.tx.conversation.update({ where: { id: s.conversation.id }, data: { foregroundParticipationId: participationId, controlVersion: { increment: 1 } } });
  }

  private async sendQuestion(s: Session, participation: Participation & { run: { kind: 'LIVE' | 'TEST'; closesAt: Date }; revision: RevisionWithQuestions }, questionId: string, options: { reason: string | null; isEdit: boolean }): Promise<void> {
    const question = participation.revision.questions.find((candidate) => candidate.id === questionId);
    if (!question || !s.contact) return;
    const current = options.isEdit ? await s.tx.answer.findUnique({ where: { organizationId_participationId_questionId: { organizationId: s.ctx.organizationId, participationId: participation.id, questionId } }, include: { revisions: { where: { isCurrent: true }, include: { selections: true } } } }) : null;
    const { rendered } = await this.planner.question(s.tx, {
      organizationId: s.ctx.organizationId,
      contact: { id: s.contact.id, connectionId: s.connection.id },
      mode: participation.run.kind === 'TEST' ? 'TEST' : 'LIVE',
      runId: participation.runId,
      participationId: participation.id,
      question,
      position: question.position + 1,
      total: participation.revision.questions.length,
      locale: participation.revision.locale,
      expiresAt: participation.run.closesAt,
      currentOptionIds: current?.revisions[0]?.selections.map((selection) => selection.optionId) ?? [],
      prefix: participation.run.kind === 'TEST' ? `${copy.testLabel} ` : '',
      isEdit: options.isEdit,
    });
    const key = options.reason ? `q:${participation.id}:${questionId}:${options.reason}` : `q:${participation.id}:${questionId}`;
    await this.queue(s, 'QUESTION', rendered, key, { runId: participation.runId, participationId: participation.id, isTest: participation.run.kind === 'TEST' });
  }

  private async replyText(s: Session, body: string, tag: string): Promise<void> {
    await this.queue(s, 'COMMAND_REPLY', this.planner.text(body), `${tag}:${s.event.id}`);
  }

  private async queue(s: Session, kind: 'COMMAND_REPLY' | 'ACKNOWLEDGEMENT' | 'QUESTION' | 'OPT_OUT_ACK' | 'PROFILE_OFFER' | 'PROFILE_FLOW' | 'ENROLLMENT', rendered: RenderedMessage, dedupeKey: string, extra: { runId?: string | null; participationId?: string | null; isTest?: boolean; priority?: number } = {}): Promise<void> {
    const contactId = s.contact?.id;
    if (!contactId) {
      await this.queueForUnknownSender(s, kind, rendered, dedupeKey);
      return;
    }
    await this.delivery.createMessage(s.tx, {
      organizationId: s.ctx.organizationId,
      connectionId: s.connection.id,
      contactId,
      kind,
      rendered,
      dedupeKey,
      runId: extra.runId ?? null,
      participationId: extra.participationId ?? null,
      isTest: extra.isTest ?? false,
      priority: extra.priority ?? JOB_PRIORITY.reply,
    });
    s.replies += 1;
  }

  /** Replies to a sender who has no contact row yet are delivered through a provisional contact-less path. */
  private async queueForUnknownSender(s: Session, kind: 'COMMAND_REPLY' | 'ACKNOWLEDGEMENT' | 'QUESTION' | 'OPT_OUT_ACK' | 'PROFILE_OFFER' | 'PROFILE_FLOW' | 'ENROLLMENT', rendered: RenderedMessage, dedupeKey: string): Promise<void> {
    // Enrollment needs a contact row for delivery evidence; create an archived placeholder that
    // never receives proactive outreach and is only activated when enrollment completes.
    const phone = waIdToE164(s.event.senderIdentity);
    if (!phone) return;
    const placeholder = await s.tx.contact.upsert({
      where: { organizationId_phoneE164: { organizationId: s.ctx.organizationId, phoneE164: phone } },
      create: { organizationId: s.ctx.organizationId, name: 'Pending enrollment', phoneE164: phone, providerIdentity: s.event.senderIdentity, archivedAt: s.now, profileProvenance: asJson({ placeholder: true }) },
      update: { providerIdentity: s.event.senderIdentity },
    });
    s.contact = placeholder;
    s.conversation = await s.tx.conversation.upsert({
      where: { organizationId_contactId: { organizationId: s.ctx.organizationId, contactId: placeholder.id } },
      create: { organizationId: s.ctx.organizationId, contactId: placeholder.id, connectionId: s.connection.id, lastInboundAt: s.now },
      update: { lastInboundAt: s.now },
    });
    await this.delivery.createMessage(s.tx, { organizationId: s.ctx.organizationId, connectionId: s.connection.id, contactId: placeholder.id, kind, rendered, dedupeKey, priority: JOB_PRIORITY.reply });
    s.replies += 1;
  }
}

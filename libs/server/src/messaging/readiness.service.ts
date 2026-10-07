import { Inject, Injectable } from '@nestjs/common';
import type { MessagingConfiguration, MessagingReadinessDto } from '@raaye/contracts';
import type { Clock } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { OrgContext, TenantContext } from '../common/context';
import { DomainError, notFound } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { asJson } from '../persistence/json';
import type { FlowBinding, MessagingConnection, TemplateBinding } from '../persistence/prisma.service';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import { flowAssetVersion } from './flow-assets';
import { MetaManagementClient } from './meta-management';
import { resolveSecret } from './secrets';

export interface ReadinessCheck {
  ok: boolean;
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  connection: MessagingConnection | null;
  templates: TemplateBinding[];
  flows: FlowBinding[];
}

/** Sender readiness: configuration, template approval and Flow publication. */
@Injectable()
export class MessagingReadinessService {
  constructor(
    private readonly dbFactory: TenantDbFactory,
    private readonly audit: AuditService,
    private readonly management: MetaManagementClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async connection(ctx: OrgContext): Promise<MessagingConnection | null> {
    const db = this.dbFactory.for(ctx);
    const mode = this.config.isLiveMessaging ? 'LIVE' : 'MOCK';
    return (await db.messagingConnection.findFirst({ where: { mode, enabled: true }, orderBy: { createdAt: 'asc' } })) ?? (await db.messagingConnection.findFirst({ orderBy: { createdAt: 'asc' } }));
  }

  async check(ctx: OrgContext, options: { needResultsTemplate?: boolean; needFlows?: ('SINGLE_CHOICE' | 'MULTI_CHOICE' | 'PROFILE')[] } = {}): Promise<ReadinessCheck> {
    const db = this.dbFactory.for(ctx);
    const connection = await this.connection(ctx);
    const blockers: { code: string; message: string }[] = [];
    const warnings: { code: string; message: string }[] = [];
    if (!connection) {
      return { ok: false, blockers: [{ code: 'CONNECTION_MISSING', message: 'No messaging connection is configured for this organization' }], warnings, connection: null, templates: [], flows: [] };
    }
    const [templates, flows, org] = await Promise.all([
      db.templateBinding.findMany({ where: { connectionId: connection.id } }),
      db.flowBinding.findMany({ where: { connectionId: connection.id } }),
      db.organization.findUnique({ where: { id: ctx.organizationId } }),
    ]);
    if (!this.config.isLiveMessaging) {
      warnings.push({ code: 'MOCK_MODE', message: 'Messaging runs in mock mode: nothing is sent to WhatsApp and all synthetic contacts are accepted' });
      return { ok: true, blockers, warnings, connection, templates, flows };
    }
    if (connection.mode !== 'LIVE' || connection.provider !== 'META') blockers.push({ code: 'CONNECTION_NOT_LIVE', message: 'The enabled connection is not a live Meta connection' });
    for (const [field, label] of [['phoneNumberId', 'Phone number ID'], ['wabaId', 'WABA ID'], ['appId', 'App ID'], ['graphVersion', 'Graph API version']] as const) {
      if (!connection[field]) blockers.push({ code: 'CONNECTION_INCOMPLETE', message: `${label} is missing` });
    }
    for (const [field, label] of [['appSecretRef', 'App secret'], ['accessTokenRef', 'Access token'], ['verifyTokenRef', 'Webhook verify token']] as const) {
      const ref = connection[field];
      if (!ref) blockers.push({ code: 'SECRET_REF_MISSING', message: `${label} reference is missing` });
      else if (!resolveSecret(ref)) blockers.push({ code: 'SECRET_UNRESOLVED', message: `${label} reference "${ref}" does not resolve to a configured secret` });
    }
    const invitation = templates.find((template) => template.purpose === 'SURVEY_INVITATION');
    if (!invitation) blockers.push({ code: 'TEMPLATE_NOT_READY', message: 'No survey invitation template is bound' });
    else if (invitation.status !== 'APPROVED') blockers.push({ code: 'TEMPLATE_NOT_READY', message: `Invitation template "${invitation.providerName}" is ${invitation.status}, not APPROVED` });
    if (options.needResultsTemplate) {
      const results = templates.find((template) => template.purpose === 'RESULTS_AVAILABLE');
      if (!results || results.status !== 'APPROVED') blockers.push({ code: 'TEMPLATE_NOT_READY', message: 'The results-available template is not approved' });
    }
    for (const purpose of options.needFlows ?? []) {
      const flow = flows.find((binding) => binding.purpose === purpose);
      if (!flow || flow.status !== 'PUBLISHED' || !flow.providerFlowId) blockers.push({ code: 'FLOW_NOT_READY', message: `The ${purpose.toLowerCase().replace('_', '-')} Flow is not published and bound` });
      else if (flow.assetVersion !== flowAssetVersion(purpose)) warnings.push({ code: 'FLOW_VERSION_DRIFT', message: `Published ${purpose} Flow uses asset ${flow.assetVersion}; repository asset is ${flowAssetVersion(purpose)}` });
    }
    if (!org?.privacyUrl || !org.supportContact) blockers.push({ code: 'ORGANIZATION_DETAILS_MISSING', message: 'Privacy URL and human support contact are required before live outreach' });
    if (!org?.livePolicyReviewedAt) blockers.push({ code: 'POLICY_REVIEW_MISSING', message: 'Record the live messaging policy review attestation in Settings' });
    return { ok: blockers.length === 0, blockers, warnings, connection, templates, flows };
  }

  async readiness(ctx: TenantContext): Promise<MessagingReadinessDto> {
    const check = await this.check(ctx, { needFlows: ['SINGLE_CHOICE', 'MULTI_CHOICE', 'PROFILE'] });
    return this.toDto(check);
  }

  toDto(check: ReadinessCheck): MessagingReadinessDto {
    const connection = check.connection;
    return {
      mode: this.config.MESSAGING_MODE,
      provider: this.config.isLiveMessaging ? 'META' : 'MOCK',
      ok: check.ok,
      blockers: check.blockers,
      warnings: check.warnings,
      connection: connection
        ? {
            id: connection.id,
            appKey: connection.appKey,
            phoneNumberId: connection.phoneNumberId,
            wabaId: connection.wabaId,
            appId: connection.appId,
            displayPhoneNumber: connection.displayPhoneNumber,
            graphVersion: connection.graphVersion,
            appSecretRef: connection.appSecretRef,
            accessTokenRef: connection.accessTokenRef,
            verifyTokenRef: connection.verifyTokenRef,
            enabled: connection.enabled,
          }
        : null,
      templates: check.templates.map((template) => ({ purpose: template.purpose, providerName: template.providerName, locale: template.locale, category: template.category, status: template.status, buttonPosition: template.buttonPosition, lastCheckedAt: template.lastCheckedAt?.toISOString() ?? null })),
      flows: check.flows.map((flow) => ({ purpose: flow.purpose, locale: flow.locale, assetVersion: flow.assetVersion, providerFlowId: flow.providerFlowId, status: flow.status, lastCheckedAt: flow.lastCheckedAt?.toISOString() ?? null })),
      webhookPath: connection ? `/api/v1/webhooks/whatsapp/${connection.appKey}` : null,
      checkedAt: this.clock.now().toISOString(),
    };
  }

  /** Non-secret fields and secret references only; values never pass through here. */
  async updateConfiguration(ctx: TenantContext, input: MessagingConfiguration): Promise<MessagingReadinessDto> {
    const db = this.dbFactory.for(ctx);
    const connection = await this.connection(ctx);
    if (!connection) throw notFound('Messaging connection');
    const { templates, flows, ...fields } = input;
    for (const value of [fields.appSecretRef, fields.accessTokenRef, fields.verifyTokenRef]) {
      if (value && /^(EAA|Bearer |sk_|secret)/i.test(value) && value.length > 40) {
        throw new DomainError('VALIDATION_FAILED', 'Provide the name of the secret reference (for example META_ACCESS_TOKEN), never the secret value');
      }
    }
    await db.$transaction(async (tx) => {
      await tx.messagingConnection.update({ where: { id: connection.id }, data: { ...fields } });
      if (templates) {
        for (const template of templates) {
          await tx.templateBinding.upsert({
            where: { organizationId_connectionId_purpose_locale: { organizationId: ctx.organizationId, connectionId: connection.id, purpose: template.purpose, locale: template.locale } },
            create: { organizationId: ctx.organizationId, connectionId: connection.id, purpose: template.purpose, providerName: template.providerName, locale: template.locale, category: template.category ?? null, buttonPosition: template.buttonPosition, status: 'PENDING', parameterMapping: asJson({ body: ['organization_name', 'survey_title'], button: ['action_token'] }) },
            update: { providerName: template.providerName, category: template.category ?? null, buttonPosition: template.buttonPosition, status: 'PENDING' },
          });
        }
      }
      if (flows) {
        for (const flow of flows) {
          await tx.flowBinding.upsert({
            where: { organizationId_connectionId_purpose_locale: { organizationId: ctx.organizationId, connectionId: connection.id, purpose: flow.purpose, locale: flow.locale } },
            create: { organizationId: ctx.organizationId, connectionId: connection.id, purpose: flow.purpose, locale: flow.locale, assetVersion: flowAssetVersion(flow.purpose), providerFlowId: flow.providerFlowId, status: flow.providerFlowId ? 'UNKNOWN' : 'MISSING' },
            update: { providerFlowId: flow.providerFlowId, status: flow.providerFlowId ? 'UNKNOWN' : 'MISSING', assetVersion: flowAssetVersion(flow.purpose) },
          });
        }
      }
      await this.audit.record(ctx, { action: 'messaging.configuration_updated', resourceType: 'messaging_connection', resourceId: connection.id, metadata: { fields: Object.keys(fields), templates: templates?.length ?? 0, flows: flows?.length ?? 0 } }, tx);
    });
    return this.readiness(ctx);
  }

  /** Refresh template status from Meta (live) or confirm mock bindings. Never sends messages. */
  async refreshStatus(ctx: TenantContext): Promise<MessagingReadinessDto> {
    const db = this.dbFactory.for(ctx);
    const connection = await this.connection(ctx);
    if (!connection) throw notFound('Messaging connection');
    const now = this.clock.now();
    const templates = await db.templateBinding.findMany({ where: { connectionId: connection.id } });
    if (this.config.isLiveMessaging && connection.wabaId) {
      for (const template of templates) {
        try {
          const statuses = await this.management.templateStatus(connection.wabaId, template.providerName, connection.accessTokenRef);
          const match = statuses.find((status) => status.language === template.locale) ?? statuses[0];
          await db.templateBinding.update({ where: { id: template.id }, data: { status: mapTemplateStatus(match?.status), category: match?.category ?? template.category, lastCheckedAt: now } });
        } catch {
          await db.templateBinding.update({ where: { id: template.id }, data: { status: 'UNKNOWN', lastCheckedAt: now } });
        }
      }
    } else {
      await db.templateBinding.updateMany({ where: { connectionId: connection.id }, data: { lastCheckedAt: now } });
      await db.flowBinding.updateMany({ where: { connectionId: connection.id }, data: { lastCheckedAt: now } });
    }
    await db.messagingConnection.update({ where: { id: connection.id }, data: { lastCheckedAt: now } });
    await this.audit.record(ctx, { action: 'messaging.status_refreshed', resourceType: 'messaging_connection', resourceId: connection.id });
    return this.readiness(ctx);
  }
}

function mapTemplateStatus(status: string | undefined): 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED' | 'UNKNOWN' {
  switch ((status ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'APPROVED';
    case 'REJECTED':
      return 'REJECTED';
    case 'PAUSED':
      return 'PAUSED';
    case 'DISABLED':
      return 'DISABLED';
    case 'PENDING':
    case 'IN_APPEAL':
      return 'PENDING';
    default:
      return 'UNKNOWN';
  }
}

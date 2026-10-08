import type { ConnectionMode, FlowBinding, FlowPurpose, MessagingConnection, TemplateBinding } from '../persistence/prisma.service';
import { flowAssetVersion } from './flow-assets';
import { resolveSecret } from './secrets';

/** What the caller is about to send; it decides which templates and Flows must be ready. */
export type ReadinessPurpose = 'OUTREACH' | 'RESULTS' | 'SETTINGS';

export interface ReadinessOptions {
  /**
   * `OUTREACH` (default): survey invitations and the conversation that follows them (launch,
   * test run, activation, survey detail). `RESULTS`: a results broadcast. `SETTINGS`: the
   * operator's full picture, which lists every template and Flow.
   */
  purpose?: ReadinessPurpose;
  needFlows?: FlowPurpose[];
}

export interface ReadinessIssue {
  code: string;
  message: string;
}

export interface ReadinessVerdict {
  ok: boolean;
  blockers: ReadinessIssue[];
  warnings: ReadinessIssue[];
}

export interface ReadinessInput {
  /** The process runs against the real provider (`MESSAGING_MODE=live`). */
  live: boolean;
  /** The connection mode the process expects (`LIVE` or `MOCK`). */
  mode: ConnectionMode;
  connection: Pick<MessagingConnection, 'enabled' | 'mode' | 'provider' | 'phoneNumberId' | 'wabaId' | 'appId' | 'graphVersion' | 'appSecretRef' | 'accessTokenRef' | 'verifyTokenRef'> | null;
  templates: Pick<TemplateBinding, 'purpose' | 'providerName' | 'status'>[];
  flows: Pick<FlowBinding, 'purpose' | 'status' | 'providerFlowId' | 'assetVersion'>[];
  organization: { privacyUrl: string | null; supportContact: string | null; livePolicyReviewedAt: Date | null; profileOnboardingEnabled: boolean } | null;
  options: ReadinessOptions;
  /** Secret reference resolver; injectable for tests. */
  resolve?: (ref: string | null | undefined) => string | null;
}

/**
 * Sender readiness as a pure rule: configuration, template approval and Flow publication for
 * what the caller is about to send. Launch, test and activation need the invitation template
 * plus the Flows the questions render with, and the profile Flow whenever onboarding is enabled
 * (otherwise the offer made on a participant's first start could not be fulfilled). A results
 * broadcast needs only the results template. Settings reports everything.
 */
export function evaluateReadiness(input: ReadinessInput): ReadinessVerdict {
  const blockers: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];
  const purpose = input.options.purpose ?? 'OUTREACH';
  const connection = input.connection;
  if (!connection) {
    return { ok: false, blockers: [{ code: 'CONNECTION_MISSING', message: `No ${input.mode.toLowerCase()} messaging connection exists for this organization yet; save the sender configuration in Settings to create it` }], warnings };
  }
  if (!connection.enabled) blockers.push({ code: 'CONNECTION_DISABLED', message: 'The messaging connection is disabled; enable it in Settings before any outreach' });
  if (!input.live) {
    warnings.push({ code: 'MOCK_MODE', message: 'Messaging runs in mock mode: nothing is sent to WhatsApp and all synthetic contacts are accepted' });
    return { ok: blockers.length === 0, blockers, warnings };
  }
  const resolve = input.resolve ?? resolveSecret;
  if (connection.mode !== 'LIVE' || connection.provider !== 'META') blockers.push({ code: 'CONNECTION_NOT_LIVE', message: 'The enabled connection is not a live Meta connection' });
  for (const [field, label] of [['phoneNumberId', 'Phone number ID'], ['wabaId', 'WABA ID'], ['appId', 'App ID'], ['graphVersion', 'Graph API version']] as const) {
    if (!connection[field]) blockers.push({ code: 'CONNECTION_INCOMPLETE', message: `${label} is missing` });
  }
  for (const [field, label] of [['appSecretRef', 'App secret'], ['accessTokenRef', 'Access token'], ['verifyTokenRef', 'Webhook verify token']] as const) {
    const ref = connection[field];
    if (!ref) blockers.push({ code: 'SECRET_REF_MISSING', message: `${label} reference is missing` });
    else if (!resolve(ref)) blockers.push({ code: 'SECRET_UNRESOLVED', message: `${label} reference "${ref}" does not resolve to a configured secret` });
  }
  const invitation = input.templates.find((template) => template.purpose === 'SURVEY_INVITATION');
  const results = input.templates.find((template) => template.purpose === 'RESULTS_AVAILABLE');
  if (purpose !== 'RESULTS') {
    if (!invitation) blockers.push({ code: 'TEMPLATE_NOT_READY', message: 'No survey invitation template is bound' });
    else if (invitation.status !== 'APPROVED') blockers.push({ code: 'TEMPLATE_NOT_READY', message: `Invitation template "${invitation.providerName}" is ${invitation.status}, not APPROVED` });
  }
  if (purpose === 'RESULTS') {
    if (!results || results.status !== 'APPROVED') blockers.push({ code: 'TEMPLATE_NOT_READY', message: 'The results-available template is not approved' });
  } else if (purpose === 'SETTINGS' && (!results || results.status !== 'APPROVED')) {
    warnings.push({ code: 'RESULTS_TEMPLATE_NOT_READY', message: 'The results-available template is not approved; results cannot be shared until it is' });
  }
  const needFlows = new Set<FlowPurpose>(input.options.needFlows ?? []);
  if (purpose === 'OUTREACH' && input.organization?.profileOnboardingEnabled) needFlows.add('PROFILE');
  for (const flowPurpose of needFlows) {
    const flow = input.flows.find((binding) => binding.purpose === flowPurpose);
    if (!flow || flow.status !== 'PUBLISHED' || !flow.providerFlowId) {
      const why = flowPurpose === 'PROFILE' && !(input.options.needFlows ?? []).includes('PROFILE') ? ' (profile onboarding is enabled, so first-time participants are offered it)' : '';
      blockers.push({ code: 'FLOW_NOT_READY', message: `The ${flowPurpose.toLowerCase().replace('_', '-')} Flow is not published and bound${why}` });
    } else if (flow.assetVersion !== flowAssetVersion(flowPurpose)) {
      warnings.push({ code: 'FLOW_VERSION_DRIFT', message: `Published ${flowPurpose} Flow uses asset ${flow.assetVersion}; repository asset is ${flowAssetVersion(flowPurpose)}` });
    }
  }
  if (!input.organization?.privacyUrl || !input.organization.supportContact) blockers.push({ code: 'ORGANIZATION_DETAILS_MISSING', message: 'Privacy URL and human support contact are required before live outreach' });
  if (!input.organization?.livePolicyReviewedAt) blockers.push({ code: 'POLICY_REVIEW_MISSING', message: 'Record the live messaging policy review attestation in Settings' });
  return { ok: blockers.length === 0, blockers, warnings };
}

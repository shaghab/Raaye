import { flowAssetVersion } from '../flow-assets';
import { evaluateReadiness, type ReadinessInput } from '../readiness-rules';

const connection: NonNullable<ReadinessInput['connection']> = {
  enabled: true,
  mode: 'LIVE',
  provider: 'META',
  phoneNumberId: '111',
  wabaId: '222',
  appId: '333',
  graphVersion: 'v21.0',
  appSecretRef: 'META_APP_SECRET',
  accessTokenRef: 'META_ACCESS_TOKEN',
  verifyTokenRef: 'META_WEBHOOK_VERIFY_TOKEN',
};
const invitation = { purpose: 'SURVEY_INVITATION' as const, providerName: 'raaye_survey_invitation', status: 'APPROVED' as const };
const results = { purpose: 'RESULTS_AVAILABLE' as const, providerName: 'raaye_results_available', status: 'APPROVED' as const };
const flow = (purpose: 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'PROFILE') => ({ purpose, status: 'PUBLISHED' as const, providerFlowId: `flow-${purpose}`, assetVersion: flowAssetVersion(purpose) });
const organization = { privacyUrl: 'https://example.org/privacy', supportContact: '+923000000000', livePolicyReviewedAt: new Date('2026-10-01T00:00:00Z'), profileOnboardingEnabled: true };
const base: ReadinessInput = { live: true, mode: 'LIVE', connection, templates: [invitation, results], flows: [flow('SINGLE_CHOICE'), flow('MULTI_CHOICE'), flow('PROFILE')], organization, options: {}, resolve: () => 'secret' };
const codes = (input: ReadinessInput) => evaluateReadiness(input).blockers.map((blocker) => blocker.code);

describe('messaging readiness rules (R22)', () => {
  it('is green for a complete live sender and reports a missing or disabled one', () => {
    expect(evaluateReadiness(base)).toEqual({ ok: true, blockers: [], warnings: [] });
    expect(codes({ ...base, connection: null })).toEqual(['CONNECTION_MISSING']);
    expect(codes({ ...base, connection: { ...connection, enabled: false } })).toEqual(['CONNECTION_DISABLED']);
    expect(codes({ ...base, resolve: () => null })).toEqual(['SECRET_UNRESOLVED', 'SECRET_UNRESOLVED', 'SECRET_UNRESOLVED']);
  });

  it('requires only the templates the operation sends (issue #11)', () => {
    const onlyResults: ReadinessInput = { ...base, templates: [results] };
    expect(evaluateReadiness({ ...onlyResults, options: { purpose: 'RESULTS' } })).toEqual({ ok: true, blockers: [], warnings: [] });
    expect(evaluateReadiness({ ...base, templates: [{ ...invitation, status: 'PAUSED' }, results], options: { purpose: 'RESULTS' } }).ok).toBe(true);
    expect(codes({ ...onlyResults, options: { purpose: 'OUTREACH' } })).toEqual(['TEMPLATE_NOT_READY']);
    expect(codes({ ...onlyResults, options: {} })).toEqual(['TEMPLATE_NOT_READY']);
    const onlyInvitation: ReadinessInput = { ...base, templates: [invitation] };
    expect(evaluateReadiness({ ...onlyInvitation, options: { purpose: 'OUTREACH' } }).ok).toBe(true);
    expect(codes({ ...onlyInvitation, options: { purpose: 'RESULTS' } })).toEqual(['TEMPLATE_NOT_READY']);
    // Settings keeps the full picture: the invitation template blocks, the results template warns.
    const settings = evaluateReadiness({ ...onlyInvitation, options: { purpose: 'SETTINGS', needFlows: ['SINGLE_CHOICE', 'MULTI_CHOICE', 'PROFILE'] } });
    expect(settings.ok).toBe(true);
    expect(settings.warnings.map((warning) => warning.code)).toEqual(['RESULTS_TEMPLATE_NOT_READY']);
    expect(codes({ ...onlyResults, options: { purpose: 'SETTINGS' } })).toEqual(['TEMPLATE_NOT_READY']);
  });

  it('requires the profile Flow for outreach while onboarding is enabled (issue #18)', () => {
    const withoutProfile: ReadinessInput = { ...base, flows: [flow('SINGLE_CHOICE'), flow('MULTI_CHOICE')] };
    const blocked = evaluateReadiness({ ...withoutProfile, options: { purpose: 'OUTREACH', needFlows: [] } });
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers).toEqual([{ code: 'FLOW_NOT_READY', message: expect.stringContaining('profile onboarding is enabled') }]);
    expect(evaluateReadiness({ ...withoutProfile, organization: { ...organization, profileOnboardingEnabled: false }, options: { needFlows: ['SINGLE_CHOICE'] } }).ok).toBe(true);
    expect(evaluateReadiness({ ...withoutProfile, options: { purpose: 'RESULTS' } }).ok).toBe(true);
    // An unpublished or unbound profile Flow counts as missing; a published one with a stale asset only warns.
    expect(codes({ ...base, flows: [flow('SINGLE_CHOICE'), flow('MULTI_CHOICE'), { ...flow('PROFILE'), status: 'DRAFT' }] })).toEqual(['FLOW_NOT_READY']);
    expect(codes({ ...base, flows: [flow('SINGLE_CHOICE'), flow('MULTI_CHOICE'), { ...flow('PROFILE'), providerFlowId: null }] })).toEqual(['FLOW_NOT_READY']);
    const drift = evaluateReadiness({ ...base, flows: [flow('SINGLE_CHOICE'), flow('MULTI_CHOICE'), { ...flow('PROFILE'), assetVersion: 'profile.v0' }] });
    expect(drift.ok).toBe(true);
    expect(drift.warnings.map((warning) => warning.code)).toEqual(['FLOW_VERSION_DRIFT']);
    // Question Flows are still required by what the revision renders.
    expect(codes({ ...base, flows: [flow('PROFILE')], options: { needFlows: ['MULTI_CHOICE'] } })).toEqual(['FLOW_NOT_READY']);
  });

  it('mock mode only reports the sender state and warns that nothing is sent', () => {
    const mock = evaluateReadiness({ ...base, live: false, mode: 'MOCK', connection: { ...connection, mode: 'MOCK', provider: 'MOCK' }, templates: [], flows: [] });
    expect(mock).toEqual({ ok: true, blockers: [], warnings: [{ code: 'MOCK_MODE', message: expect.stringContaining('mock mode') }] });
    expect(codes({ ...base, live: false, mode: 'MOCK', connection: { ...connection, enabled: false }, templates: [], flows: [] })).toEqual(['CONNECTION_DISABLED']);
  });
});

import { isStaff, type OrgContext } from '../common/context';
import { notFound } from '../common/errors';

/**
 * Viewers may read published surveys only (R06). A draft is reported as not found rather than
 * forbidden, so its id is not confirmed. System and participant contexts, Admins and Survey
 * Managers are unaffected.
 */
export function assertSurveyVisible(ctx: OrgContext, survey: { state: string }): void {
  if (isStaff(ctx) && ctx.role === 'VIEWER' && survey.state === 'DRAFT') throw notFound('Survey');
}

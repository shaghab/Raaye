import { Inject, Injectable } from '@nestjs/common';
import { LIMITS, pickLocale, type DemographicDimension, type ExportType, type LocalizedText } from '@raaye/contracts';
import { buildXlsx, toCsv, type Clock, type XlsxCell } from '@raaye/domain';
import { AuditService } from '../audit/audit.service';
import { CLOCK } from '../clock/clock.service';
import type { TenantContext } from '../common/context';
import { DomainError, forbidden } from '../common/errors';
import { TenantDbFactory } from '../persistence/tenant-db.factory';
import { ReportingService } from './reporting.service';

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
}

type Row = XlsxCell[];

/**
 * Tenant- and run-scoped exports with permission checks at generation. Aggregates never
 * contain identities; identifiable answers are Admin-only and audited. All string cells
 * are formula-neutralized and phone numbers stay text.
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly dbFactory: TenantDbFactory,
    private readonly reporting: ReportingService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async exportSurvey(ctx: TenantContext, surveyId: string, type: ExportType, format: 'csv' | 'xlsx', dimension?: DemographicDimension): Promise<ExportFile> {
    if ((type === 'responses' || type === 'revisions') && ctx.role !== 'ADMIN') throw forbidden('Only Admins can export identifiable responses');
    const { survey, run } = await this.reporting.liveRun(ctx, surveyId);
    const sheets: { name: string; rows: Row[] }[] = [];
    let rowCount: number;
    const generatedAt = this.clock.now().toISOString();
    if (type === 'aggregates') {
      const results = await this.reporting.results(ctx, surveyId);
      const summary: Row[] = [
        ['survey_id', 'survey_title', 'run_id', 'revision', 'generated_at', 'started', 'responded', 'completed'],
        [survey.id, survey.internalTitle, results.runId ?? '', results.revisionNumber, generatedAt, results.started, results.responded, results.completed],
      ];
      const questions: Row[] = [['survey_id', 'run_id', 'revision', 'generated_at', 'question_id', 'question_position', 'question_text', 'question_type', 'valid_answers', 'unanswered_among_started', 'option_id', 'option_code', 'option_label', 'rating_value', 'count', 'percentage_of_respondents', 'rating_mean', 'percentages_may_exceed_100']];
      for (const question of results.questions) {
        for (const option of question.options) {
          questions.push([survey.id, results.runId ?? '', results.revisionNumber, generatedAt, question.questionId, question.position + 1, pickLocale(question.prompt), question.type, question.validAnswers, question.unansweredAmongStarted, option.optionId, option.code, pickLocale(option.label), option.ratingValue, option.count, option.percentage === null ? 'N/A' : option.percentage, question.ratingMean ?? '', question.percentagesMaySumOver100 ? 'yes' : 'no']);
        }
      }
      rowCount = questions.length - 1;
      sheets.push({ name: 'Summary', rows: summary }, { name: 'Questions', rows: questions });
    } else if (type === 'breakdowns') {
      const dim = dimension ?? 'city';
      const breakdown = await this.reporting.breakdown(ctx, surveyId, dim);
      const rows: Row[] = [['survey_id', 'run_id', 'generated_at', 'dimension', 'threshold', 'threshold_applied', 'question_id', 'question_position', 'question_text', 'cohort', 'cohort_label', 'respondents', 'option_id', 'option_label', 'count', 'percentage_of_cohort']];
      for (const question of breakdown.questions) {
        const labels = new Map(question.options.map((option) => [option.optionId, pickLocale(option.label)]));
        for (const cohort of question.cohorts) {
          if (cohort.suppressed) {
            rows.push([survey.id, run?.id ?? '', generatedAt, dim, breakdown.threshold, 'yes', question.questionId, question.position + 1, pickLocale(question.prompt), cohort.cohort, cohort.label, 'suppressed', '', '', 'suppressed', 'suppressed']);
            continue;
          }
          for (const option of cohort.options) {
            rows.push([survey.id, run?.id ?? '', generatedAt, dim, breakdown.threshold, breakdown.thresholdApplied ? 'yes' : 'no', question.questionId, question.position + 1, pickLocale(question.prompt), cohort.cohort, cohort.label, cohort.respondents ?? '', option.optionId, labels.get(option.optionId) ?? '', option.count, option.percentage === null ? 'N/A' : option.percentage]);
          }
        }
      }
      rowCount = rows.length - 1;
      sheets.push({ name: `By ${dim}`, rows });
    } else {
      const db = this.dbFactory.for(ctx);
      if (!run) throw new DomainError('SURVEY_STATE_INVALID', 'The survey has not been launched');
      const participations = await db.participation.findMany({
        where: { runId: run.id },
        include: { contact: { select: { id: true, name: true, phoneE164: true } }, answers: { include: { question: true, revisions: { include: { selections: { include: { option: true } } }, orderBy: { revisionNumber: 'asc' } } } } },
        orderBy: { startedAt: 'asc' },
        take: 50_000,
      });
      const header: Row = ['survey_id', 'run_id', 'revision', 'participation_id', 'contact_id', 'contact_name', 'phone', 'participation_state', 'started_at', 'completed_at', 'question_id', 'question_position', 'question_text', 'answer_id', 'revision_number', 'is_current', 'accepted_at', 'source', 'option_id', 'option_code', 'option_label', 'rating_value', 'first_accepted_at', 'edit_expires_at'];
      const rows: Row[] = [header];
      for (const participation of participations) {
        for (const answer of participation.answers) {
          const revisions = type === 'responses' ? answer.revisions.filter((revision) => revision.isCurrent) : answer.revisions;
          for (const revision of revisions) {
            for (const selection of revision.selections) {
              rows.push([survey.id, run.id, run.revision.revisionNumber, participation.id, participation.contact.id, participation.contact.name, participation.contact.phoneE164, participation.state, participation.startedAt.toISOString(), participation.completedAt?.toISOString() ?? '', answer.questionId, answer.question.position + 1, pickLocale(answer.question.prompt as LocalizedText), answer.id, revision.revisionNumber, revision.isCurrent ? 'yes' : 'no', revision.acceptedAt.toISOString(), revision.source, selection.optionId, selection.option.code, pickLocale(selection.option.label as LocalizedText), selection.option.ratingValue ?? '', answer.firstAcceptedAt.toISOString(), answer.editExpiresAt.toISOString()]);
            }
          }
        }
      }
      rowCount = rows.length - 1;
      sheets.push({ name: type === 'responses' ? 'Current responses' : 'Revision history', rows });
    }
    await this.audit.record(ctx, { action: 'export.generated', resourceType: 'survey', resourceId: surveyId, metadata: { type, format, dimension: dimension ?? null, rowCount, runId: run?.id ?? null } });
    const stamp = generatedAt.slice(0, 10);
    const base = `survey-${surveyId.slice(0, 8)}-${type}${dimension ? `-${dimension}` : ''}-${stamp}`;
    if (format === 'xlsx') {
      return { filename: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from(buildXlsx(sheets)) };
    }
    const csvRows = sheets.length === 1 ? sheets[0].rows : sheets[sheets.length - 1].rows;
    return { filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(toCsv(csvRows.map((row) => row.map((cell) => (cell === undefined ? null : cell)))), 'utf8') };
  }

  get cohortThreshold(): number {
    return LIMITS.cohortThreshold;
  }
}

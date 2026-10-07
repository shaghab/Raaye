import type {
  CohortBreakdownDto,
  DemographicDimension,
  LocalizedText,
  QuestionBreakdownDto,
  QuestionResultDto,
  QuestionType,
} from '@raaye/contracts';
import { UNKNOWN_COHORT, cohortLabel } from './demographics';

export interface CurrentSelectionRow {
  participationId: string;
  questionId: string;
  optionId: string;
  ratingValue: number | null;
}

export interface QuestionShape {
  id: string;
  position: number;
  type: QuestionType;
  prompt: LocalizedText;
  options: { id: string; code: string; label: LocalizedText; ratingValue: number | null }[];
}

/** Percentage to one decimal place; null for a zero denominator; never above 100. */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const value = Math.round((Math.min(numerator, denominator) / denominator) * 1000) / 10;
  return value;
}

/** Share of respondents to one decimal place (may exceed 100 in total across options). */
export function share(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function computeQuestionResults(
  questions: readonly QuestionShape[],
  rows: readonly CurrentSelectionRow[],
  startedCount: number,
): QuestionResultDto[] {
  const byQuestion = new Map<string, CurrentSelectionRow[]>();
  for (const row of rows) {
    const list = byQuestion.get(row.questionId) ?? [];
    list.push(row);
    byQuestion.set(row.questionId, list);
  }
  return [...questions]
    .sort((a, b) => a.position - b.position)
    .map((question) => {
      const questionRows = byQuestion.get(question.id) ?? [];
      const respondents = new Set(questionRows.map((row) => row.participationId));
      const valid = respondents.size;
      const perOption = new Map<string, Set<string>>();
      for (const row of questionRows) {
        const set = perOption.get(row.optionId) ?? new Set<string>();
        set.add(row.participationId);
        perOption.set(row.optionId, set);
      }
      let ratingMean: number | null = null;
      if (question.type === 'RATING' && valid > 0) {
        const perParticipation = new Map<string, number>();
        for (const row of questionRows) {
          if (row.ratingValue !== null) perParticipation.set(row.participationId, row.ratingValue);
        }
        const values = Array.from(perParticipation.values());
        if (values.length > 0) {
          ratingMean = Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
        }
      }
      return {
        questionId: question.id,
        position: question.position,
        type: question.type,
        prompt: question.prompt,
        validAnswers: valid,
        unansweredAmongStarted: Math.max(0, startedCount - valid),
        options: question.options.map((option) => {
          const count = perOption.get(option.id)?.size ?? 0;
          return {
            optionId: option.id,
            code: option.code,
            label: option.label,
            ratingValue: option.ratingValue,
            count,
            percentage: share(count, valid),
          };
        }),
        ratingMean,
        percentagesMaySumOver100: question.type === 'MULTI_CHOICE',
      };
    });
}

export interface BreakdownInput {
  questions: readonly QuestionShape[];
  rows: readonly CurrentSelectionRow[];
  cohortOf: ReadonlyMap<string, string>;
  dimension: DemographicDimension;
  threshold: number;
  applyThreshold: boolean;
}

export function computeBreakdown(input: BreakdownInput): QuestionBreakdownDto[] {
  const { questions, rows, cohortOf, dimension, threshold, applyThreshold } = input;
  const byQuestion = new Map<string, CurrentSelectionRow[]>();
  for (const row of rows) {
    const list = byQuestion.get(row.questionId) ?? [];
    list.push(row);
    byQuestion.set(row.questionId, list);
  }
  return [...questions]
    .sort((a, b) => a.position - b.position)
    .map((question) => {
      const questionRows = byQuestion.get(question.id) ?? [];
      const cohorts = new Map<string, { respondents: Set<string>; perOption: Map<string, Set<string>> }>();
      for (const row of questionRows) {
        const key = cohortOf.get(row.participationId) ?? UNKNOWN_COHORT;
        const cohort = cohorts.get(key) ?? { respondents: new Set<string>(), perOption: new Map<string, Set<string>>() };
        cohort.respondents.add(row.participationId);
        const set = cohort.perOption.get(row.optionId) ?? new Set<string>();
        set.add(row.participationId);
        cohort.perOption.set(row.optionId, set);
        cohorts.set(key, cohort);
      }
      const keys = Array.from(cohorts.keys()).sort((a, b) => {
        if (a === UNKNOWN_COHORT) return 1;
        if (b === UNKNOWN_COHORT) return -1;
        return cohortLabel(dimension, a).localeCompare(cohortLabel(dimension, b));
      });
      const cohortDtos: CohortBreakdownDto[] = keys.map((key) => {
        const cohort = cohorts.get(key);
        const respondents = cohort?.respondents.size ?? 0;
        const suppressed = applyThreshold && respondents < threshold;
        return {
          cohort: key,
          label: cohortLabel(dimension, key),
          respondents: suppressed ? null : respondents,
          suppressed,
          options: suppressed
            ? []
            : question.options.map((option) => {
                const count = cohort?.perOption.get(option.id)?.size ?? 0;
                return { optionId: option.id, count, percentage: share(count, respondents) };
              }),
        };
      });
      return {
        questionId: question.id,
        position: question.position,
        prompt: question.prompt,
        type: question.type,
        options: question.options.map((option) => ({ optionId: option.id, label: option.label })),
        cohorts: cohortDtos,
      };
    });
}

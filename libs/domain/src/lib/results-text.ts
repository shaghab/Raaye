import { WHATSAPP_LIMITS, pickLocale, type LocalizedText } from '@raaye/contracts';

/** The immutable aggregate stored in a result snapshot (format version 1). */
export interface SnapshotAggregate {
  formatVersion: 1;
  surveyTitle: LocalizedText;
  generatedAt: string;
  respondents: number;
  minimumRespondents: number;
  questions: {
    questionId: string;
    position: number;
    prompt: LocalizedText;
    type: 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'RATING';
    validAnswers: number;
    shareable: boolean;
    options: { optionId: string; code: string; label: LocalizedText; count: number; percentage: number | null }[];
    ratingMean: number | null;
  }[];
}

/** Format a shared snapshot as chunked text messages, preserving question context. */
export function formatResultsChunks(aggregate: SnapshotAggregate, organizationName: string, locale = 'en'): string[] {
  const title = pickLocale(aggregate.surveyTitle, locale);
  const header = `Results of "${title}" shared by ${organizationName} (${aggregate.respondents} respondents). Aggregate information only; small groups are not shown.`;
  const blocks: string[] = [];
  for (const question of aggregate.questions) {
    const lines = [`Q${question.position + 1}. ${pickLocale(question.prompt, locale)}`];
    if (!question.shareable) {
      lines.push('Not enough responses to share this question\'s results.');
    } else {
      for (const option of question.options) {
        const pct = option.percentage === null ? 'N/A' : `${option.percentage.toFixed(1)}%`;
        lines.push(`- ${pickLocale(option.label, locale)}: ${pct} (${option.count})`);
      }
      if (question.type === 'MULTI_CHOICE') lines.push('(Multiple selection: percentages may add up to more than 100%.)');
      if (question.type === 'RATING' && question.ratingMean !== null) lines.push(`Average rating: ${question.ratingMean.toFixed(2)}`);
      lines.push(`Based on ${question.validAnswers} answers.`);
    }
    blocks.push(lines.join('\n'));
  }
  const limit = WHATSAPP_LIMITS.resultsChunk.chars;
  const chunks: string[] = [];
  let current = header;
  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > limit && current !== header) {
      chunks.push(current);
      current = `Results of "${title}" (continued)\n\n${block}`;
    } else if (candidate.length > limit) {
      chunks.push(current);
      current = block.length > limit ? `${block.slice(0, limit - 1)}…` : block;
    } else {
      current = candidate;
    }
  }
  chunks.push(current);
  const total = chunks.length;
  return total === 1 ? chunks : chunks.map((chunk, index) => `(${index + 1}/${total}) ${chunk}`);
}

import { formatResultsChunks, type SnapshotAggregate } from '../results-text';

describe('results text', () => {
  it('chunks long summaries while preserving question context', () => {
    const aggregate: SnapshotAggregate = {
      formatVersion: 1,
      surveyTitle: { en: 'Transport survey' },
      generatedAt: '2026-10-07T00:00:00Z',
      respondents: 42,
      minimumRespondents: 5,
      questions: Array.from({ length: 12 }, (_, index) => ({
        questionId: `q${index}`,
        position: index,
        prompt: { en: `Question ${index + 1} with a reasonably long prompt text to push the chunk size over the limit?` },
        type: 'MULTI_CHOICE' as const,
        validAnswers: 40,
        shareable: index !== 3,
        options: Array.from({ length: 6 }, (_, o) => ({ optionId: `o${o}`, code: `OPT_${o}`, label: { en: `Option number ${o + 1}` }, count: 10 + o, percentage: 25 + o })),
        ratingMean: null,
      })),
    };
    const chunks = formatResultsChunks(aggregate, 'PILAP');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1500 + 12)).toBe(true);
    expect(chunks[0]).toContain('Results of "Transport survey" shared by PILAP (42 respondents)');
    expect(chunks.join('\n')).toContain("Not enough responses to share this question's results.");
    expect(chunks[1]).toContain('(continued)');
  });
});

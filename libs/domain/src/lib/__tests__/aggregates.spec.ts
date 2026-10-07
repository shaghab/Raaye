import { computeBreakdown, computeQuestionResults, rate, share, type QuestionShape } from '../aggregates';

const questions: QuestionShape[] = [
  {
    id: 'q1',
    position: 0,
    type: 'SINGLE_CHOICE',
    prompt: { en: 'Q1' },
    options: [
      { id: 'a', code: 'YES', label: { en: 'Yes' }, ratingValue: null },
      { id: 'b', code: 'NO', label: { en: 'No' }, ratingValue: null },
    ],
  },
  {
    id: 'q2',
    position: 1,
    type: 'MULTI_CHOICE',
    prompt: { en: 'Q2' },
    options: [
      { id: 'c', code: 'OPT_1', label: { en: 'C' }, ratingValue: null },
      { id: 'd', code: 'OPT_2', label: { en: 'D' }, ratingValue: null },
      { id: 'e', code: 'OPT_3', label: { en: 'E' }, ratingValue: null },
    ],
  },
  {
    id: 'q3',
    position: 2,
    type: 'RATING',
    prompt: { en: 'Q3' },
    options: [1, 2, 3, 4, 5].map((value) => ({ id: `r${value}`, code: `R${value}`, label: { en: String(value) }, ratingValue: value })),
  },
];

const rows = [
  { participationId: 'p1', questionId: 'q1', optionId: 'a', ratingValue: null },
  { participationId: 'p2', questionId: 'q1', optionId: 'a', ratingValue: null },
  { participationId: 'p3', questionId: 'q1', optionId: 'b', ratingValue: null },
  { participationId: 'p1', questionId: 'q2', optionId: 'c', ratingValue: null },
  { participationId: 'p1', questionId: 'q2', optionId: 'd', ratingValue: null },
  { participationId: 'p2', questionId: 'q2', optionId: 'c', ratingValue: null },
  { participationId: 'p1', questionId: 'q3', optionId: 'r5', ratingValue: 5 },
  { participationId: 'p2', questionId: 'q3', optionId: 'r3', ratingValue: 3 },
];

describe('aggregates (R46, R47)', () => {
  it('counts unique respondents per option with respondent denominators', () => {
    const results = computeQuestionResults(questions, rows, 4);
    expect(results[0].validAnswers).toBe(3);
    expect(results[0].unansweredAmongStarted).toBe(1);
    expect(results[0].options.map((option) => [option.count, option.percentage])).toEqual([
      [2, 66.7],
      [1, 33.3],
    ]);
    expect(results[1].validAnswers).toBe(2);
    expect(results[1].options.map((option) => [option.count, option.percentage])).toEqual([
      [2, 100],
      [1, 50],
      [0, 0],
    ]);
    expect(results[1].percentagesMaySumOver100).toBe(true);
    expect(results[2].ratingMean).toBe(4);
    expect(results[2].options.find((option) => option.optionId === 'r1')?.count).toBe(0);
  });

  it('shows N/A for zero denominators and caps rates at 100', () => {
    expect(rate(0, 0)).toBeNull();
    expect(share(0, 0)).toBeNull();
    expect(rate(5, 4)).toBe(100);
    expect(rate(1, 3)).toBe(33.3);
    const empty = computeQuestionResults(questions, [], 0);
    expect(empty[0].options[0].percentage).toBeNull();
  });

  it('suppresses whole small cohorts for non-admin breakdowns (R48)', () => {
    const cohortOf = new Map([
      ['p1', 'Lahore'],
      ['p2', 'Lahore'],
      ['p3', '__unknown__'],
    ]);
    const breakdown = computeBreakdown({ questions, rows, cohortOf, dimension: 'city', threshold: 2, applyThreshold: true });
    const q1 = breakdown[0];
    expect(q1.cohorts.map((cohort) => [cohort.label, cohort.respondents, cohort.suppressed])).toEqual([
      ['Lahore', 2, false],
      ['Unknown / not provided', null, true],
    ]);
    expect(q1.cohorts[1].options).toEqual([]);
    const admin = computeBreakdown({ questions, rows, cohortOf, dimension: 'city', threshold: 2, applyThreshold: false });
    expect(admin[0].cohorts[1]).toMatchObject({ respondents: 1, suppressed: false });
  });
});

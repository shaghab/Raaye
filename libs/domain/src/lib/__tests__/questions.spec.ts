import type { QuestionInput } from '@raaye/contracts';
import { normalizeQuestion, planRenderer, validateQuestions, validateSelection } from '../questions';

const q = (partial: Partial<QuestionInput> & Pick<QuestionInput, 'authoringType'>): QuestionInput => ({
  prompt: { en: 'Prompt?' },
  ...partial,
});

describe('question normalization and renderer planning (R20, R21)', () => {
  it('expands presets with fixed semantic codes', () => {
    const yesNo = normalizeQuestion(q({ authoringType: 'YES_NO_INDIFFERENT' }), 0);
    expect(yesNo.options.map((option) => option.code)).toEqual(['YES', 'NO', 'INDIFFERENT']);
    expect(yesNo.renderer).toBe('BUTTONS');
    const rating = normalizeQuestion(q({ authoringType: 'RATING' }), 1);
    expect(rating.options.map((option) => option.ratingValue)).toEqual([1, 2, 3, 4, 5]);
    expect(rating.renderer).toBe('LIST');
  });

  it('routes single-choice by option count and label length', () => {
    const three = normalizeQuestion(q({ authoringType: 'SINGLE_CHOICE', options: [{ label: { en: 'A' } }, { label: { en: 'B' } }, { label: { en: 'C' } }] }), 0);
    expect(three.renderer).toBe('BUTTONS');
    const four = normalizeQuestion(
      q({ authoringType: 'SINGLE_CHOICE', options: ['A', 'B', 'C', 'D'].map((label) => ({ label: { en: label } })) }),
      0,
    );
    expect(four.renderer).toBe('LIST');
    const longButton = normalizeQuestion(
      q({ authoringType: 'SINGLE_CHOICE', options: [{ label: { en: 'A label that is 23 ch' } }, { label: { en: 'B' } }] }),
      0,
    );
    expect(longButton.renderer).toBe('LIST');
    const longList = normalizeQuestion(
      q({ authoringType: 'SINGLE_CHOICE', options: [{ label: { en: 'A label that is definitely longer than twenty four' } }, { label: { en: 'B' } }] }),
      0,
    );
    expect(longList.renderer).toBe('FLOW_SINGLE');
    expect(planRenderer({ type: 'MULTI_CHOICE', options: [] })).toBe('FLOW_MULTI');
  });

  it('reports specific authoring errors', () => {
    const { errors } = validateQuestions([
      q({ authoringType: 'SINGLE_CHOICE', options: [{ label: { en: 'Same' } }, { label: { en: 'same' } }] }),
      q({ authoringType: 'MULTI_CHOICE', options: [{ label: { en: 'A' } }, { label: { en: 'B' } }], minSelections: 3, maxSelections: 2 }),
      q({ authoringType: 'SINGLE_CHOICE', options: [{ label: { en: 'x'.repeat(40) } }, { label: { en: 'B' } }] }),
    ]);
    expect(errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(['OPTION_LABEL_DUPLICATE', 'SELECTION_LIMITS_INVALID', 'OPTION_LABEL_TOO_LONG']),
    );
    const long = errors.find((error) => error.code === 'OPTION_LABEL_TOO_LONG');
    expect(long?.message).toContain('short label');
  });

  it('validates multi-select sets with min/max and exclusive rules', () => {
    const question = normalizeQuestion(
      q({
        authoringType: 'MULTI_CHOICE',
        options: [
          { id: '11111111-1111-4111-8111-111111111111', label: { en: 'A' } },
          { id: '22222222-2222-4222-8222-222222222222', label: { en: 'B' } },
          { id: '33333333-3333-4333-8333-333333333333', label: { en: 'None of the above' }, exclusive: true },
        ],
        minSelections: 1,
        maxSelections: 2,
      }),
      0,
    );
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const none = '33333333-3333-4333-8333-333333333333';
    expect(validateSelection(question, [a, a, b])).toEqual({ ok: true, optionIds: [a, b], ratingValue: null });
    expect(validateSelection(question, [])).toMatchObject({ ok: false, code: 'SELECTION_COUNT_INVALID' });
    expect(validateSelection(question, [a, b, none])).toMatchObject({ ok: false, code: 'SELECTION_COUNT_INVALID' });
    expect(validateSelection(question, [a, none])).toMatchObject({ ok: false, code: 'SELECTION_COUNT_INVALID' });
    expect(validateSelection(question, [none])).toEqual({ ok: true, optionIds: [none], ratingValue: null });
    expect(validateSelection(question, ['44444444-4444-4444-8444-444444444444'])).toMatchObject({ ok: false, code: 'QUESTION_OPTION_INVALID' });
  });

  it('validates ratings as integers 1-5 with option identity', () => {
    const rating = normalizeQuestion(q({ authoringType: 'RATING' }), 0);
    rating.options.forEach((option, index) => (option.id = `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`));
    expect(validateSelection(rating, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'])).toEqual({
      ok: true,
      optionIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'],
      ratingValue: 5,
    });
    expect(validateSelection(rating, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'])).toMatchObject({ ok: false });
  });
});

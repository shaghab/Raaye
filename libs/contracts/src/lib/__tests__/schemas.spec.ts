import { audienceDefinitionSchema, contactListQuerySchema, launchRequestSchema, organizationUpdateSchema, questionInputSchema, surveyDraftSchema } from '../../index';

describe('shared contract schemas', () => {
  it('enforces option counts and selection limits per question type (R18, R23)', () => {
    expect(questionInputSchema.safeParse({ authoringType: 'YES_NO', prompt: { en: 'Q?' } }).success).toBe(true);
    expect(questionInputSchema.safeParse({ authoringType: 'YES_NO', prompt: { en: 'Q?' }, options: [{ label: { en: 'A' } }] }).success).toBe(false);
    expect(questionInputSchema.safeParse({ authoringType: 'SINGLE_CHOICE', prompt: { en: 'Q?' }, options: [{ label: { en: 'A' } }] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ label: { en: `Option ${i}` } }));
    expect(questionInputSchema.safeParse({ authoringType: 'SINGLE_CHOICE', prompt: { en: 'Q?' }, options: eleven }).success).toBe(false);
    const multi = { authoringType: 'MULTI_CHOICE', prompt: { en: 'Q?' }, options: [{ label: { en: 'A' } }, { label: { en: 'B' } }, { label: { en: 'None' }, exclusive: true }] };
    expect(questionInputSchema.safeParse({ ...multi, minSelections: 1, maxSelections: 2 }).success).toBe(true);
    expect(questionInputSchema.safeParse({ ...multi, minSelections: 3, maxSelections: 2 }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...multi, minSelections: 0 }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...multi, maxSelections: 5 }).success).toBe(false);
    expect(questionInputSchema.safeParse({ authoringType: 'RATING', prompt: { en: 'Q?' }, minSelections: 1 }).success).toBe(false);
    expect(questionInputSchema.safeParse({ authoringType: 'YES_NO', prompt: { en: 'Q?' }, ratingMinLabel: { en: 'x' } }).success).toBe(false);
    expect(questionInputSchema.safeParse({ authoringType: 'YES_NO', prompt: { ur: 'سوال' } }).success).toBe(false);
  });

  it('requires audience members for selected and group modes (R24)', () => {
    expect(audienceDefinitionSchema.safeParse({ mode: 'EVERYONE' }).success).toBe(true);
    expect(audienceDefinitionSchema.safeParse({ mode: 'SELECTED' }).success).toBe(false);
    expect(audienceDefinitionSchema.safeParse({ mode: 'SELECTED', contactIds: ['3e1f0f7c-6f5b-4e1d-9d0c-1a2b3c4d5e6f'] }).success).toBe(true);
    expect(audienceDefinitionSchema.safeParse({ mode: 'GROUPS_TAGS' }).success).toBe(false);
    const parsed = audienceDefinitionSchema.parse({ mode: 'GROUPS_TAGS', tagIds: ['3e1f0f7c-6f5b-4e1d-9d0c-1a2b3c4d5e6f'] });
    expect(parsed.groupTagMatch).toBe('ANY');
  });

  it('coerces list query parameters from strings (R11)', () => {
    const query = contactListQuerySchema.parse({ limit: '50', offset: '25', consentStatus: 'GRANTED', gender: ['WOMAN', 'MAN'], archived: 'true' });
    expect(query).toMatchObject({ limit: 50, offset: 25, consentStatus: ['GRANTED'], gender: ['WOMAN', 'MAN'], archived: true });
    expect(contactListQuerySchema.parse({}).archived).toBe(false);
    expect(contactListQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });

  it('validates launch requests and Admin timing ranges (R25, R26)', () => {
    expect(launchRequestSchema.safeParse({ mode: 'NOW' }).success).toBe(true);
    expect(launchRequestSchema.safeParse({ mode: 'SCHEDULED', opensAt: '2026-10-11T04:00:00Z' }).success).toBe(true);
    expect(launchRequestSchema.safeParse({ mode: 'SCHEDULED', opensAt: 'tomorrow' }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ defaultDurationSeconds: 1800 }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ defaultEditWindowSeconds: 3601 }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ defaultDurationSeconds: 3600, defaultEditWindowSeconds: 0 }).success).toBe(true);
    expect(surveyDraftSchema.safeParse({ internalTitle: 'x', title: { en: 't' }, introduction: { en: 'i' }, questions: [], audience: { mode: 'EVERYONE' } }).success).toBe(false);
  });
});

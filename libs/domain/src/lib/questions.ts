import {
  LIMITS,
  WHATSAPP_LIMITS,
  pickLocale,
  type AuthoringType,
  type ContentErrorDto,
  type LocalizedText,
  type OptionInput,
  type QuestionInput,
  type QuestionPreset,
  type QuestionType,
  type Renderer,
} from '@raaye/contracts';

export interface NormalizedOption {
  id: string | null;
  code: string;
  position: number;
  label: LocalizedText;
  shortLabel: LocalizedText | null;
  ratingValue: number | null;
  exclusive: boolean;
}

export interface NormalizedQuestion {
  id: string | null;
  position: number;
  type: QuestionType;
  preset: QuestionPreset;
  authoringType: AuthoringType;
  prompt: LocalizedText;
  minSelections: number | null;
  maxSelections: number | null;
  ratingMinLabel: LocalizedText | null;
  ratingMaxLabel: LocalizedText | null;
  options: NormalizedOption[];
  renderer: Renderer;
}

export const PRESET_OPTIONS: Record<'YES_NO' | 'YES_NO_INDIFFERENT', { code: string; label: LocalizedText }[]> = {
  YES_NO: [
    { code: 'YES', label: { en: 'Yes' } },
    { code: 'NO', label: { en: 'No' } },
  ],
  YES_NO_INDIFFERENT: [
    { code: 'YES', label: { en: 'Yes' } },
    { code: 'NO', label: { en: 'No' } },
    { code: 'INDIFFERENT', label: { en: 'Indifferent' } },
  ],
};

export function authoringTypeOf(type: QuestionType, preset: QuestionPreset): AuthoringType {
  if (type === 'RATING') return 'RATING';
  if (type === 'MULTI_CHOICE') return 'MULTI_CHOICE';
  if (preset === 'YES_NO') return 'YES_NO';
  if (preset === 'YES_NO_INDIFFERENT') return 'YES_NO_INDIFFERENT';
  return 'SINGLE_CHOICE';
}

export function visibleLabel(option: { label: LocalizedText; shortLabel: LocalizedText | null }, locale = 'en'): string {
  return pickLocale(option.shortLabel, locale) || pickLocale(option.label, locale);
}

export function fullLabel(option: { label: LocalizedText }, locale = 'en'): string {
  return pickLocale(option.label, locale);
}

/**
 * Renderer routing (section 11.1): buttons for 2-3 short single-choice options, a list
 * for 4-10, a five-row list for ratings, a checkbox Flow for multi-select and a radio
 * Flow for single-choice content that native controls cannot display.
 */
export function planRenderer(question: Pick<NormalizedQuestion, 'type' | 'options'>, locale = 'en'): Renderer {
  if (question.type === 'MULTI_CHOICE') return 'FLOW_MULTI';
  if (question.type === 'RATING') return 'LIST';
  const visibles = question.options.map((option) => visibleLabel(option, locale));
  const fulls = question.options.map((option) => fullLabel(option, locale));
  const count = question.options.length;
  const fitsList =
    count <= WHATSAPP_LIMITS.list.maxRows &&
    visibles.every((label) => label.length <= WHATSAPP_LIMITS.list.rowTitleChars) &&
    fulls.every((label) => label.length <= WHATSAPP_LIMITS.list.rowDescriptionChars);
  if (count <= WHATSAPP_LIMITS.replyButtons.max) {
    if (visibles.every((label) => label.length <= WHATSAPP_LIMITS.replyButtons.titleChars)) return 'BUTTONS';
    if (fitsList) return 'LIST';
    return 'FLOW_SINGLE';
  }
  return fitsList ? 'LIST' : 'FLOW_SINGLE';
}

function nextOptionCode(existing: Set<string>): string {
  let n = 1;
  while (existing.has(`OPT_${n}`)) n += 1;
  const code = `OPT_${n}`;
  existing.add(code);
  return code;
}

export function normalizeQuestion(input: QuestionInput, position: number): NormalizedQuestion {
  const base = {
    id: input.id ?? null,
    position,
    authoringType: input.authoringType,
    prompt: input.prompt,
    ratingMinLabel: null as LocalizedText | null,
    ratingMaxLabel: null as LocalizedText | null,
    minSelections: null as number | null,
    maxSelections: null as number | null,
  };
  if (input.authoringType === 'YES_NO' || input.authoringType === 'YES_NO_INDIFFERENT') {
    const options = PRESET_OPTIONS[input.authoringType].map((preset, index) => ({
      id: input.options?.[index]?.id ?? null,
      code: preset.code,
      position: index,
      label: preset.label,
      shortLabel: null,
      ratingValue: null,
      exclusive: false,
    }));
    const question = { ...base, type: 'SINGLE_CHOICE' as const, preset: input.authoringType, options, renderer: 'BUTTONS' as Renderer };
    return { ...question, renderer: planRenderer(question) };
  }
  if (input.authoringType === 'RATING') {
    const options = [1, 2, 3, 4, 5].map((value, index) => ({
      id: input.options?.[index]?.id ?? null,
      code: `R${value}`,
      position: index,
      label: { en: String(value) },
      shortLabel: null,
      ratingValue: value,
      exclusive: false,
    }));
    return {
      ...base,
      type: 'RATING',
      preset: 'CUSTOM',
      ratingMinLabel: input.ratingMinLabel ?? null,
      ratingMaxLabel: input.ratingMaxLabel ?? null,
      options,
      renderer: 'LIST',
    };
  }
  const codes = new Set<string>();
  for (const option of input.options ?? []) if (option.code) codes.add(option.code);
  const options: NormalizedOption[] = (input.options ?? []).map((option: OptionInput, index) => ({
    id: option.id ?? null,
    code: option.code ?? nextOptionCode(codes),
    position: index,
    label: option.label,
    shortLabel: option.shortLabel ?? null,
    ratingValue: null,
    exclusive: input.authoringType === 'MULTI_CHOICE' ? Boolean(option.exclusive) : false,
  }));
  const type: QuestionType = input.authoringType === 'MULTI_CHOICE' ? 'MULTI_CHOICE' : 'SINGLE_CHOICE';
  const question = {
    ...base,
    type,
    preset: 'CUSTOM' as const,
    options,
    minSelections: type === 'MULTI_CHOICE' ? (input.minSelections ?? 1) : null,
    maxSelections: type === 'MULTI_CHOICE' ? (input.maxSelections ?? options.length) : null,
    renderer: 'LIST' as Renderer,
  };
  return { ...question, renderer: planRenderer(question) };
}

/** Validate authored content and its planned delivery format. Returns specific errors. */
export function validateQuestions(questions: QuestionInput[], locale = 'en'): { normalized: NormalizedQuestion[]; errors: ContentErrorDto[] } {
  const errors: ContentErrorDto[] = [];
  if (questions.length < LIMITS.questionsPerSurvey.min || questions.length > LIMITS.questionsPerSurvey.max) {
    errors.push({
      questionIndex: null,
      optionIndex: null,
      code: 'QUESTION_COUNT',
      message: `A survey needs between ${LIMITS.questionsPerSurvey.min} and ${LIMITS.questionsPerSurvey.max} questions`,
    });
  }
  const normalized = questions.map((question, index) => normalizeQuestion(question, index));
  normalized.forEach((question, questionIndex) => {
    const prompt = pickLocale(question.prompt, locale);
    if (!prompt.trim()) {
      errors.push({ questionIndex, optionIndex: null, code: 'PROMPT_REQUIRED', message: 'Question text is required' });
    } else if (prompt.length > WHATSAPP_LIMITS.body.chars) {
      errors.push({
        questionIndex,
        optionIndex: null,
        code: 'PROMPT_TOO_LONG',
        message: `Question text must be at most ${WHATSAPP_LIMITS.body.chars} characters`,
      });
    }
    if (question.type !== 'RATING') {
      if (question.options.length < LIMITS.optionsPerQuestion.min || question.options.length > LIMITS.optionsPerQuestion.max) {
        errors.push({
          questionIndex,
          optionIndex: null,
          code: 'OPTION_COUNT',
          message: `Provide between ${LIMITS.optionsPerQuestion.min} and ${LIMITS.optionsPerQuestion.max} options`,
        });
      }
    }
    const seenVisible = new Map<string, number>();
    const seenCodes = new Map<string, number>();
    question.options.forEach((option, optionIndex) => {
      const visible = visibleLabel(option, locale);
      const full = fullLabel(option, locale);
      if (!full.trim()) {
        errors.push({ questionIndex, optionIndex, code: 'OPTION_LABEL_REQUIRED', message: 'Option text is required' });
      }
      const visibleKey = visible.trim().toLowerCase();
      if (seenVisible.has(visibleKey)) {
        errors.push({
          questionIndex,
          optionIndex,
          code: 'OPTION_LABEL_DUPLICATE',
          message: `Visible label "${visible}" is also used by option ${(seenVisible.get(visibleKey) ?? 0) + 1}`,
        });
      } else {
        seenVisible.set(visibleKey, optionIndex);
      }
      if (seenCodes.has(option.code)) {
        errors.push({ questionIndex, optionIndex, code: 'OPTION_CODE_DUPLICATE', message: `Option code ${option.code} is duplicated` });
      } else {
        seenCodes.set(option.code, optionIndex);
      }
      const limit = rendererLabelLimit(question.renderer);
      if (visible.length > limit) {
        errors.push({
          questionIndex,
          optionIndex,
          code: 'OPTION_LABEL_TOO_LONG',
          message: `Label "${visible}" exceeds ${limit} characters for the ${rendererName(question.renderer)}; add a short label of at most ${limit} characters`,
        });
      }
      if ((question.renderer === 'FLOW_SINGLE' || question.renderer === 'FLOW_MULTI') && full.length > WHATSAPP_LIMITS.flowItem.descriptionChars) {
        errors.push({
          questionIndex,
          optionIndex,
          code: 'OPTION_LABEL_TOO_LONG',
          message: `Option text exceeds ${WHATSAPP_LIMITS.flowItem.descriptionChars} characters`,
        });
      }
      if (option.exclusive && question.type !== 'MULTI_CHOICE') {
        errors.push({ questionIndex, optionIndex, code: 'EXCLUSIVE_NOT_ALLOWED', message: 'Exclusive options apply to multiple selection only' });
      }
    });
    if (question.type === 'MULTI_CHOICE') {
      const min = question.minSelections ?? 1;
      const max = question.maxSelections ?? question.options.length;
      if (min < 1 || min > max || max > question.options.length) {
        errors.push({ questionIndex, optionIndex: null, code: 'SELECTION_LIMITS_INVALID', message: 'Selection limits must satisfy 1 <= min <= max <= option count' });
      }
    }
    if (question.type === 'RATING') {
      for (const [key, label] of [['ratingMinLabel', question.ratingMinLabel], ['ratingMaxLabel', question.ratingMaxLabel]] as const) {
        const text = pickLocale(label, locale);
        if (text.length > WHATSAPP_LIMITS.list.rowDescriptionChars) {
          errors.push({ questionIndex, optionIndex: null, code: 'RATING_LABEL_TOO_LONG', message: `${key} must be at most ${WHATSAPP_LIMITS.list.rowDescriptionChars} characters` });
        }
      }
    }
  });
  return { normalized, errors };
}

export function rendererLabelLimit(renderer: Renderer): number {
  switch (renderer) {
    case 'BUTTONS':
      return WHATSAPP_LIMITS.replyButtons.titleChars;
    case 'LIST':
      return WHATSAPP_LIMITS.list.rowTitleChars;
    default:
      return WHATSAPP_LIMITS.flowItem.titleChars;
  }
}

export function rendererName(renderer: Renderer): string {
  switch (renderer) {
    case 'BUTTONS':
      return 'reply buttons';
    case 'LIST':
      return 'list';
    case 'FLOW_SINGLE':
      return 'single-choice form';
    case 'FLOW_MULTI':
      return 'multiple-selection form';
  }
}

export type SelectionValidation =
  | { ok: true; optionIds: string[]; ratingValue: number | null }
  | { ok: false; code: 'QUESTION_OPTION_INVALID' | 'SELECTION_COUNT_INVALID'; message: string };

/**
 * Validate a submitted selection set against the question's options and rules.
 * Duplicate option ids are collapsed before min/max/exclusive checks.
 */
export function validateSelection(
  question: Pick<NormalizedQuestion, 'type' | 'options' | 'minSelections' | 'maxSelections'>,
  submittedOptionIds: readonly string[],
): SelectionValidation {
  const distinct = Array.from(new Set(submittedOptionIds));
  const byId = new Map(question.options.map((option) => [option.id ?? option.code, option]));
  for (const id of distinct) {
    if (!byId.has(id)) return { ok: false, code: 'QUESTION_OPTION_INVALID', message: 'Unknown option for this question' };
  }
  if (question.type === 'MULTI_CHOICE') {
    const min = question.minSelections ?? 1;
    const max = question.maxSelections ?? question.options.length;
    if (distinct.length < min || distinct.length > max) {
      return { ok: false, code: 'SELECTION_COUNT_INVALID', message: `Select between ${min} and ${max} options` };
    }
    const exclusiveSelected = distinct.filter((id) => byId.get(id)?.exclusive);
    if (exclusiveSelected.length > 0 && distinct.length > 1) {
      return { ok: false, code: 'SELECTION_COUNT_INVALID', message: 'An exclusive option cannot be combined with other options' };
    }
    return { ok: true, optionIds: distinct, ratingValue: null };
  }
  if (distinct.length !== 1) {
    return { ok: false, code: 'SELECTION_COUNT_INVALID', message: 'Exactly one option is required' };
  }
  const option = byId.get(distinct[0]);
  if (question.type === 'RATING') {
    const value = option?.ratingValue ?? null;
    if (value === null || !Number.isInteger(value) || value < LIMITS.ratingValues.min || value > LIMITS.ratingValues.max) {
      return { ok: false, code: 'QUESTION_OPTION_INVALID', message: 'Rating must be an integer from 1 to 5' };
    }
    return { ok: true, optionIds: distinct, ratingValue: value };
  }
  return { ok: true, optionIds: distinct, ratingValue: null };
}

export function selectionsEqual(a: readonly string[], b: readonly string[]): boolean {
  const left = Array.from(new Set(a)).sort();
  const right = Array.from(new Set(b)).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

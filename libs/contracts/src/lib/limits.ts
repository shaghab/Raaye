// Raaye implementation defaults and guardrails. Unless marked as a platform
// restriction these are product limits chosen for the MVP, centralized so API,
// UI and tests enforce the same numbers.

export const LIMITS = {
  questionsPerSurvey: { min: 1, max: 20 },
  optionsPerQuestion: { min: 2, max: 10 },
  ratingValues: { min: 1, max: 5 },
  editWindowSeconds: { default: 120, min: 0, max: 3600 },
  durationSeconds: { default: 48 * 3600, min: 3600, max: 30 * 24 * 3600 },
  contactName: { max: 150 },
  occupation: { max: 120 },
  internalTitle: { max: 150 },
  surveyTitle: { max: 120 },
  introduction: { max: 1024 },
  questionPrompt: { max: 1024 },
  optionLabel: { max: 100 },
  importFile: { maxBytes: 5 * 1024 * 1024, maxRows: 10_000 },
  pagination: { default: 25, max: 100 },
  cohortThreshold: 5,
  shareMinRespondents: 5,
  staffInvitationHours: 72,
  importStagingHours: 24,
  rawWebhookDays: 7,
  serviceWindowHours: 24,
  actionBindingDays: 45,
  menuPageSize: 9,
} as const;

/**
 * WhatsApp interactive message limits (platform restrictions, verified against the
 * Cloud API documentation available at implementation time; recheck before live use).
 */
export const WHATSAPP_LIMITS = {
  replyButtons: { max: 3, titleChars: 20 },
  list: { maxRows: 10, rowTitleChars: 24, rowDescriptionChars: 72, buttonChars: 20, sectionTitleChars: 24 },
  body: { chars: 1024 },
  header: { chars: 60 },
  footer: { chars: 60 },
  flowCta: { chars: 20 },
  flowItem: { titleChars: 30, descriptionChars: 300 },
  textMessage: { chars: 4096 },
  resultsChunk: { chars: 1500 },
} as const;

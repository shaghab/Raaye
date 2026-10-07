import { WHATSAPP_LIMITS, type LocalizedText, pickLocale } from '@raaye/contracts';

/**
 * Participant-facing English copy. Every function takes the organization name so the
 * text is attributable; nothing here hard-codes a tenant. Locale-ready: callers pass the
 * locale and content maps, and additional locales can be added without schema changes.
 */
export interface OrgCopyContext {
  organizationName: string;
  supportContact: string | null;
  privacyUrl: string | null;
}

export const copy = {
  invitation(org: OrgCopyContext, surveyTitle: string): string {
    return `${org.organizationName} invites you to a short, voluntary survey: "${surveyTitle}". Taking part is optional and you can stop at any time by replying STOP.`;
  },
  invitationButton: 'Start survey',
  introduction(org: OrgCopyContext, title: LocalizedText, introduction: LocalizedText, questionCount: number, editWindowSeconds: number, locale: string): string {
    const parts = [`${pickLocale(title, locale)}`, pickLocale(introduction, locale)];
    parts.push(`${questionCount} question${questionCount === 1 ? '' : 's'}, one at a time.`);
    if (editWindowSeconds > 0) {
      parts.push(`You can change an answer within ${describeSeconds(editWindowSeconds)} of giving it by tapping another option or replying EDIT.`);
    }
    parts.push(`Authorized ${org.organizationName} administrators can see your individual answers. Reply STOP at any time to stop messages.`);
    return parts.filter(Boolean).join('\n\n');
  },
  profileOffer(org: OrgCopyContext): string {
    return `To help ${org.organizationName} understand the results, you may share a few optional details about yourself. You can skip this and still take the survey.`;
  },
  profileOfferAccept: 'Add details',
  profileOfferSkip: 'Skip',
  profileSaved: 'Thank you, your details were saved. You can update them any time by replying PROFILE.',
  profileSkipped: 'No problem. You can add details later by replying PROFILE.',
  questionHeader(position: number, total: number): string {
    return `Question ${position} of ${total}`;
  },
  instruction(renderer: 'BUTTONS' | 'LIST' | 'FLOW_SINGLE' | 'FLOW_MULTI'): string {
    switch (renderer) {
      case 'BUTTONS':
        return 'Tap one option.';
      case 'LIST':
        return 'Choose one option from the list.';
      case 'FLOW_SINGLE':
        return 'Open the form and choose one option.';
      case 'FLOW_MULTI':
        return 'Open the form and select all that apply, then submit.';
    }
  },
  listButton: 'Choose',
  flowButton: 'Open form',
  recorded: 'Response recorded.',
  completion: 'Thank you. Your response has been recorded.',
  completionEditHint(editWindowSeconds: number): string {
    return editWindowSeconds > 0
      ? `You can still change a recent answer within ${describeSeconds(editWindowSeconds)} of giving it by replying EDIT.`
      : '';
  },
  editExpired: 'The time to change this answer has ended. Your earlier response remains recorded.',
  surveyClosed(surveyTitle: string): string {
    return `The survey "${surveyTitle}" has closed. Your recorded answers remain unchanged. Thank you for taking part.`;
  },
  surveyNotOpen: 'This survey is not open yet. We will message you when it starts.',
  answerUnchanged: 'That answer is already recorded.',
  staleReply: 'A newer answer was already recorded for this question.',
  invalidSelection(message: string): string {
    return `We could not record that selection: ${message}`;
  },
  help(org: OrgCopyContext): string {
    const lines = [
      `This is Raaye, a survey bot from ${org.organizationName}.`,
      'Commands: START to see open surveys, RESUME to continue, EDIT to change a recent answer, PROFILE to update optional details, RESULTS to see shared results, STOP to stop messages.',
    ];
    if (org.supportContact) lines.push(`Human support: ${org.supportContact}`);
    if (org.privacyUrl) lines.push(`Privacy information: ${org.privacyUrl}`);
    return lines.join('\n');
  },
  stopAck(org: OrgCopyContext): string {
    const support = org.supportContact ? ` For privacy or erasure requests contact ${org.supportContact}.` : '';
    return `You will no longer receive survey messages from ${org.organizationName}. Answers you already gave remain recorded.${support} Reply START if you change your mind.`;
  },
  consentPrompt(org: OrgCopyContext, notice: string): string {
    return `${notice}\n\nReply YES to agree to receive survey invitations and results from ${org.organizationName}, or NO to decline.`;
  },
  consentAccept: 'I agree',
  consentDecline: 'No thanks',
  consentGranted(org: OrgCopyContext): string {
    return `Thank you. You will hear from ${org.organizationName} when a survey opens. Reply STOP at any time to stop.`;
  },
  consentDeclined: 'Understood. We will not send you survey invitations. Reply START if you change your mind.',
  enrollmentAskName(org: OrgCopyContext): string {
    return `Welcome to ${org.organizationName}'s survey service. To get started, please reply with your name.`;
  },
  enrollmentConfirmName(name: string): string {
    return `Should we use the name "${name}"? Reply YES to confirm or send a different name.`;
  },
  enrollmentNameInvalid: 'Please reply with your name (1-150 characters).',
  noOpenSurveys(org: OrgCopyContext): string {
    return `There are no open surveys from ${org.organizationName} for you right now.`;
  },
  openSurveysMenu: 'Which survey would you like to open?',
  continueOrSwitch(currentTitle: string, otherTitle: string): string {
    return `You are in the middle of "${currentTitle}". Would you like to continue it or switch to "${otherTitle}"? Your answers are kept either way.`;
  },
  continueButton: 'Continue current',
  switchButton: 'Switch survey',
  resumeNothing: 'There is nothing to resume. Reply START to see open surveys.',
  alreadyCompleted(surveyTitle: string): string {
    return `You have already completed "${surveyTitle}". Thank you!`;
  },
  editMenu: 'Which answer would you like to change?',
  editNothing: 'There are no answers you can still change.',
  editQuestionNotEditable: 'That answer can no longer be changed.',
  resultsNone: 'No shared results are available for you yet.',
  resultsMenu: 'Which results would you like to see?',
  resultsAvailable(org: OrgCopyContext, surveyTitle: string): string {
    return `${org.organizationName} has shared the aggregate results of "${surveyTitle}". Tap View results to see them.`;
  },
  resultsButton: 'View results',
  unrecognized: 'Sorry, we did not understand that. Use the buttons or list in the last message, or reply HELP for commands.',
  windowClosed: 'Reply RESUME to continue your survey.',
  notEligible: 'This action is no longer available.',
  pageNext: 'Next page',
  testLabel: '[TEST]',
};

export function describeSeconds(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${seconds} seconds`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function bodyLimit(text: string): string {
  return truncate(text, WHATSAPP_LIMITS.body.chars);
}

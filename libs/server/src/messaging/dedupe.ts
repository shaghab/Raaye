/**
 * Dedupe keys of every message about shared results start with this prefix (result notices,
 * result content, the results menu and results replies), so a withdrawal of survey invitations
 * alone can leave them untouched while cancelling everything else that is queued.
 */
export const RESULTS_KEY_PREFIX = 'results-';

/** Dedupe key for a reply about shared results (the menu, the "none shared" and "not eligible" texts). */
export function resultsReplyKey(tag: 'menu' | 'none' | 'denied', eventId: string): string {
  return `${RESULTS_KEY_PREFIX}${tag}:${eventId}`;
}

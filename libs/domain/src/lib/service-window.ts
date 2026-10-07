import { LIMITS } from '@raaye/contracts';

/**
 * Free-form (non-template) messages may only be sent inside the provider's customer
 * service window, measured from the most recent verified inbound user message.
 * Outbound templates never open the window.
 */
export function isServiceWindowOpen(lastInboundAt: Date | null | undefined, now: Date): boolean {
  if (!lastInboundAt) return false;
  const elapsedMs = now.getTime() - lastInboundAt.getTime();
  return elapsedMs >= 0 && elapsedMs < LIMITS.serviceWindowHours * 3600 * 1000;
}

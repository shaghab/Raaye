import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import type { ProviderAdapter, SendRequest, SendResult } from "./provider";

export interface SimulatorFaults {
  /** Applies to the next send only. */
  nextSendOutcome?: 'ACCEPTED' | 'FAILED_TEMPORARY' | 'FAILED_PERMANENT' | 'TIMEOUT';
  /** Every send to this contact fails permanently until cleared. */
  failForContactId?: string | null;
  /** Every send to this contact times out with an unknown outcome until cleared. */
  timeoutForContactId?: string | null;
  expireServiceWindowForContactId?: string | null;
}

/**
 * Local provider. It never contacts a network. Fault injection comes from the persisted
 * simulator state so the simulator UI can exercise known failures and ambiguous sends.
 */
@Injectable()
export class MockMessagingProvider implements ProviderAdapter {
  readonly mode = 'mock' as const;

  constructor(private readonly prisma: PrismaService) {}

  async send(request: SendRequest): Promise<SendResult> {
    const faults = await this.consumeFaults();
    if (faults.failForContactId === request.contactId) return { outcome: 'FAILED', errorCode: 'MOCK_INVALID_RECIPIENT', retryable: false, detail: 'Simulated permanent failure for this contact' };
    if (faults.timeoutForContactId === request.contactId) return { outcome: 'UNKNOWN', errorCode: 'MOCK_TIMEOUT', detail: 'Simulated timeout for this contact after the request was transmitted' };
    const outcome = faults.nextSendOutcome ?? 'ACCEPTED';
    if (outcome === 'FAILED_TEMPORARY') return { outcome: 'FAILED', errorCode: 'MOCK_RATE_LIMIT', retryable: true, detail: 'Simulated temporary failure (rate limit)' };
    if (outcome === 'FAILED_PERMANENT') return { outcome: 'FAILED', errorCode: 'MOCK_INVALID_RECIPIENT', retryable: false, detail: 'Simulated permanent failure (invalid recipient)' };
    if (outcome === 'TIMEOUT') return { outcome: 'UNKNOWN', errorCode: 'MOCK_TIMEOUT', detail: 'Simulated timeout after the request was transmitted' };
    return { outcome: 'ACCEPTED', providerMessageId: `wamid.mock.${randomUUID()}` };
  }

  /** The next-send fault applies once; contact-scoped faults persist until cleared. */
  private async consumeFaults(): Promise<SimulatorFaults> {
    const state = await this.prisma.simulatorState.findUnique({ where: { id: 1 } });
    const faults = ((state?.faults as SimulatorFaults | null) ?? {}) as SimulatorFaults;
    if (faults.nextSendOutcome && faults.nextSendOutcome !== 'ACCEPTED') {
      const { nextSendOutcome, ...rest } = faults;
      await this.prisma.simulatorState.update({ where: { id: 1 }, data: { faults: rest as object } });
      return { ...rest, nextSendOutcome };
    }
    return faults;
  }
}

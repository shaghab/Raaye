import { Inject, Injectable } from '@nestjs/common';
import { generateToken, type Clock } from '@raaye/domain';
import { CLOCK } from '../clock/clock.service';
import type { ActionBinding, ActionMode, ActionPurpose } from '../persistence/prisma.service';
import type { TenantDb, TenantTx } from '../persistence/tenant-db';

export interface MintInput {
  organizationId: string;
  connectionId: string;
  contactId: string;
  purpose: ActionPurpose;
  mode: ActionMode;
  expiresAt: Date;
  runId?: string | null;
  participationId?: string | null;
  questionId?: string | null;
  optionId?: string | null;
  snapshotId?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Opaque action tokens bind a control to organization, connection, contact, run,
 * question/option or snapshot, mode and expiry. A control id is `<token>` or
 * `<token>.<optionId>` where the option is validated against the bound question.
 */
@Injectable()
export class ActionBindingService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async mint(tx: TenantTx, input: MintInput): Promise<{ id: string; token: string }> {
    const token = generateToken(24);
    const binding = await tx.actionBinding.create({
      data: {
        organizationId: input.organizationId,
        token,
        purpose: input.purpose,
        mode: input.mode,
        connectionId: input.connectionId,
        contactId: input.contactId,
        runId: input.runId ?? null,
        participationId: input.participationId ?? null,
        questionId: input.questionId ?? null,
        optionId: input.optionId ?? null,
        snapshotId: input.snapshotId ?? null,
        payload: input.payload ? (input.payload as object) : undefined,
        expiresAt: input.expiresAt,
      },
    });
    return { id: binding.id, token };
  }

  /** Resolve a token for a verified sender. Mismatched tenant/connection/contact or expiry yields null. */
  async resolve(db: TenantDb | TenantTx, token: string, expected: { connectionId: string; contactId: string }): Promise<ActionBinding | null> {
    if (!token || token.length > 128) return null;
    const binding = await db.actionBinding.findUnique({ where: { token } });
    if (!binding) return null;
    if (binding.connectionId !== expected.connectionId || binding.contactId !== expected.contactId) return null;
    if (binding.expiresAt.getTime() <= this.clock.now().getTime()) return null;
    return binding;
  }

  controlId(token: string, optionId?: string | null): string {
    return optionId ? `${token}.${optionId}` : token;
  }

  parseControlId(controlId: string): { token: string; optionId: string | null } {
    const index = controlId.indexOf('.');
    if (index === -1) return { token: controlId, optionId: null };
    return { token: controlId.slice(0, index), optionId: controlId.slice(index + 1) };
  }
}

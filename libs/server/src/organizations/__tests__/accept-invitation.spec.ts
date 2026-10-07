import { FixedClock, hashToken } from '@raaye/domain';
import type { AuditService } from '../../audit/audit.service';
import type { FirebaseAdminService } from '../../auth/token-verifier';
import type { AppConfig } from '../../config/env';
import type { PrismaService } from '../../persistence/prisma.service';
import type { TenantDbFactory } from '../../persistence/tenant-db.factory';
import { OrganizationService } from '../organization.service';

interface Scenario {
  /** What the conditional invitation update reports inside the transaction. */
  consumed?: number;
  /** A failure outside the domain refusals, such as a dropped connection during commit. */
  transactionError?: Error;
  /** The user row the database shows for the created identity after the failure. */
  userRow?: { id: string } | null;
  /** Who the database shows as having accepted the invitation after the failure. */
  acceptedByUserId?: string | null;
  /** The reconciliation read itself fails (database unreachable). */
  reconcileError?: Error;
}

/** Builds the service over in-memory stubs. */
function build(scenario: Scenario) {
  const token = 'token-123';
  const invitation = { id: 'inv-1', organizationId: 'org-1', email: 'new@example.org', role: 'VIEWER' as const, tokenHash: hashToken(token), expiresAt: new Date('2026-10-10T12:00:00.000Z'), acceptedAt: null, revokedAt: null };
  const calls: string[] = [];
  let transactions = 0;
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (strings.join('?').includes('staff_invitations')) {
        if (scenario.reconcileError) throw scenario.reconcileError;
        calls.push('lock-invitation');
      }
      return [];
    },
    staffInvitation: {
      updateMany: async () => ({ count: scenario.consumed ?? 1 }),
      update: async () => invitation,
      findUnique: async () => ({ acceptedByUserId: scenario.acceptedByUserId ?? null }),
    },
    user: { upsert: async () => ({ id: 'user-1' }), findUnique: async () => scenario.userRow ?? null },
    organizationMembership: { upsert: async () => ({}) },
    auditEvent: { create: async () => ({}) },
  };
  const prisma = {
    staffInvitation: { findUnique: async () => invitation },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      // The first transaction is the acceptance itself; a later one is the reconciliation read.
      if (transactions === 1 && scenario.transactionError) throw scenario.transactionError;
      return fn(tx);
    },
  };
  const firebase = {
    findUidByEmail: async () => null,
    createUser: async () => {
      calls.push('create');
      return 'uid-new';
    },
  };
  const service = new OrganizationService(
    prisma as unknown as PrismaService,
    {} as unknown as TenantDbFactory,
    {} as unknown as AuditService,
    firebase as unknown as FirebaseAdminService,
    new FixedClock(new Date('2026-10-10T09:00:00.000Z')),
    { WEB_ORIGIN: 'http://localhost:8080' } as unknown as AppConfig,
  );
  return { service, token, calls };
}

describe('invitation acceptance and the account it provisions', () => {
  const accept = (service: OrganizationService, token: string) => service.acceptInvitation({ token, password: 'Secret-Pass-1' }, null, 'corr');
  const dropped = new Error('Connection terminated unexpectedly');

  it('keeps the account and says so when the invitation can no longer be consumed', async () => {
    const { service, token, calls } = build({ consumed: 0, userRow: null });
    await expect(accept(service, token)).rejects.toMatchObject({ code: 'INVITATION_INVALID', details: { accountCreated: true }, message: expect.stringContaining('Your account was created') });
    expect(calls).toEqual(['create', 'lock-invitation']);
  });

  it('keeps the account when the acceptance completes', async () => {
    const { service, token, calls } = build({ consumed: 1 });
    await expect(accept(service, token)).resolves.toEqual({ email: 'new@example.org' });
    expect(calls).toEqual(['create']);
  });

  it('reports a plain refusal for an existing identity', async () => {
    const { service, token, calls } = build({ consumed: 0, userRow: null });
    await expect(service.acceptInvitation({ token }, { uid: 'uid-existing', email: 'new@example.org', emailVerified: true }, 'corr')).rejects.toMatchObject({ code: 'INVITATION_INVALID', message: 'This invitation is no longer valid' });
    expect(calls).toEqual(['lock-invitation']);
  });

  it('treats an ambiguous failure whose acceptance the database shows as persisted as a success', async () => {
    const { service, token, calls } = build({ transactionError: dropped, userRow: { id: 'user-1' }, acceptedByUserId: 'user-1' });
    await expect(accept(service, token)).resolves.toEqual({ email: 'new@example.org' });
    expect(calls).toEqual(['create', 'lock-invitation']);
  });

  it('rethrows an ambiguous failure that the database does not show as persisted, without touching the account', async () => {
    const noTrace = build({ transactionError: dropped, userRow: null });
    await expect(accept(noTrace.service, noTrace.token)).rejects.toBe(dropped);
    expect(noTrace.calls).toEqual(['create', 'lock-invitation']);
    const inconsistent = build({ transactionError: dropped, userRow: { id: 'user-1' }, acceptedByUserId: null });
    await expect(accept(inconsistent.service, inconsistent.token)).rejects.toBe(dropped);
    expect(inconsistent.calls).toEqual(['create', 'lock-invitation']);
    const unreachable = build({ transactionError: dropped, reconcileError: new Error('database unreachable') });
    await expect(accept(unreachable.service, unreachable.token)).rejects.toBe(dropped);
    expect(unreachable.calls).toEqual(['create']);
  });
});

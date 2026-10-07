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
  const tx = {
    $queryRaw: async () => [],
    staffInvitation: { updateMany: async () => ({ count: scenario.consumed ?? 1 }), update: async () => invitation },
    user: { upsert: async () => ({ id: 'user-1' }) },
    organizationMembership: { upsert: async () => ({}) },
    auditEvent: { create: async () => ({}) },
  };
  const prisma = {
    staffInvitation: {
      findUnique: async (args: { where: { tokenHash?: string; id?: string } }) => {
        if (scenario.reconcileError && args.where.id) throw scenario.reconcileError;
        return args.where.id ? { acceptedByUserId: scenario.acceptedByUserId ?? null } : invitation;
      },
    },
    user: {
      findUnique: async () => {
        if (scenario.reconcileError) throw scenario.reconcileError;
        return scenario.userRow ?? null;
      },
    },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      if (scenario.transactionError) throw scenario.transactionError;
      return fn(tx);
    },
  };
  const firebase = {
    findUidByEmail: async () => null,
    createUser: async () => {
      calls.push('create');
      return 'uid-new';
    },
    deleteUser: async () => {
      calls.push('delete');
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

  it('removes the account it created when the invitation can no longer be consumed', async () => {
    const { service, token, calls } = build({ consumed: 0 });
    await expect(accept(service, token)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    expect(calls).toEqual(['create', 'delete']);
  });

  it('keeps the account when the acceptance completes', async () => {
    const { service, token, calls } = build({ consumed: 1 });
    await expect(accept(service, token)).resolves.toEqual({ email: 'new@example.org' });
    expect(calls).toEqual(['create']);
  });

  it('never touches the account of an existing identity', async () => {
    const { service, token, calls } = build({ consumed: 0 });
    await expect(service.acceptInvitation({ token }, { uid: 'uid-existing', email: 'new@example.org', emailVerified: true }, 'corr')).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    expect(calls).toEqual([]);
  });

  it('treats an ambiguous failure whose acceptance the database shows as persisted as a success', async () => {
    const { service, token, calls } = build({ transactionError: dropped, userRow: { id: 'user-1' }, acceptedByUserId: 'user-1' });
    await expect(accept(service, token)).resolves.toEqual({ email: 'new@example.org' });
    expect(calls).toEqual(['create']);
  });

  it('removes the account after an ambiguous failure only when the database shows no trace of the acceptance', async () => {
    const { service, token, calls } = build({ transactionError: dropped, userRow: null });
    await expect(accept(service, token)).rejects.toBe(dropped);
    expect(calls).toEqual(['create', 'delete']);
  });

  it('keeps the account when the state after an ambiguous failure cannot be confirmed', async () => {
    const inconsistent = build({ transactionError: dropped, userRow: { id: 'user-1' }, acceptedByUserId: null });
    await expect(accept(inconsistent.service, inconsistent.token)).rejects.toBe(dropped);
    expect(inconsistent.calls).toEqual(['create']);
    const unreachable = build({ transactionError: dropped, reconcileError: new Error('database unreachable') });
    await expect(accept(unreachable.service, unreachable.token)).rejects.toBe(dropped);
    expect(unreachable.calls).toEqual(['create']);
  });
});

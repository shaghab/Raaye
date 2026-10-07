import { FixedClock, hashToken } from '@raaye/domain';
import type { AuditService } from '../../audit/audit.service';
import type { FirebaseAdminService } from '../../auth/token-verifier';
import type { AppConfig } from '../../config/env';
import type { PrismaService } from '../../persistence/prisma.service';
import type { TenantDbFactory } from '../../persistence/tenant-db.factory';
import { OrganizationService } from '../organization.service';

/** Builds the service over in-memory stubs; `consumed` is what the conditional invitation update reports. */
function build(consumed: number) {
  const token = 'token-123';
  const invitation = { id: 'inv-1', organizationId: 'org-1', email: 'new@example.org', role: 'VIEWER' as const, tokenHash: hashToken(token), expiresAt: new Date('2026-10-10T12:00:00.000Z'), acceptedAt: null, revokedAt: null };
  const calls: string[] = [];
  const tx = {
    $queryRaw: async () => [],
    staffInvitation: { updateMany: async () => ({ count: consumed }), update: async () => invitation },
    user: { upsert: async () => ({ id: 'user-1' }) },
    organizationMembership: { upsert: async () => ({}) },
    auditEvent: { create: async () => ({}) },
  };
  const prisma = {
    staffInvitation: { findUnique: async () => invitation },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
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
  it('removes the account it created when the invitation can no longer be consumed', async () => {
    const { service, token, calls } = build(0);
    await expect(service.acceptInvitation({ token, password: 'Secret-Pass-1' }, null, 'corr')).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    expect(calls).toEqual(['create', 'delete']);
  });

  it('keeps the account when the acceptance completes', async () => {
    const { service, token, calls } = build(1);
    await expect(service.acceptInvitation({ token, password: 'Secret-Pass-1' }, null, 'corr')).resolves.toEqual({ email: 'new@example.org' });
    expect(calls).toEqual(['create']);
  });

  it('never touches the account of an existing identity', async () => {
    const { service, token, calls } = build(0);
    await expect(service.acceptInvitation({ token }, { uid: 'uid-existing', email: 'new@example.org', emailVerified: true }, 'corr')).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    expect(calls).toEqual([]);
  });
});

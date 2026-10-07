import type { PrismaClient } from './generated/client';

const TENANT_FREE_MODELS = new Set(['User', 'WebhookQuarantine', 'SimulatorState']);
const WHERE_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

type AnyArgs = Record<string, unknown>;

function scopeWhere(args: AnyArgs, organizationId: string): void {
  const where = (args['where'] as AnyArgs | undefined) ?? {};
  args['where'] = { ...where, organizationId };
}

function scopeData(data: unknown, organizationId: string): unknown {
  if (Array.isArray(data)) return data.map((item) => scopeData(item, organizationId));
  if (data && typeof data === 'object') return { ...(data as AnyArgs), organizationId };
  return data;
}

/**
 * Build a tenant-scoped client. Every query on a tenant-owned model is forced to the
 * organization: reads and writes gain `organizationId` in `where`, creates gain it in
 * `data`. Models that are not tenant-owned are rejected. The Organization row itself is
 * scoped to the caller's organization id.
 */
export function createTenantDb(prisma: PrismaClient, organizationId: string) {
  return prisma.$extends({
    name: `tenant:${organizationId}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (TENANT_FREE_MODELS.has(model)) {
            throw new Error(`Model ${model} is not tenant-owned and cannot be accessed through the tenant client`);
          }
          const scoped = { ...(args as AnyArgs) };
          if (model === 'Organization') {
            if (CREATE_OPERATIONS.has(operation) || operation === 'delete' || operation === 'deleteMany') {
              throw new Error('Organizations cannot be created or deleted through the tenant client');
            }
            const where = (scoped['where'] as AnyArgs | undefined) ?? {};
            const requested = where['id'];
            // A request for a different organization id must find nothing, never the caller's row.
            const extra = typeof requested === 'string' && requested !== organizationId ? [{ id: requested }] : [];
            const existingAnd = Array.isArray(where['AND']) ? (where['AND'] as unknown[]) : where['AND'] ? [where['AND']] : [];
            scoped['where'] = { ...where, id: organizationId, AND: [...existingAnd, ...extra] };
            return query(scoped as typeof args);
          }
          if (WHERE_OPERATIONS.has(operation)) scopeWhere(scoped, organizationId);
          if (CREATE_OPERATIONS.has(operation)) scoped['data'] = scopeData(scoped['data'], organizationId);
          if (operation === 'upsert') {
            scoped['create'] = scopeData(scoped['create'], organizationId);
          }
          return query(scoped as typeof args);
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof createTenantDb>;
/** The client available inside `tenantDb.$transaction(async (tx) => ...)`. */
export type TenantTx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

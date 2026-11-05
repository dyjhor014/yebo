import { TenantMismatchError, UnsupportedTenantOperationError } from './tenant-scope.errors';

/**
 * Barrera de aplicación del aislamiento multitenant (multitenancy §3, ADR-003).
 * Reescribe los argumentos de una operación Prisma para que solo afecte al tenant del contexto.
 * La segunda barrera es RLS en PostgreSQL (tenant-scope.extension.ts).
 *
 * Requisito: los modelos de tenant se escriben con FK escalares (entrada "unchecked"),
 * nunca con `tenant: { connect }`, para que tenantId sea siempre un campo verificable.
 */
type PrismaArgs = Record<string, unknown>;

const WHERE_SCOPED_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);

const DATA_GUARDED_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

function isRecord(value: unknown): value is PrismaArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function applyTenantScope(
  model: string,
  operation: string,
  args: unknown,
  tenantId: string,
): PrismaArgs {
  const scoped: PrismaArgs = isRecord(args) ? { ...args } : {};

  const scopeWhere = (where: unknown): PrismaArgs => {
    const base = isRecord(where) ? where : {};
    if (base.tenantId !== undefined && base.tenantId !== tenantId) {
      throw new TenantMismatchError(model, operation);
    }
    return { ...base, tenantId };
  };

  const withTenantData = (data: unknown): PrismaArgs => {
    if (!isRecord(data)) {
      throw new TenantMismatchError(model, operation);
    }
    if ((data.tenantId !== undefined && data.tenantId !== tenantId) || data.tenant !== undefined) {
      throw new TenantMismatchError(model, operation);
    }
    return { ...data, tenantId };
  };

  const assertNoTenantChange = (data: unknown): void => {
    if (!isRecord(data)) return;
    if ((data.tenantId !== undefined && data.tenantId !== tenantId) || data.tenant !== undefined) {
      throw new TenantMismatchError(model, operation);
    }
  };

  switch (operation) {
    case 'create':
      scoped.data = withTenantData(scoped.data);
      return scoped;
    case 'createMany':
    case 'createManyAndReturn':
      scoped.data = Array.isArray(scoped.data)
        ? scoped.data.map(withTenantData)
        : withTenantData(scoped.data);
      return scoped;
    case 'upsert':
      scoped.where = scopeWhere(scoped.where);
      scoped.create = withTenantData(scoped.create);
      assertNoTenantChange(scoped.update);
      return scoped;
    default:
      if (WHERE_SCOPED_OPERATIONS.has(operation)) {
        scoped.where = scopeWhere(scoped.where);
        if (DATA_GUARDED_OPERATIONS.has(operation)) assertNoTenantChange(scoped.data);
        return scoped;
      }
      throw new UnsupportedTenantOperationError(model, operation);
  }
}

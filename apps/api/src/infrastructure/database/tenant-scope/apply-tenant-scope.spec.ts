import { applyTenantScope } from './apply-tenant-scope';
import { TenantMismatchError, UnsupportedTenantOperationError } from './tenant-scope.errors';

const A = '0190f0a0-0000-7000-8000-00000000000a';
const B = '0190f0a0-0000-7000-8000-00000000000b';

describe('applyTenantScope', () => {
  it.each(['findMany', 'findFirst', 'findUnique', 'count', 'updateMany', 'deleteMany', 'delete', 'groupBy'])(
    '%s añade tenantId al where',
    (operation) => {
      expect(applyTenantScope('Route', operation, { where: { id: 'x' } }, A)).toMatchObject({
        where: { id: 'x', tenantId: A },
      });
    },
  );

  it('añade where aunque la operación no lo tenga', () => {
    expect(applyTenantScope('Route', 'findMany', undefined, A)).toEqual({ where: { tenantId: A } });
  });

  it('rechaza un where con otro tenant', () => {
    expect(() => applyTenantScope('Route', 'findMany', { where: { tenantId: B } }, A)).toThrow(
      TenantMismatchError,
    );
  });

  it('create fija tenantId y rechaza otro tenant o connect por relación', () => {
    expect(applyTenantScope('Route', 'create', { data: { name: 'r' } }, A)).toEqual({
      data: { name: 'r', tenantId: A },
    });
    expect(() => applyTenantScope('Route', 'create', { data: { name: 'r', tenantId: B } }, A)).toThrow(
      TenantMismatchError,
    );
    expect(() =>
      applyTenantScope('Route', 'create', { data: { name: 'r', tenant: { connect: { id: B } } } }, A),
    ).toThrow(TenantMismatchError);
  });

  it('createMany fija tenantId en cada fila', () => {
    const scoped = applyTenantScope('Route', 'createMany', { data: [{ name: '1' }, { name: '2' }] }, A);
    expect(scoped.data).toEqual([
      { name: '1', tenantId: A },
      { name: '2', tenantId: A },
    ]);
  });

  it('update no permite mover una fila a otro tenant', () => {
    expect(() =>
      applyTenantScope('Route', 'update', { where: { id: 'x' }, data: { tenantId: B } }, A),
    ).toThrow(TenantMismatchError);
  });

  it('upsert acota where, fija create y protege update', () => {
    const scoped = applyTenantScope(
      'Route',
      'upsert',
      { where: { id: 'x' }, create: { name: 'n' }, update: { name: 'm' } },
      A,
    );
    expect(scoped).toEqual({
      where: { id: 'x', tenantId: A },
      create: { name: 'n', tenantId: A },
      update: { name: 'm' },
    });
  });

  it('rechaza operaciones desconocidas (falla segura)', () => {
    expect(() => applyTenantScope('Route', 'findRaw', {}, A)).toThrow(UnsupportedTenantOperationError);
  });

  it('no muta los argumentos originales', () => {
    const args = { where: { id: 'x' } };
    applyTenantScope('Route', 'findMany', args, A);
    expect(args).toEqual({ where: { id: 'x' } });
  });
});

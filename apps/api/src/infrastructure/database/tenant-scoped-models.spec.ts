/**
 * Cobertura del registro de modelos de tenant: si se añade al esquema un modelo con `tenantId`
 * y no se registra, la extensión Prisma no lo filtraría. Esta prueba lo impide.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_MODELS_WITH_TENANT_ID, TENANT_SCOPED_MODELS } from './tenant-scoped-models';

const SCHEMA = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');

function modelsWithTenantId(schema: string): string[] {
  return [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)]
    .filter(([, , body]) => /^\s*tenantId\s+String\b/m.test(body ?? ''))
    .map(([, name]) => name ?? '');
}

describe('registro de modelos de tenant', () => {
  const declared = modelsWithTenantId(SCHEMA);

  it('el esquema tiene modelos de tenant (la prueba no está vacía)', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it('todo modelo con tenantId está registrado como de tenant o como excepción global explícita', () => {
    const missing = declared.filter(
      (m) => !TENANT_SCOPED_MODELS.has(m) && !GLOBAL_MODELS_WITH_TENANT_ID.has(m),
    );
    expect(missing).toEqual([]);
  });

  it('el registro no contiene modelos inexistentes ni duplicados entre las dos listas', () => {
    const all = [...TENANT_SCOPED_MODELS, ...GLOBAL_MODELS_WITH_TENANT_ID];
    expect(all.filter((m) => !declared.includes(m))).toEqual([]);
    expect([...TENANT_SCOPED_MODELS].filter((m) => GLOBAL_MODELS_WITH_TENANT_ID.has(m))).toEqual([]);
  });
});

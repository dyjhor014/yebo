import {
  CANCELLED_CLOSING_DAYS,
  TENANT_OPERATION_CATEGORIES,
  isLoginAllowed,
  isOperationAllowed,
  tenantPhase,
  type TenantOperationCategory,
  type TenantPhase,
} from './tenant-operation';

/**
 * Matriz de multitenancy §5.2 TRANSCRITA de la documentación (✅ = 1, ❌ = 0), columnas en este orden:
 * TRIAL, ACTIVE, PAST_DUE, SUSPENDED, EXPIRED, CANCELLED (cierre), CANCELLED (tras el cierre).
 * Si el código y el documento divergen, esta prueba falla.
 */
const PHASES: TenantPhase[] = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'EXPIRED',
  'CANCELLED_CLOSING',
  'CANCELLED_CLOSED',
];
const DOCUMENTED: Record<TenantOperationCategory | 'LOGIN', string> = {
  LOGIN: '1111110',
  NEW_COMMERCIAL: '1110000',
  FULFILL: '1111110',
  AFTER_SALES: '1111110',
  CASH: '1111110',
  READ: '1111110',
  EXPORT: '1111110', // tras el cierre: solo vía soporte de YEBO (Fase 4), nunca el propio tenant
  CONFIGURE: '1110000',
  CONFIGURE_COMPLIANCE: '1111110',
  USERS_REDUCE: '1111110',
  USERS_ADD: '1110000', // SUSPENDED/EXPIRED: solo con excepción de YEBO (tenant_module_overrides, Fase 4)
  BILLING_SELF: '1111110',
};

describe('Matriz de estados del tenant (multitenancy §5.2, ADR-023)', () => {
  it('cubre todas las categorías de §5.1', () => {
    expect(
      Object.keys(DOCUMENTED)
        .filter((k) => k !== 'LOGIN')
        .sort(),
    ).toEqual([...TENANT_OPERATION_CATEGORIES].sort());
  });

  it.each(TENANT_OPERATION_CATEGORIES)('%s coincide con el documento en las 7 columnas', (category) => {
    const actual = PHASES.map((phase) => (isOperationAllowed(category, phase) ? '1' : '0')).join('');
    expect(actual).toBe(DOCUMENTED[category]);
  });

  it('login coincide con el documento', () => {
    expect(PHASES.map((phase) => (isLoginAllowed(phase) ? '1' : '0')).join('')).toBe(DOCUMENTED.LOGIN);
  });

  it('SUSPENDED, EXPIRED y el cierre bloquean SOLO NEW_COMMERCIAL, CONFIGURE y USERS_ADD (ADR-023)', () => {
    for (const phase of ['SUSPENDED', 'EXPIRED', 'CANCELLED_CLOSING'] as const) {
      const blocked = TENANT_OPERATION_CATEGORIES.filter((c) => !isOperationAllowed(c, phase));
      expect(blocked.sort()).toEqual(['CONFIGURE', 'NEW_COMMERCIAL', 'USERS_ADD']);
    }
  });
});

describe('tenantPhase: periodo de cierre de CANCELLED (30 días, aprobado el 2026-11-05)', () => {
  const cancelledAt = '2026-11-01T00:00:00.000Z';
  const day = 86_400_000;
  const at = (ms: number) => new Date(Date.parse(cancelledAt) + ms);

  it('los estados distintos de CANCELLED pasan tal cual', () => {
    for (const status of ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'EXPIRED'] as const) {
      expect(tenantPhase({ status, cancelledAt: null }, new Date())).toBe(status);
    }
  });

  it('dentro de los 30 días es periodo de cierre; desde el instante 30 × 24 h, cerrado', () => {
    expect(CANCELLED_CLOSING_DAYS).toBe(30);
    expect(tenantPhase({ status: 'CANCELLED', cancelledAt }, at(0))).toBe('CANCELLED_CLOSING');
    expect(tenantPhase({ status: 'CANCELLED', cancelledAt }, at(30 * day - 1))).toBe('CANCELLED_CLOSING');
    expect(tenantPhase({ status: 'CANCELLED', cancelledAt }, at(30 * day))).toBe('CANCELLED_CLOSED');
  });

  it('CANCELLED sin fecha de cancelación falla cerrado', () => {
    expect(tenantPhase({ status: 'CANCELLED', cancelledAt: null }, new Date())).toBe('CANCELLED_CLOSED');
  });
});

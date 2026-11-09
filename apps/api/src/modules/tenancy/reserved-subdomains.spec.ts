import { CreateTenantRequestSchema, TenantSlugSchema } from '@yebo/contracts';
import { RESERVED_SUBDOMAINS, isReservedSlug, platformLabel } from './reserved-subdomains';

const HOSTS = ['cuentas.yebo.pe', 'admin.yebo.pe'];

describe('subdominios reservados (MKT-D6)', () => {
  it('incluye la lista aprobada en MKT-01 §2.3', () => {
    for (const label of [
      'www',
      'app',
      'cuentas',
      'admin',
      'api',
      'blog',
      'ayuda',
      'docs',
      'estado',
      'status',
      'mail',
      'demo',
      'static',
    ]) {
      expect(RESERVED_SUBDOMAINS.has(label)).toBe(true);
    }
  });

  it('rechaza los reservados sin distinguir mayúsculas ni espacios', () => {
    expect(isReservedSlug('WWW', HOSTS, 'yebo.pe')).toBe(true);
    expect(isReservedSlug(' api ', HOSTS, 'yebo.pe')).toBe(true);
    expect(isReservedSlug('transportes-sol', HOSTS, 'yebo.pe')).toBe(false);
  });

  it('reserva siempre las etiquetas de los hosts configurados de la plataforma', () => {
    expect(isReservedSlug('ingreso', ['ingreso.yebo.pe', 'gestion.yebo.pe'], 'yebo.pe')).toBe(true);
    expect(isReservedSlug('gestion', ['ingreso.yebo.pe', 'gestion.yebo.pe'], 'yebo.pe')).toBe(true);
    expect(platformLabel('cuentas.otro.pe', 'yebo.pe')).toBeNull();
  });

  it('el formato del slug excluye guiones al borde, dobles (xn--) y longitudes fuera de 3–40', () => {
    for (const bad of ['-sol', 'sol-', 'xn--sol', 'so', 'a'.repeat(41), 'sol.pe', 'sol_pe', 'ñandú']) {
      expect(TenantSlugSchema.safeParse(bad).success).toBe(false);
    }
    expect(TenantSlugSchema.parse(' Transportes-Sol ')).toBe('transportes-sol');
  });

  it('la zona horaria del alta debe ser IANA válida', () => {
    const base = {
      slug: 'sol',
      legalName: 'Sol SAC',
      tradeName: 'Sol',
      taxId: '20123456789',
      planVersionId: '0190f0a0-0000-7000-8000-000000000001',
      services: [{ modality: 'LAND', service: 'PASSENGER' }],
    };
    expect(CreateTenantRequestSchema.safeParse({ ...base, timezone: 'America/Lima' }).success).toBe(true);
    expect(CreateTenantRequestSchema.safeParse({ ...base, timezone: 'Lima/Peru' }).success).toBe(false);
  });
});

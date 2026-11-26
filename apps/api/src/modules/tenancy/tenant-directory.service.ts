import { Injectable } from '@nestjs/common';
import { PlatformPrismaService } from '../../infrastructure/database/platform-prisma.service';
import type { ResolvedTenant } from './tenant-resolver.service';

/** Estados en los que una empresa hace operaciones comerciales nuevas (NEW_COMMERCIAL, multitenancy §5.2). */
const OPERATIVE = ['TRIAL', 'ACTIVE', 'PAST_DUE'] as const;

/**
 * Directorio de empresas para los jobs del worker que recorren todas (Fase 7.3b: generación de viajes). Lee `tenants`
 * con `yebo_platform` (solo lectura de esa tabla, sin saltar RLS); el trabajo dentro de cada empresa se hace después
 * con `yebo_app` y su tenant en el contexto.
 */
@Injectable()
export class TenantDirectoryService {
  constructor(private readonly platform: PlatformPrismaService) {}

  /** Empresas en TRIAL, ACTIVE o PAST_DUE, con lo que el contexto necesita de ellas. */
  async operative(): Promise<ResolvedTenant[]> {
    const rows = await this.platform.client.tenant.findMany({
      where: { status: { in: [...OPERATIVE] } },
      orderBy: { id: 'asc' },
      select: { id: true, slug: true, tradeName: true, status: true, cancelledAt: true, timezone: true },
    });
    return rows.map((t) => ({
      id: t.id,
      slug: t.slug,
      tradeName: t.tradeName,
      status: t.status,
      cancelledAt: t.cancelledAt?.toISOString() ?? null,
      timezone: t.timezone,
    }));
  }
}

import { Module } from '@nestjs/common';
import { TenantHostGuard } from './tenant-host.guard';
import { TenantResolverService } from './tenant-resolver.service';

/**
 * Módulo de plataforma (capa L0): resolución del tenant por host. TenantHostGuard se registra como guard
 * GLOBAL en AccessModule (Fase 3.3), no con @UseGuards en cada controlador.
 * Autorizado a usar PlatformPrismaService (ver eslint.config.mjs). El portal público (GET /public/site) vive en el
 * módulo site desde la Fase 5.1.
 */
@Module({
  providers: [TenantResolverService, TenantHostGuard],
  exports: [TenantResolverService, TenantHostGuard],
})
export class TenancyModule {}

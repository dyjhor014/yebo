import { Module } from '@nestjs/common';
import { TenantDirectoryService } from './tenant-directory.service';
import { TenantHostGuard } from './tenant-host.guard';
import { TenantResolverService } from './tenant-resolver.service';

/**
 * Módulo de plataforma (capa L0): resolución del tenant por host. TenantHostGuard se registra como guard
 * GLOBAL en AccessModule (Fase 3.3), no con @UseGuards en cada controlador.
 * Autorizado a usar PlatformPrismaService (ver eslint.config.mjs). El portal público (GET /public/site) vive en el
 * módulo site desde la Fase 5.1. Fase 7.3b: directorio de empresas operativas para los jobs del worker.
 */
@Module({
  providers: [TenantResolverService, TenantHostGuard, TenantDirectoryService],
  exports: [TenantResolverService, TenantHostGuard, TenantDirectoryService],
})
export class TenancyModule {}

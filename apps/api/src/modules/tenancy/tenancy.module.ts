import { Module } from '@nestjs/common';
import { PublicSiteController } from './public-site.controller';
import { TenantHostGuard } from './tenant-host.guard';
import { TenantResolverService } from './tenant-resolver.service';

/**
 * Módulo de plataforma (capa L0): resolución del tenant por host.
 * Autorizado a usar PlatformPrismaService (ver eslint.config.mjs).
 */
@Module({
  controllers: [PublicSiteController],
  providers: [TenantResolverService, TenantHostGuard],
  exports: [TenantResolverService, TenantHostGuard],
})
export class TenancyModule {}

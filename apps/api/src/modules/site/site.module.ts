import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { IdentityModule } from '../identity/identity.module';
import { PublicSiteController } from './http/public-site.controller';
import { SiteController } from './http/site.controller';
import { SiteAssetsService } from './site-assets.service';
import { SiteService } from './site.service';

/** Sitio público de la empresa (Fase 5, white label): editor de la empresa y portal por host. */
@Module({
  imports: [PermissionsModule, IdentityModule],
  controllers: [SiteController, PublicSiteController],
  providers: [SiteService, SiteAssetsService],
})
export class SiteModule {}

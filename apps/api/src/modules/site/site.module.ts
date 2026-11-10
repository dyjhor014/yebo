import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { PublicSiteController } from './http/public-site.controller';
import { SiteController } from './http/site.controller';
import { SiteService } from './site.service';

/** Sitio público de la empresa (Fase 5, white label): editor de la empresa y portal por host. */
@Module({
  imports: [PermissionsModule],
  controllers: [SiteController, PublicSiteController],
  providers: [SiteService],
})
export class SiteModule {}

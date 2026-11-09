import { Module } from '@nestjs/common';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BackofficePrismaService } from './backoffice-prisma.service';
import { CatalogService } from './catalog.service';
import { CatalogController } from './http/catalog.controller';
import { PlatformAuthController } from './http/platform-auth.controller';
import { PlatformGuard } from './http/platform.guard';
import { StaffController } from './http/staff.controller';
import { TenantsController } from './http/tenants.controller';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthService } from './platform-auth.service';
import { StaffService } from './staff.service';
import { TenantLifecycleService } from './tenant-lifecycle.service';
import { TenantsService } from './tenants.service';

/**
 * Módulo de plataforma (capa L0): staff de YEBO, su sesión y su MFA (Fase 4.1). Usa el rol `yebo_backoffice` a
 * través de BackofficePrismaService, que NO se exporta (ni inyectable fuera del módulo ni importable: ESLint).
 * PlatformGuard se registra como guard global en access.module.ts.
 */
@Module({
  imports: [IdentityModule, TenancyModule],
  controllers: [PlatformAuthController, StaffController, CatalogController, TenantsController],
  providers: [
    BackofficePrismaService,
    FieldEncryption,
    PlatformAuditService,
    PlatformAuthService,
    StaffService,
    CatalogService,
    TenantLifecycleService,
    TenantsService,
    PlatformGuard,
  ],
  exports: [PlatformAuthService, PlatformGuard],
})
export class PlatformAdminModule {}

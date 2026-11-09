import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthenticationGuard } from '../identity/http/authentication.guard';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantHostGuard } from '../tenancy/tenant-host.guard';
import { MembersController, RolesController } from './http/members.controller';
import { PermissionGuard } from './http/permission.guard';
import { TenantStatusGuard } from './http/tenant-status.guard';
import { MembersService } from './members.service';
import { PermissionsModule } from './permissions.module';
import { RolesService } from './roles.service';

/**
 * Autorización y estado del tenant (Fase 3.3). Registra la cadena de guards GLOBALES, en este orden:
 *   1. TenantHostGuard     · tenant por host (ADR-004)
 *   2. AuthenticationGuard · access token + sesión en PostgreSQL + versión de permisos (+ CSRF en mutaciones)
 *   3. PermissionGuard     · `@RequirePermission`
 *   4. TenantStatusGuard   · `@TenantOperation` contra la matriz de estados (ADR-023)
 * Denegar por defecto: toda ruta sin `@Public(...)` pasa por los cuatro. ESLint prohíbe registrar APP_GUARD
 * fuera de este archivo.
 */
@Module({
  imports: [TenancyModule, IdentityModule, PermissionsModule],
  controllers: [MembersController, RolesController],
  providers: [
    { provide: APP_GUARD, useClass: TenantHostGuard },
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: TenantStatusGuard },
    MembersService,
    RolesService,
  ],
  exports: [RolesService],
})
export class AccessModule {}

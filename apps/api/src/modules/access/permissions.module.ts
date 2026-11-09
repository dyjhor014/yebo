import { Module } from '@nestjs/common';
import { PermissionService } from './permission.service';

/**
 * Permisos efectivos. Módulo propio y sin dependencias de otros módulos de negocio: lo usan tanto `identity`
 * (`GET /auth/session`) como `access` (guards), sin crear un ciclo entre ellos.
 */
@Module({ providers: [PermissionService], exports: [PermissionService] })
export class PermissionsModule {}

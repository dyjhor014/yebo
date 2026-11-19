import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { RoutesController } from './http/routes.controller';
import { RoutesService } from './routes.service';

/** Rutas, paradas y trazas (Fase 7.1; F7-Q7 y F7-Q9). */
@Module({
  imports: [PermissionsModule],
  controllers: [RoutesController],
  providers: [RoutesService],
})
export class RoutesModule {}

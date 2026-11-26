import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { AgenciesService } from './agencies.service';
import { AgenciesController } from './http/agencies.controller';

/** Agencias externas con su canal de venta (Fase 6.5; F6-Q2), detrás del módulo AGENCIES. */
@Module({
  imports: [PermissionsModule],
  controllers: [AgenciesController],
  providers: [AgenciesService],
})
export class AgenciesModule {}

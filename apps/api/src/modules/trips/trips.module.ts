import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { FleetContext } from '../fleet/fleet-context';
import { TripsController } from './http/trips.controller';
import { TripsService } from './trips.service';

/** Viajes: paradas copiadas, unidad y plano, inventario materializado y estados (Fase 7.3a; F7-Q3 y F7-Q4). */
@Module({
  imports: [PermissionsModule],
  controllers: [TripsController],
  providers: [TripsService, FleetContext],
})
export class TripsModule {}

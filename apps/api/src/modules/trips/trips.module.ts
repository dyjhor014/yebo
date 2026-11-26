import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { FleetContext } from '../fleet/fleet-context';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SchedulesController } from './http/schedules.controller';
import { TripsController } from './http/trips.controller';
import { ScheduleRunnerService } from './schedule-runner.service';
import { SchedulesService } from './schedules.service';
import { TripsService } from './trips.service';

/**
 * Viajes (Fase 7.3a: paradas copiadas, unidad y plano, inventario y estados) y programaciones (7.3b: generación hasta el
 * horizonte). El job diario vive en el worker (schedules.worker.ts); ScheduleRunnerService se registra también aquí para
 * que las pruebas de integración lo ejecuten con la aplicación.
 */
@Module({
  imports: [PermissionsModule, TenancyModule],
  controllers: [TripsController, SchedulesController],
  providers: [TripsService, SchedulesService, ScheduleRunnerService, FleetContext],
})
export class TripsModule {}

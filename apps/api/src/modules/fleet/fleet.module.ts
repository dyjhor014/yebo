import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { FleetContext } from './fleet-context';
import { FleetService } from './fleet.service';
import {
  VehicleDocumentFilesController,
  VehiclesController,
  VehicleTypesController,
} from './http/fleet.controller';
import { VehicleDocumentsService } from './vehicle-documents.service';

/** Flota: tipos de vehículo, vehículos y documentos (Fase 6.2; capa L1 de system-overview §4). */
@Module({
  imports: [PermissionsModule],
  controllers: [VehicleTypesController, VehiclesController, VehicleDocumentFilesController],
  providers: [FleetContext, FleetService, VehicleDocumentsService],
})
export class FleetModule {}

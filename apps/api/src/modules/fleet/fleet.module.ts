import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { FleetContext } from './fleet-context';
import { FleetService } from './fleet.service';
import {
  VehicleDocumentFilesController,
  VehiclesController,
  VehicleTypesController,
} from './http/fleet.controller';
import { LayoutsController, VehicleLayoutAssignmentsController } from './http/layouts.controller';
import { LayoutsService } from './layouts.service';
import { VehicleDocumentsService } from './vehicle-documents.service';

/** Flota: tipos de vehículo, vehículos, documentos (Fase 6.2) y layouts (Fase 6.3; capa L1 de system-overview §4). */
@Module({
  imports: [PermissionsModule],
  controllers: [
    VehicleTypesController,
    VehiclesController,
    VehicleDocumentFilesController,
    LayoutsController,
    VehicleLayoutAssignmentsController,
  ],
  providers: [FleetContext, FleetService, VehicleDocumentsService, LayoutsService],
})
export class FleetModule {}

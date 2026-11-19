import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { FleetContext } from '../fleet/fleet-context';
import { IdentityModule } from '../identity/identity.module';
import { EquipmentService } from './equipment.service';
import { EquipmentCatalogController, VehicleEquipmentController } from './http/equipment.controller';
import { InspectionsController } from './http/inspections.controller';
import { InspectionsService } from './inspections.service';

/**
 * Equipamiento de unidades e inspecciones preoperacionales (Fase 7.E1; plan-equipamiento-inspecciones). Herramienta
 * opcional de control interno: ningún otro módulo depende de este.
 */
@Module({
  imports: [PermissionsModule, IdentityModule],
  controllers: [EquipmentCatalogController, VehicleEquipmentController, InspectionsController],
  providers: [EquipmentService, InspectionsService, FleetContext],
})
export class EquipmentModule {}

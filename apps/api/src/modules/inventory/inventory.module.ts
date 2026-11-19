import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { FleetContext } from '../fleet/fleet-context';
import { BlocksService } from './blocks.service';
import { InventoryController } from './http/inventory.controller';
import { InventoryService } from './inventory.service';

/**
 * Motor de inventario por tramo y bloqueos operativos (Fase 7.4; capacity-and-inventory §3–6; F7-Q5). Exporta el motor
 * para la venta (Fase 8), las encomiendas (9) y la carga (10).
 */
@Module({
  imports: [PermissionsModule],
  controllers: [InventoryController],
  providers: [InventoryService, BlocksService, FleetContext],
  exports: [InventoryService],
})
export class InventoryModule {}

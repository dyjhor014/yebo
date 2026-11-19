import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AddVehicleEquipmentRequestSchema,
  TenantEquipmentItemRequestSchema,
  UpdateVehicleEquipmentRequestSchema,
  type EquipmentCatalogResponse,
  type VehicleEquipment,
  type VehicleEquipmentResponse,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { Protected } from '../../access/route-policy';
import { EquipmentService } from '../equipment.service';

class TenantEquipmentItemRequestDto extends createZodDto(TenantEquipmentItemRequestSchema) {}
class AddVehicleEquipmentRequestDto extends createZodDto(AddVehicleEquipmentRequestSchema) {}
class UpdateVehicleEquipmentRequestDto extends createZodDto(UpdateVehicleEquipmentRequestSchema) {}

/** Catálogo de equipamiento (Fase 7.E1; EQ-Q3): el de YEBO (sugerencias) y el propio de la empresa. */
@ApiTags('equipment')
@Controller({ path: 'equipment-catalog', version: '1' })
export class EquipmentCatalogController {
  constructor(private readonly service: EquipmentService) {}

  @Get()
  @Protected('equipment.manage', 'READ')
  catalog(): Promise<EquipmentCatalogResponse> {
    return this.service.catalog();
  }

  @Post()
  @Protected('equipment.manage', 'CONFIGURE')
  create(@Body() body: TenantEquipmentItemRequestDto): Promise<EquipmentCatalogResponse> {
    return this.service.createItem(body);
  }

  @Put(':id')
  @Protected('equipment.manage', 'CONFIGURE')
  update(
    @Param('id') id: string,
    @Body() body: TenantEquipmentItemRequestDto,
  ): Promise<EquipmentCatalogResponse> {
    return this.service.updateItem(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Protected('equipment.manage', 'CONFIGURE')
  archive(@Param('id') id: string): Promise<EquipmentCatalogResponse> {
    return this.service.archiveItem(id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Protected('equipment.manage', 'CONFIGURE')
  restore(@Param('id') id: string): Promise<EquipmentCatalogResponse> {
    return this.service.archiveItem(id, false);
  }
}

/**
 * Equipamiento de una unidad (Fase 7.E1). Verlo es de inspections.read (quien inspecciona lo necesita); declararlo,
 * editarlo y eliminarlo (archivar), de equipment.manage (CONFIGURE). Una unidad sin equipamiento es válida.
 */
@ApiTags('equipment')
@Controller({ path: 'vehicles/:vehicleId/equipment', version: '1' })
export class VehicleEquipmentController {
  constructor(private readonly service: EquipmentService) {}

  @Get()
  @Protected('inspections.read', 'READ')
  async list(
    @Param('vehicleId') vehicleId: string,
    @Query('archived') archived?: string,
  ): Promise<VehicleEquipmentResponse> {
    return { equipment: await this.service.list(vehicleId, archived === 'true') };
  }

  @Post()
  @Protected('equipment.manage', 'CONFIGURE')
  async add(
    @Param('vehicleId') vehicleId: string,
    @Body() body: AddVehicleEquipmentRequestDto,
  ): Promise<VehicleEquipmentResponse> {
    return { equipment: await this.service.add(vehicleId, body) };
  }

  @Put(':id')
  @Protected('equipment.manage', 'CONFIGURE')
  update(
    @Param('vehicleId') vehicleId: string,
    @Param('id') id: string,
    @Body() body: UpdateVehicleEquipmentRequestDto,
  ): Promise<VehicleEquipment> {
    return this.service.update(vehicleId, id, body);
  }

  /** Elimina el elemento de la unidad (lo archiva: las inspecciones anteriores conservan su copia). */
  @Post(':id/remove')
  @HttpCode(200)
  @Protected('equipment.manage', 'CONFIGURE')
  remove(@Param('vehicleId') vehicleId: string, @Param('id') id: string): Promise<VehicleEquipment> {
    return this.service.remove(vehicleId, id);
  }
}

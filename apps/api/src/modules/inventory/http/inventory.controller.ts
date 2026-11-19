import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateBlockRequestSchema,
  type TripAvailability,
  type TripBlock,
  type TripBlocksResponse,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { Protected } from '../../access/route-policy';
import { BlocksService } from '../blocks.service';
import { InventoryService } from '../inventory.service';

class CreateBlockRequestDto extends createZodDto(CreateBlockRequestSchema) {}

/**
 * Inventario de un viaje (Fase 7.4). La disponibilidad tramo por tramo es de trips.manage (READ). Los bloqueos
 * operativos son de trips.block: verlos es READ; crearlos y liberarlos, FULFILL (operación de un viaje existente,
 * permitida también con la empresa suspendida; multitenancy §5).
 */
@ApiTags('inventory')
@Controller({ path: 'trips/:tripId', version: '1' })
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly blocks: BlocksService,
  ) {}

  @Get('availability')
  @Protected('trips.manage', 'READ')
  availability(@Param('tripId') tripId: string): Promise<TripAvailability> {
    return this.inventory.availability(tripId);
  }

  @Get('blocks')
  @Protected('trips.block', 'READ')
  async list(@Param('tripId') tripId: string): Promise<TripBlocksResponse> {
    return { blocks: await this.blocks.list(tripId) };
  }

  @Post('blocks')
  @Protected('trips.block', 'FULFILL')
  create(@Param('tripId') tripId: string, @Body() body: CreateBlockRequestDto): Promise<TripBlock> {
    return this.blocks.create(tripId, body);
  }

  @Post('blocks/:blockId/release')
  @HttpCode(200)
  @Protected('trips.block', 'FULFILL')
  release(@Param('tripId') tripId: string, @Param('blockId') blockId: string): Promise<TripBlock> {
    return this.blocks.release(tripId, blockId);
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CancelTripRequestSchema,
  CreateTripRequestSchema,
  TripsQuerySchema,
  UpdateTripRequestSchema,
  type Trip,
  type TripInventory,
  type TripsResponse,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { AppError } from '../../../common/errors/app-error';
import { Protected } from '../../access/route-policy';
import { TripsService } from '../trips.service';

class CreateTripRequestDto extends createZodDto(CreateTripRequestSchema) {}
class UpdateTripRequestDto extends createZodDto(UpdateTripRequestSchema) {}
class CancelTripRequestDto extends createZodDto(CancelTripRequestSchema) {}

/**
 * Viajes (Fase 7.3a; permiso trips.manage). Consultar es READ. Crear, editar, abrir a la venta, volver a planificar y
 * cancelar son NEW_COMMERCIAL (multitenancy §5: solo en TRIAL, ACTIVE y PAST_DUE).
 */
@ApiTags('trips')
@Controller({ path: 'trips', version: '1' })
export class TripsController {
  constructor(private readonly service: TripsService) {}

  /** Viajes con salida local entre `from` y `to` (`?from=AAAA-MM-DD&to=AAAA-MM-DD&routeId=…&status=…`). */
  @Get()
  @Protected('trips.manage', 'READ')
  async list(@Query() query: Record<string, unknown>): Promise<TripsResponse> {
    const parsed = TripsQuerySchema.safeParse(query);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new AppError(
        'VALIDATION_FAILED',
        `Parámetro no válido: ${issue?.path.join('.') || 'consulta'} (${issue?.message ?? ''})`,
        400,
      );
    }
    return { trips: await this.service.list(parsed.data) };
  }

  @Get(':id')
  @Protected('trips.manage', 'READ')
  get(@Param('id') id: string): Promise<Trip> {
    return this.service.get(id);
  }

  @Get(':id/inventory')
  @Protected('trips.manage', 'READ')
  inventory(@Param('id') id: string): Promise<TripInventory> {
    return this.service.inventory(id);
  }

  @Post()
  @Protected('trips.manage', 'NEW_COMMERCIAL')
  create(@Body() body: CreateTripRequestDto): Promise<Trip> {
    return this.service.create(body);
  }

  @Put(':id')
  @Protected('trips.manage', 'NEW_COMMERCIAL')
  update(@Param('id') id: string, @Body() body: UpdateTripRequestDto): Promise<Trip> {
    return this.service.update(id, body);
  }

  @Post(':id/open')
  @HttpCode(200)
  @Protected('trips.manage', 'NEW_COMMERCIAL')
  open(@Param('id') id: string): Promise<Trip> {
    return this.service.open(id);
  }

  @Post(':id/back-to-planned')
  @HttpCode(200)
  @Protected('trips.manage', 'NEW_COMMERCIAL')
  backToPlanned(@Param('id') id: string): Promise<Trip> {
    return this.service.backToPlanned(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Protected('trips.manage', 'NEW_COMMERCIAL')
  cancel(@Param('id') id: string, @Body() body: CancelTripRequestDto): Promise<Trip> {
    return this.service.cancel(id, body.reason);
  }
}

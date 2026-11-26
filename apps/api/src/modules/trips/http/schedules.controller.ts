import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateScheduleRequestSchema,
  UpdateScheduleRequestSchema,
  type GenerateScheduleResponse,
  type Schedule,
  type SchedulesResponse,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { Protected } from '../../access/route-policy';
import { SchedulesService } from '../schedules.service';

class CreateScheduleRequestDto extends createZodDto(CreateScheduleRequestSchema) {}
class UpdateScheduleRequestDto extends createZodDto(UpdateScheduleRequestSchema) {}

/**
 * Programaciones (Fase 7.3b; F7-Q2; permiso trips.manage). Consultar es READ. Crear, editar, archivar, restaurar y
 * generar son NEW_COMMERCIAL (multitenancy §5: crear programaciones y viajes).
 */
@ApiTags('schedules')
@Controller({ path: 'schedules', version: '1' })
export class SchedulesController {
  constructor(private readonly service: SchedulesService) {}

  @Get()
  @Protected('trips.manage', 'READ')
  async list(): Promise<SchedulesResponse> {
    return { schedules: await this.service.list() };
  }

  @Get(':id')
  @Protected('trips.manage', 'READ')
  get(@Param('id') id: string): Promise<Schedule> {
    return this.service.get(id);
  }

  @Post()
  @Protected('trips.manage', 'NEW_COMMERCIAL')
  create(@Body() body: CreateScheduleRequestDto): Promise<Schedule> {
    return this.service.create(body);
  }

  @Put(':id')
  @Protected('trips.manage', 'NEW_COMMERCIAL')
  update(@Param('id') id: string, @Body() body: UpdateScheduleRequestDto): Promise<Schedule> {
    return this.service.update(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Protected('trips.manage', 'NEW_COMMERCIAL')
  archive(@Param('id') id: string): Promise<Schedule> {
    return this.service.archive(id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Protected('trips.manage', 'NEW_COMMERCIAL')
  restore(@Param('id') id: string): Promise<Schedule> {
    return this.service.archive(id, false);
  }

  /** Genera los viajes que faltan hasta el horizonte (60 días). Idempotente. */
  @Post(':id/generate')
  @HttpCode(200)
  @Protected('trips.manage', 'NEW_COMMERCIAL')
  generate(@Param('id') id: string): Promise<GenerateScheduleResponse> {
    return this.service.generate(id);
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateAgencyRequestSchema,
  UpdateAgencyRequestSchema,
  type AgenciesResponse,
  type Agency,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { Protected, RequiresModule } from '../../access/route-policy';
import { AgenciesService } from '../agencies.service';

class CreateAgencyRequestDto extends createZodDto(CreateAgencyRequestSchema) {}
class UpdateAgencyRequestDto extends createZodDto(UpdateAgencyRequestSchema) {}

/**
 * Agencias externas (Fase 6.5; F6-Q2; permiso agencies.manage y módulo AGENCIES: sin él, 403 MODULE_NOT_ENABLED).
 * Leer es READ; crear, editar, archivar y restaurar son CONFIGURE (bloqueado en SUSPENDED, EXPIRED y CANCELLED).
 */
@ApiTags('agencies')
@RequiresModule('AGENCIES')
@Controller({ path: 'agencies', version: '1' })
export class AgenciesController {
  constructor(private readonly service: AgenciesService) {}

  @Get()
  @Protected('agencies.manage', 'READ')
  async list(): Promise<AgenciesResponse> {
    return { agencies: await this.service.agencies() };
  }

  @Post()
  @Protected('agencies.manage', 'CONFIGURE')
  create(@Body() body: CreateAgencyRequestDto): Promise<Agency> {
    return this.service.create(body);
  }

  @Put(':id')
  @Protected('agencies.manage', 'CONFIGURE')
  update(@Param('id') id: string, @Body() body: UpdateAgencyRequestDto): Promise<Agency> {
    return this.service.update(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Protected('agencies.manage', 'CONFIGURE')
  archive(@Param('id') id: string): Promise<Agency> {
    return this.service.archive(id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Protected('agencies.manage', 'CONFIGURE')
  restore(@Param('id') id: string): Promise<Agency> {
    return this.service.archive(id, false);
  }
}

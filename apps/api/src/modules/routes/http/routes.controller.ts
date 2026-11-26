import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateRouteRequestSchema,
  UpdateRouteRequestSchema,
  type Route,
  type RoutesResponse,
  type TraceImportResponse,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { Protected } from '../../access/route-policy';
import { RoutesService } from '../routes.service';

class CreateRouteRequestDto extends createZodDto(CreateRouteRequestSchema) {}
class UpdateRouteRequestDto extends createZodDto(UpdateRouteRequestSchema) {}

/**
 * Rutas y paradas (Fase 7.1; permiso routes.manage). Leer es READ; crear, editar, archivar, restaurar e importar
 * una traza son CONFIGURE (bloqueado en SUSPENDED, EXPIRED y CANCELLED; multitenancy §5).
 */
@ApiTags('routes')
@Controller({ path: 'routes', version: '1' })
export class RoutesController {
  constructor(private readonly service: RoutesService) {}

  @Get()
  @Protected('routes.manage', 'READ')
  async list(): Promise<RoutesResponse> {
    return { routes: await this.service.routes() };
  }

  /**
   * Importa la traza de un GPX o un KML enviado en el cuerpo (`application/gpx+xml`, `application/xml`,
   * `text/xml` o `application/vnd.google-earth.kml+xml`, hasta 5 MB). Devuelve los puntos; no guarda nada.
   */
  @Post('traces/import')
  @HttpCode(200)
  @Protected('routes.manage', 'CONFIGURE')
  importTrace(@Body() body: unknown): TraceImportResponse {
    return this.service.importTrace(body);
  }

  @Get(':id')
  @Protected('routes.manage', 'READ')
  get(@Param('id') id: string): Promise<Route> {
    return this.service.route(id);
  }

  @Post()
  @Protected('routes.manage', 'CONFIGURE')
  create(@Body() body: CreateRouteRequestDto): Promise<Route> {
    return this.service.create(body);
  }

  @Put(':id')
  @Protected('routes.manage', 'CONFIGURE')
  update(@Param('id') id: string, @Body() body: UpdateRouteRequestDto): Promise<Route> {
    return this.service.update(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Protected('routes.manage', 'CONFIGURE')
  archive(@Param('id') id: string): Promise<Route> {
    return this.service.archive(id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Protected('routes.manage', 'CONFIGURE')
  restore(@Param('id') id: string): Promise<Route> {
    return this.service.archive(id, false);
  }
}

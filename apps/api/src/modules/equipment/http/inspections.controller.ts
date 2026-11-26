import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateInspectionRequestSchema,
  UpdateInspectionItemRequestSchema,
  UpdateInspectionRequestSchema,
  type InspectionDetail,
  type InspectionsResponse,
  type TripInspectionsResponse,
} from '@yebo/contracts';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { Protected } from '../../access/route-policy';
import { InspectionsService } from '../inspections.service';

class CreateInspectionRequestDto extends createZodDto(CreateInspectionRequestSchema) {}
class UpdateInspectionRequestDto extends createZodDto(UpdateInspectionRequestSchema) {}
class UpdateInspectionItemRequestDto extends createZodDto(UpdateInspectionItemRequestSchema) {}

/**
 * Inspecciones preoperacionales (Fase 7.E1; EQ-Q9). Verlas es inspections.read (READ). Realizarlas, completarlas,
 * rectificarlas, descartar un borrador y sus fotos son inspections.perform (FULFILL: siguen con la empresa suspendida).
 * Opcionales: ningún flujo de viajes, venta ni salida las exige.
 */
@ApiTags('inspections')
@Controller({ version: '1' })
export class InspectionsController {
  constructor(private readonly service: InspectionsService) {}

  @Get('vehicles/:vehicleId/inspections')
  @Protected('inspections.read', 'READ')
  async forVehicle(@Param('vehicleId') vehicleId: string): Promise<InspectionsResponse> {
    return { inspections: await this.service.forVehicle(vehicleId) };
  }

  /** «Control preoperacional» del viaje. */
  @Get('trips/:tripId/inspections')
  @Protected('inspections.read', 'READ')
  forTrip(@Param('tripId') tripId: string): Promise<TripInspectionsResponse> {
    return this.service.forTrip(tripId);
  }

  @Get('inspections/:id')
  @Protected('inspections.read', 'READ')
  get(@Param('id') id: string): Promise<InspectionDetail> {
    return this.service.get(id);
  }

  @Post('inspections')
  @Protected('inspections.perform', 'FULFILL')
  create(@Body() body: CreateInspectionRequestDto): Promise<InspectionDetail> {
    return this.service.create(body);
  }

  @Put('inspections/:id')
  @Protected('inspections.perform', 'FULFILL')
  update(@Param('id') id: string, @Body() body: UpdateInspectionRequestDto): Promise<InspectionDetail> {
    return this.service.updateNotes(id, body.generalNotes);
  }

  @Put('inspections/:id/items/:itemId')
  @Protected('inspections.perform', 'FULFILL')
  updateItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: UpdateInspectionItemRequestDto,
  ): Promise<InspectionDetail> {
    return this.service.updateItem(id, itemId, body);
  }

  @Post('inspections/:id/complete')
  @HttpCode(200)
  @Protected('inspections.perform', 'FULFILL')
  complete(@Param('id') id: string): Promise<InspectionDetail> {
    return this.service.complete(id);
  }

  /** Descarta un borrador. Una inspección completada no se borra. */
  @Delete('inspections/:id')
  @HttpCode(204)
  @Protected('inspections.perform', 'FULFILL')
  async discard(@Param('id') id: string): Promise<void> {
    await this.service.discard(id);
  }

  /** Foto de evidencia en el cuerpo (JPEG, PNG o WebP; hasta 5 MB), de un elemento (`?itemId=`) o general. */
  @Post('inspections/:id/photos')
  @Protected('inspections.perform', 'FULFILL')
  addPhoto(
    @Param('id') id: string,
    @Query('itemId') itemId: string | undefined,
    @Body() body: unknown,
  ): Promise<InspectionDetail> {
    return this.service.addPhoto(id, itemId ?? null, body);
  }

  @Delete('inspections/:id/photos/:photoId')
  @Protected('inspections.perform', 'FULFILL')
  removePhoto(@Param('id') id: string, @Param('photoId') photoId: string): Promise<InspectionDetail> {
    return this.service.removePhoto(id, photoId);
  }

  /** La foto (privada): sin caché compartida ni ejecución de contenido. */
  @Get('inspections/:id/photos/:photoId')
  @Protected('inspections.read', 'READ')
  async photo(
    @Param('id') id: string,
    @Param('photoId') photoId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.service.photo(id, photoId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(file.mime).send(file.body);
  }
}

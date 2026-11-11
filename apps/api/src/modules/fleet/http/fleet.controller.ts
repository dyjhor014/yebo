import { Body, Controller, Get, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateVehicleRequestSchema,
  UpdateVehicleRequestSchema,
  UpdateVehicleTypeRequestSchema,
  VehicleDocumentInputSchema,
  VehicleTypeInputSchema,
  type Vehicle,
  type VehicleDocument,
  type VehicleDocumentFile,
  type VehicleDocumentsResponse,
  type VehiclesResponse,
  type VehicleType,
  type VehicleTypesResponse,
} from '@yebo/contracts';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { Protected } from '../../access/route-policy';
import { FleetService } from '../fleet.service';
import { VehicleDocumentsService } from '../vehicle-documents.service';

class VehicleTypeInputDto extends createZodDto(VehicleTypeInputSchema) {}
class UpdateVehicleTypeRequestDto extends createZodDto(UpdateVehicleTypeRequestSchema) {}
class CreateVehicleRequestDto extends createZodDto(CreateVehicleRequestSchema) {}
class UpdateVehicleRequestDto extends createZodDto(UpdateVehicleRequestSchema) {}
class VehicleDocumentInputDto extends createZodDto(VehicleDocumentInputSchema) {}

/**
 * Tipos de vehículo (Fase 6.2; permiso fleet.manage). Leer es READ; crear, editar, archivar y restaurar son
 * CONFIGURE (bloqueado en SUSPENDED, EXPIRED y CANCELLED; multitenancy §5).
 */
@ApiTags('fleet')
@Controller({ path: 'vehicle-types', version: '1' })
export class VehicleTypesController {
  constructor(private readonly fleet: FleetService) {}

  @Get()
  @Protected('fleet.manage', 'READ')
  list(): Promise<VehicleTypesResponse> {
    return this.fleet.types();
  }

  @Post()
  @Protected('fleet.manage', 'CONFIGURE')
  create(@Body() body: VehicleTypeInputDto): Promise<VehicleType> {
    return this.fleet.createType(body);
  }

  @Put(':id')
  @Protected('fleet.manage', 'CONFIGURE')
  update(@Param('id') id: string, @Body() body: UpdateVehicleTypeRequestDto): Promise<VehicleType> {
    return this.fleet.updateType(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Protected('fleet.manage', 'CONFIGURE')
  archive(@Param('id') id: string): Promise<VehicleType> {
    return this.fleet.archiveType(id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Protected('fleet.manage', 'CONFIGURE')
  restore(@Param('id') id: string): Promise<VehicleType> {
    return this.fleet.archiveType(id, false);
  }
}

/** Vehículos y sus documentos (Fase 6.2). Un vehículo se retira con su estado; el código no cambia. */
@ApiTags('fleet')
@Controller({ path: 'vehicles', version: '1' })
export class VehiclesController {
  constructor(
    private readonly fleet: FleetService,
    private readonly documents: VehicleDocumentsService,
  ) {}

  @Get()
  @Protected('fleet.manage', 'READ')
  async list(): Promise<VehiclesResponse> {
    return { vehicles: await this.fleet.vehicles() };
  }

  @Post()
  @Protected('fleet.manage', 'CONFIGURE')
  create(@Body() body: CreateVehicleRequestDto): Promise<Vehicle> {
    return this.fleet.createVehicle(body);
  }

  @Put(':id')
  @Protected('fleet.manage', 'CONFIGURE')
  update(@Param('id') id: string, @Body() body: UpdateVehicleRequestDto): Promise<Vehicle> {
    return this.fleet.updateVehicle(id, body);
  }

  @Get(':id/documents')
  @Protected('fleet.manage', 'READ')
  listDocuments(@Param('id') id: string): Promise<VehicleDocumentsResponse> {
    return this.documents.list(id);
  }

  @Post(':id/documents')
  @Protected('fleet.manage', 'CONFIGURE')
  createDocument(@Param('id') id: string, @Body() body: VehicleDocumentInputDto): Promise<VehicleDocument> {
    return this.documents.create(id, body);
  }

  @Put(':id/documents/:documentId')
  @Protected('fleet.manage', 'CONFIGURE')
  updateDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() body: VehicleDocumentInputDto,
  ): Promise<VehicleDocument> {
    return this.documents.update(id, documentId, body);
  }

  @Post(':id/documents/:documentId/archive')
  @HttpCode(200)
  @Protected('fleet.manage', 'CONFIGURE')
  archiveDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ): Promise<VehicleDocument> {
    return this.documents.archive(id, documentId, true);
  }

  @Post(':id/documents/:documentId/restore')
  @HttpCode(200)
  @Protected('fleet.manage', 'CONFIGURE')
  restoreDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ): Promise<VehicleDocument> {
    return this.documents.archive(id, documentId, false);
  }

  /**
   * Descarga del archivo de un documento (F6-Q5: privado). Siempre como adjunto: un PDF nunca se abre dentro de la
   * aplicación ni se ejecuta (CSP `sandbox`), y no se guarda en cachés compartidas.
   */
  @Get(':id/documents/:documentId/file')
  @Protected('fleet.manage', 'READ')
  async download(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.documents.download(id, documentId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(file.mime).send(file.body);
  }
}

/** Subida del archivo de un documento (PDF, JPEG o PNG en el cuerpo, hasta 10 MB); luego se referencia. */
@ApiTags('fleet')
@Controller({ path: 'vehicle-documents', version: '1' })
export class VehicleDocumentFilesController {
  constructor(private readonly documents: VehicleDocumentsService) {}

  @Post('files')
  @Protected('fleet.manage', 'CONFIGURE')
  upload(@Body() body: unknown): Promise<VehicleDocumentFile> {
    return this.documents.upload(body);
  }
}

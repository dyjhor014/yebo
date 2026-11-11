import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateLayoutAssignmentRequestSchema,
  CreateLayoutRequestSchema,
  EndLayoutAssignmentRequestSchema,
  SaveLayoutDraftRequestSchema,
  UpdateLayoutRequestSchema,
  type Layout,
  type LayoutAssignment,
  type LayoutAssignmentsResponse,
  type LayoutsResponse,
  type LayoutVersionDetail,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { Protected } from '../../access/route-policy';
import { LayoutsService } from '../layouts.service';

class CreateLayoutRequestDto extends createZodDto(CreateLayoutRequestSchema) {}
class UpdateLayoutRequestDto extends createZodDto(UpdateLayoutRequestSchema) {}
class SaveLayoutDraftRequestDto extends createZodDto(SaveLayoutDraftRequestSchema) {}
class CreateLayoutAssignmentRequestDto extends createZodDto(CreateLayoutAssignmentRequestSchema) {}
class EndLayoutAssignmentRequestDto extends createZodDto(EndLayoutAssignmentRequestSchema) {}

const versionOf = (v: string) => (/^\d{1,6}$/.test(v) ? Number(v) : -1);

/**
 * Layouts de los vehículos (Fase 6.3; permiso layouts.manage). Leer es READ; crear, guardar el borrador, publicar,
 * archivar y asignar son CONFIGURE (bloqueado en SUSPENDED, EXPIRED y CANCELLED; multitenancy §5).
 */
@ApiTags('layouts')
@Controller({ path: 'layouts', version: '1' })
export class LayoutsController {
  constructor(private readonly layouts: LayoutsService) {}

  @Get()
  @Protected('layouts.manage', 'READ')
  async list(): Promise<LayoutsResponse> {
    return { layouts: await this.layouts.list() };
  }

  @Post()
  @Protected('layouts.manage', 'CONFIGURE')
  create(@Body() body: CreateLayoutRequestDto): Promise<LayoutVersionDetail> {
    return this.layouts.create(body);
  }

  @Put(':id')
  @Protected('layouts.manage', 'CONFIGURE')
  update(@Param('id') id: string, @Body() body: UpdateLayoutRequestDto): Promise<Layout> {
    return this.layouts.update(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Protected('layouts.manage', 'CONFIGURE')
  archive(@Param('id') id: string): Promise<Layout> {
    return this.layouts.archive(id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Protected('layouts.manage', 'CONFIGURE')
  restore(@Param('id') id: string): Promise<Layout> {
    return this.layouts.archive(id, false);
  }

  @Get(':id/versions/:version')
  @Protected('layouts.manage', 'READ')
  version(@Param('id') id: string, @Param('version') version: string): Promise<LayoutVersionDetail> {
    return this.layouts.version(id, versionOf(version));
  }

  @Put(':id/draft')
  @Protected('layouts.manage', 'CONFIGURE')
  saveDraft(@Param('id') id: string, @Body() body: SaveLayoutDraftRequestDto): Promise<LayoutVersionDetail> {
    return this.layouts.saveDraft(id, body.document);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Protected('layouts.manage', 'CONFIGURE')
  publish(@Param('id') id: string): Promise<LayoutVersionDetail> {
    return this.layouts.publish(id);
  }

  @Post(':id/versions/:version/archive')
  @HttpCode(200)
  @Protected('layouts.manage', 'CONFIGURE')
  archiveVersion(@Param('id') id: string, @Param('version') version: string): Promise<LayoutVersionDetail> {
    return this.layouts.archiveVersion(id, versionOf(version));
  }
}

/** Qué versión de layout tiene cada vehículo y desde cuándo (Fase 6.3). */
@ApiTags('layouts')
@Controller({ path: 'vehicles', version: '1' })
export class VehicleLayoutAssignmentsController {
  constructor(private readonly layouts: LayoutsService) {}

  @Get(':id/layout-assignments')
  @Protected('layouts.manage', 'READ')
  async list(@Param('id') id: string): Promise<LayoutAssignmentsResponse> {
    return { assignments: await this.layouts.assignments(id) };
  }

  @Post(':id/layout-assignments')
  @Protected('layouts.manage', 'CONFIGURE')
  assign(@Param('id') id: string, @Body() body: CreateLayoutAssignmentRequestDto): Promise<LayoutAssignment> {
    return this.layouts.assign(id, body);
  }

  @Post(':id/layout-assignments/:assignmentId/end')
  @HttpCode(200)
  @Protected('layouts.manage', 'CONFIGURE')
  end(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: EndLayoutAssignmentRequestDto,
  ): Promise<LayoutAssignment> {
    return this.layouts.endAssignment(id, assignmentId, body.validTo);
  }
}

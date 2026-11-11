import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AssignBranchesRequestSchema,
  CreateBranchRequestSchema,
  LocationInputSchema,
  UpdateBranchRequestSchema,
  UpdateSalesChannelRequestSchema,
  type AssignBranchesResponse,
  type Branch,
  type BranchesResponse,
  type Location,
  type LocationsResponse,
  type SalesChannel,
  type SalesChannelsResponse,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { Protected } from '../../access/route-policy';
import { LocationsService } from '../locations.service';

class LocationInputDto extends createZodDto(LocationInputSchema) {}
class CreateBranchRequestDto extends createZodDto(CreateBranchRequestSchema) {}
class UpdateBranchRequestDto extends createZodDto(UpdateBranchRequestSchema) {}
class UpdateSalesChannelRequestDto extends createZodDto(UpdateSalesChannelRequestSchema) {}
class AssignBranchesRequestDto extends createZodDto(AssignBranchesRequestSchema) {}

/**
 * Ubicaciones de la empresa (Fase 6.1; permiso locations.manage). Leer es READ; crear, editar, archivar y restaurar
 * son CONFIGURE (bloqueado en SUSPENDED, EXPIRED y CANCELLED; multitenancy §5).
 */
@ApiTags('locations')
@Controller({ path: 'locations', version: '1' })
export class LocationsController {
  constructor(private readonly service: LocationsService) {}

  @Get()
  @Protected('locations.manage', 'READ')
  list(): Promise<LocationsResponse> {
    return this.service.locations();
  }

  @Post()
  @Protected('locations.manage', 'CONFIGURE')
  create(@Body() body: LocationInputDto): Promise<Location> {
    return this.service.createLocation(body);
  }

  @Put(':id')
  @Protected('locations.manage', 'CONFIGURE')
  update(@Param('id') id: string, @Body() body: LocationInputDto): Promise<Location> {
    return this.service.updateLocation(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Protected('locations.manage', 'CONFIGURE')
  archive(@Param('id') id: string): Promise<Location> {
    return this.service.archiveLocation(id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Protected('locations.manage', 'CONFIGURE')
  restore(@Param('id') id: string): Promise<Location> {
    return this.service.archiveLocation(id, false);
  }
}

/** Sucursales (Fase 6.1). Cada una nace con su mostrador; el código no cambia. */
@ApiTags('locations')
@Controller({ path: 'branches', version: '1' })
export class BranchesController {
  constructor(private readonly service: LocationsService) {}

  @Get()
  @Protected('locations.manage', 'READ')
  async list(): Promise<BranchesResponse> {
    return { branches: await this.service.branches() };
  }

  @Post()
  @Protected('locations.manage', 'CONFIGURE')
  create(@Body() body: CreateBranchRequestDto): Promise<Branch> {
    return this.service.createBranch(body);
  }

  @Put(':id')
  @Protected('locations.manage', 'CONFIGURE')
  update(@Param('id') id: string, @Body() body: UpdateBranchRequestDto): Promise<Branch> {
    return this.service.updateBranch(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Protected('locations.manage', 'CONFIGURE')
  archive(@Param('id') id: string): Promise<Branch> {
    return this.service.archiveBranch(id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @Protected('locations.manage', 'CONFIGURE')
  restore(@Param('id') id: string): Promise<Branch> {
    return this.service.archiveBranch(id, false);
  }
}

/** Canales de venta (Fase 6.1; ADR-020). Se renombran y se activan o desactivan; la clase no cambia. */
@ApiTags('locations')
@Controller({ path: 'sales-channels', version: '1' })
export class SalesChannelsController {
  constructor(private readonly service: LocationsService) {}

  @Get()
  @Protected('locations.manage', 'READ')
  async list(): Promise<SalesChannelsResponse> {
    return { channels: await this.service.channels() };
  }

  @Put(':id')
  @Protected('locations.manage', 'CONFIGURE')
  update(@Param('id') id: string, @Body() body: UpdateSalesChannelRequestDto): Promise<SalesChannel> {
    return this.service.updateChannel(id, body);
  }
}

/** Sucursales de una persona (F6-Q4): forma parte de la gestión de accesos (roles.assign). Vacío = todas. */
@ApiTags('access')
@Controller({ path: 'members', version: '1' })
export class MemberBranchesController {
  constructor(private readonly service: LocationsService) {}

  @Put(':membershipId/branches')
  @Protected('roles.assign', 'CONFIGURE')
  async assign(
    @Param('membershipId') membershipId: string,
    @Body() body: AssignBranchesRequestDto,
  ): Promise<AssignBranchesResponse> {
    return { membershipId, branchIds: await this.service.assignBranches(membershipId, body.branchIds) };
  }
}

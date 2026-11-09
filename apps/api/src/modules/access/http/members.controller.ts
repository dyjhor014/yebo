import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AssignRolesRequestSchema,
  type AssignRolesResponse,
  type MemberStatusResponse,
  type MembersResponse,
  type RevokeMemberSessionsResponse,
  type RolesResponse,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { MembersService } from '../members.service';
import { RolesService } from '../roles.service';
import { Protected } from '../route-policy';

class AssignRolesRequestDto extends createZodDto(AssignRolesRequestSchema) {}

/**
 * Gestión mínima de accesos de la empresa del host (Fase 3.3, decisión del 2026-11-10). Sin pantallas todavía.
 * Toda ruta declara su permiso y su categoría para la matriz de estados del tenant (multitenancy §5.1).
 */
@ApiTags('access')
@Controller({ path: 'members', version: '1' })
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @Protected('members.read', 'READ')
  async list(): Promise<MembersResponse> {
    return { members: await this.members.list() };
  }

  @Post(':membershipId/suspend')
  @HttpCode(200)
  @Protected('members.suspend', 'USERS_REDUCE')
  async suspend(@Param('membershipId') membershipId: string): Promise<MemberStatusResponse> {
    return { membershipId, ...(await this.members.suspend(membershipId)) };
  }

  /** Reactivar aumenta el consumo facturable (D5): categoría USERS_ADD. */
  @Post(':membershipId/reactivate')
  @HttpCode(200)
  @Protected('members.reactivate', 'USERS_ADD')
  async reactivate(@Param('membershipId') membershipId: string): Promise<MemberStatusResponse> {
    return { membershipId, ...(await this.members.reactivate(membershipId)) };
  }

  @Post(':membershipId/sessions/revoke')
  @HttpCode(200)
  @Protected('members.sessions.revoke', 'USERS_REDUCE')
  async revokeSessions(@Param('membershipId') membershipId: string): Promise<RevokeMemberSessionsResponse> {
    return { revokedSessions: await this.members.revokeSessions(membershipId) };
  }

  /** Asignar roles es configuración de la empresa: categoría CONFIGURE. */
  @Put(':membershipId/roles')
  @Protected('roles.assign', 'CONFIGURE')
  async assignRoles(
    @Param('membershipId') membershipId: string,
    @Body() body: AssignRolesRequestDto,
  ): Promise<AssignRolesResponse> {
    return { membershipId, roleIds: await this.members.assignRoles(membershipId, body.roleIds) };
  }
}

@ApiTags('access')
@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @Protected('roles.read', 'READ')
  async list(): Promise<RolesResponse> {
    return { roles: await this.roles.list() };
  }
}

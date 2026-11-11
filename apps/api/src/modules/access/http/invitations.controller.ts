import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateInvitationRequestSchema,
  type InvitationLink,
  type InvitationsResponse,
} from '@yebo/contracts';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { InvitationsService } from '../invitations.service';
import { Protected } from '../route-policy';

class CreateInvitationRequestDto extends createZodDto(CreateInvitationRequestSchema) {}

/** Invitaciones de la empresa (Fase 4.3b). Invitar es `USERS_ADD`: aumenta el consumo facturable. */
@ApiTags('access')
@Controller({ path: 'invitations', version: '1' })
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @Protected('members.read', 'READ')
  async list(): Promise<InvitationsResponse> {
    return { invitations: await this.invitations.list() };
  }

  @Post()
  @Protected('members.invite', 'USERS_ADD')
  create(
    @Body() body: CreateInvitationRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvitationLink> {
    // El enlace se muestra una vez: que ningún intermediario lo guarde.
    res.setHeader('Cache-Control', 'no-store');
    return this.invitations.create(body);
  }

  /** Revocar reduce el acceso posible: `USERS_REDUCE`. */
  @Post(':invitationId/revoke')
  @Protected('members.invite', 'USERS_REDUCE')
  @HttpCode(204)
  async revoke(@Param('invitationId') invitationId: string): Promise<void> {
    await this.invitations.revoke(invitationId);
  }
}

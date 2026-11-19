import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateFaresRequestSchema,
  EndFareRequestSchema,
  FareMatrixQuerySchema,
  FareQuoteQuerySchema,
  type CreateFaresResponse,
  type Fare,
  type FareMatrix,
  type FaresResponse,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';
import { AppError } from '../../../common/errors/app-error';
import { Protected } from '../../access/route-policy';
import { FaresService } from '../fares.service';

class CreateFaresRequestDto extends createZodDto(CreateFaresRequestSchema) {}
class EndFareRequestDto extends createZodDto(EndFareRequestSchema) {}

/** Valida los parámetros de la consulta con el esquema del contrato (400 con el primer problema). */
function parseQuery<S extends z.ZodType>(schema: S, query: Record<string, unknown>): z.infer<S> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(
      'VALIDATION_FAILED',
      `Parámetro no válido: ${issue?.path.join('.') || 'consulta'} (${issue?.message ?? ''})`,
      400,
    );
  }
  return parsed.data;
}

/**
 * Tarifas (Fase 7.2; permiso fares.manage). Consultar es READ; crear, terminar y anular son CONFIGURE (bloqueado en
 * SUSPENDED, EXPIRED y CANCELLED; multitenancy §5).
 */
@ApiTags('fares')
@Controller({ version: '1' })
export class FaresController {
  constructor(private readonly service: FaresService) {}

  @Get('routes/:routeId/fares')
  @Protected('fares.manage', 'READ')
  async list(@Param('routeId') routeId: string): Promise<FaresResponse> {
    return { fares: await this.service.list(routeId) };
  }

  /** Pares × clases de la ruta en una fecha (`?service=PASSENGER&date=AAAA-MM-DD`), con lo que falta. */
  @Get('routes/:routeId/fares/matrix')
  @Protected('fares.manage', 'READ')
  matrix(@Param('routeId') routeId: string, @Query() query: Record<string, unknown>): Promise<FareMatrix> {
    return this.service.matrix(routeId, parseQuery(FareMatrixQuerySchema, query));
  }

  /** Precio de A a B en una clase y una fecha (`?origin=…&destination=…&priceClass=…&date=…`). */
  @Get('routes/:routeId/fares/quote')
  @Protected('fares.manage', 'READ')
  quote(@Param('routeId') routeId: string, @Query() query: Record<string, unknown>): Promise<Fare> {
    return this.service.quote(routeId, parseQuery(FareQuoteQuerySchema, query));
  }

  @Post('routes/:routeId/fares')
  @Protected('fares.manage', 'CONFIGURE')
  create(
    @Param('routeId') routeId: string,
    @Body() body: CreateFaresRequestDto,
  ): Promise<CreateFaresResponse> {
    return this.service.create(routeId, body);
  }

  @Post('fares/:id/end')
  @HttpCode(200)
  @Protected('fares.manage', 'CONFIGURE')
  end(@Param('id') id: string, @Body() body: EndFareRequestDto): Promise<Fare> {
    return this.service.end(id, body.validTo);
  }

  @Post('fares/:id/cancel')
  @HttpCode(200)
  @Protected('fares.manage', 'CONFIGURE')
  cancel(@Param('id') id: string): Promise<Fare> {
    return this.service.cancel(id);
  }
}

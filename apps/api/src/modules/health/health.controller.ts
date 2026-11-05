import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthResponseSchema } from '@yebo/contracts';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { HealthService } from './health.service';

class HealthResponseDto extends createZodDto(HealthResponseSchema) {}

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: el proceso responde. No consulta dependencias (evita reinicios en cascada). */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: dependencias críticas disponibles (PostgreSQL con ambos roles y Redis). */
  @Get('ready')
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiServiceUnavailableResponse({ type: HealthResponseDto })
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthResponseDto> {
    const result = await this.health.readiness();
    if (result.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}

import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { GlobalExceptionFilter } from '../common/errors/global-exception.filter';
import { ENV, EnvModule } from '../config/env.module';
import type { Env } from '../config/env';
import { DatabaseModule } from './database/database.module';
import { buildPinoHttpOptions } from './logging/pino-options';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';

/** Infraestructura común a los procesos API y worker (ADR-001). */
@Module({
  imports: [
    EnvModule,
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) => (req as Request & { id?: string }).id ?? 'unknown',
      },
    }),
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ pinoHttp: buildPinoHttpOptions(env) }),
    }),
    DatabaseModule,
    RedisModule,
    QueueModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class CoreModule {}

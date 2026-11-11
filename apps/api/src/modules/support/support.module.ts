import { Module } from '@nestjs/common';
import { SupportAccessController } from './http/support-access.controller';

/** Accesos de soporte vistos y gestionados por la empresa (Fase 4.6). El lado del staff vive en platform-admin. */
@Module({ controllers: [SupportAccessController] })
export class SupportModule {}

import { Module } from '@nestjs/common';
import { ObligationsController } from './http/obligations.controller';

/** Facturación SaaS vista por la empresa (Fase 4.5). El cálculo y el cierre viven en el worker (metering). */
@Module({ controllers: [ObligationsController] })
export class BillingModule {}

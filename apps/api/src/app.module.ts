import { Module } from '@nestjs/common';
import { CoreModule } from './infrastructure/core.module';
import { HealthModule } from './modules/health/health.module';

/** Proceso API (HTTP). Los módulos de negocio se incorporan a partir de la Fase 3. */
@Module({
  imports: [CoreModule, HealthModule.forService('api')],
})
export class AppModule {}

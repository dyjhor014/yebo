import { Module } from '@nestjs/common';
import { CoreModule } from './infrastructure/core.module';
import { HealthModule } from './modules/health/health.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';

/** Proceso API (HTTP). */
@Module({
  imports: [CoreModule, HealthModule.forService('api'), TenancyModule],
})
export class AppModule {}

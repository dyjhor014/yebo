import { Module, type DynamicModule } from '@nestjs/common';
import type { HealthResponse } from '@yebo/contracts';
import { HealthController } from './health.controller';
import { HEALTH_SERVICE_NAME, HealthService } from './health.service';

@Module({})
export class HealthModule {
  static forService(service: HealthResponse['service']): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [HealthService, { provide: HEALTH_SERVICE_NAME, useValue: service }],
    };
  }
}

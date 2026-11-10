import { Module } from '@nestjs/common';
import { CoreModule } from './infrastructure/core.module';
import { AccessModule } from './modules/access/access.module';
import { BillingModule } from './modules/billing/billing.module';
import { SiteModule } from './modules/site/site.module';
import { SupportModule } from './modules/support/support.module';
import { HealthModule } from './modules/health/health.module';
import { ClockModule } from './modules/identity/clock.module';
import { IdentityModule } from './modules/identity/identity.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';

/** Proceso API (HTTP). */
@Module({
  imports: [
    CoreModule,
    ClockModule,
    HealthModule.forService('api'),
    TenancyModule,
    IdentityModule,
    AccessModule,
    BillingModule,
    SupportModule,
    SiteModule,
  ],
})
export class AppModule {}

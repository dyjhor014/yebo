import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AccessTokenService } from './access-token.service';
import { AuthorizationCodeService } from './authorization-code.service';
import { ClockModule } from './clock.module';
import { HubAuthService } from './hub-auth.service';
import { InvitationAcceptanceService } from './invitation-acceptance.service';
import { AuthController } from './http/auth.controller';
import { CookieSigner } from './http/cookie-signer';
import { HubController } from './http/hub.controller';
import { HubHostGuard } from './http/hub-host.guard';
import { IdentityPrismaService } from './identity-prisma.service';
import { PasswordHasher } from './password-hasher';
import { RateLimiterService } from './rate-limiter.service';
import { SessionService } from './session.service';
import { UserDirectoryService } from './user-directory.service';

/**
 * Módulo de plataforma (capa L0): identidad, contraseñas, sesiones, tokens y hub de cuentas
 * (D3, ADR-005, ADR-009, ADR-022).
 * - Usa el rol dedicado `yebo_identity` a través de IdentityPrismaService, que NO se exporta: ningún otro módulo
 *   puede inyectarlo (DI) ni importarlo (regla de ESLint).
 * - Las operaciones de empresa toman el tenant del contexto del request.
 * - 3.2b: hub (`/api/v1/hub/*`, solo en AUTH_HUB_HOST) y sesión de empresa (`/api/v1/auth/*`, host del tenant).
 */
@Module({
  imports: [ClockModule, TenancyModule, PermissionsModule],
  controllers: [HubController, AuthController],
  providers: [
    IdentityPrismaService,
    PasswordHasher,
    AccessTokenService,
    SessionService,
    AuthorizationCodeService,
    HubAuthService,
    RateLimiterService,
    CookieSigner,
    HubHostGuard,
    UserDirectoryService,
    InvitationAcceptanceService,
  ],
  exports: [
    PasswordHasher,
    AccessTokenService,
    SessionService,
    UserDirectoryService,
    RateLimiterService,
    CookieSigner,
  ],
})
export class IdentityModule {}

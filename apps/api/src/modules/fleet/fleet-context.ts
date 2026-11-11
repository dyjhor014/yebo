import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { Clock } from '../identity/clock';

/** Zona por defecto si el tenant resuelto aún no la trae (caché anterior a la 6.2; como mucho 60 s). */
const DEFAULT_TIMEZONE = 'America/Lima';

/** Contexto de la flota: empresa del host, autor, reloj y «hoy» en la zona horaria de la empresa. */
@Injectable()
export class FleetContext {
  constructor(
    private readonly cls: ClsService<RequestContextStore>,
    private readonly clock: Clock,
  ) {}

  tenantId(): string {
    const id = this.cls.get('tenantId');
    if (!id) throw new Error('La flota requiere el tenant del host');
    return id;
  }

  actor(): { kind: 'MEMBERSHIP' | 'PLATFORM_USER'; id: string } {
    const principal = this.cls.get('principal');
    if (principal) return { kind: 'MEMBERSHIP', id: principal.membershipId };
    const support = this.cls.get('supportPrincipal');
    if (support) return { kind: 'PLATFORM_USER', id: support.platformUserId };
    throw new Error('La flota requiere una sesión verificada');
  }

  now(): Date {
    return this.clock.now();
  }

  /** Fecha de calendario `AAAA-MM-DD` de hoy para la empresa (los vencimientos son de su calendario). */
  today(): string {
    const timeZone = this.cls.get('tenant')?.timezone ?? DEFAULT_TIMEZONE;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(this.clock.now());
  }
}

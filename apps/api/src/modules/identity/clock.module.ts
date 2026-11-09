import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from './clock';

/**
 * Reloj de la aplicación, global (Fase 4.2): lo usan identidad, plataforma y acceso sin crear ciclos entre módulos.
 * Las pruebas lo sustituyen con `overrideProvider(Clock)`.
 */
@Global()
@Module({ providers: [{ provide: Clock, useClass: SystemClock }], exports: [Clock] })
export class ClockModule {}

import { Injectable } from '@nestjs/common';

/**
 * Fuente de tiempo de identidad. Las fechas de sesiones y tokens las pone el servidor, nunca el cliente.
 * Inyectable para que las pruebas controlen la ventana de gracia y las expiraciones.
 */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

import { z } from 'zod';

/**
 * Fase 7.3b · Programaciones (data-dictionary §5; F7-Q2).
 * - Un subconjunto de RRULE: **diaria** o **semanal por días** (`FREQ=DAILY` / `FREQ=WEEKLY;BYDAY=MO,WE,FR`), una hora
 *   de salida local de la empresa, vigencia `[desde, hasta)` y fechas excluidas (feriados, mantenimiento).
 * - Genera viajes SCHEDULED hasta SCHEDULE_HORIZON_DAYS días (hoy incluido), con el botón «Generar» y un job diario del
 *   worker. Generar es idempotente: un viaje por programación y fecha, y uno generado y cancelado no se regenera.
 * - Cada viaje generado lleva la unidad y el plano por defecto si la unidad está libre en ese horario; si no, se crea
 *   sin unidad y se informa el motivo. Si la ruta ya tiene otro viaje a esa hora, esa fecha se omite.
 * - Editar una programación no cambia los viajes ya generados.
 */

export const SCHEDULE_HORIZON_DAYS = 60;
export const SCHEDULE_MAX_EXCLUDED_DATES = 100;

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export const WeekdaySchema = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof WeekdaySchema>;

export const RecurrenceSchema = z.discriminatedUnion('frequency', [
  z.object({ frequency: z.literal('DAILY') }).strict(),
  z
    .object({
      frequency: z.literal('WEEKLY'),
      weekdays: z
        .array(WeekdaySchema)
        .min(1, 'Elige al menos un día')
        .max(7)
        .refine((d) => new Set(d).size === d.length, 'Días repetidos'),
    })
    .strict(),
]);
export type Recurrence = z.infer<typeof RecurrenceSchema>;

/** RRULE normalizada: los días en orden de la semana. */
export function toRRule(r: Recurrence): string {
  if (r.frequency === 'DAILY') return 'FREQ=DAILY';
  return `FREQ=WEEKLY;BYDAY=${WEEKDAYS.filter((d) => r.weekdays.includes(d)).join(',')}`;
}

/** Lee el subconjunto de RRULE que guarda la base. */
export function fromRRule(rule: string): Recurrence {
  if (rule === 'FREQ=DAILY') return { frequency: 'DAILY' };
  const m = /^FREQ=WEEKLY;BYDAY=([A-Z,]+)$/.exec(rule);
  if (!m?.[1]) throw new Error(`RRULE no soportada: ${rule}`);
  return { frequency: 'WEEKLY', weekdays: m[1].split(',') as Weekday[] };
}

/** ¿La fecha `AAAA-MM-DD` cae en la recurrencia? */
export function occursOn(r: Recurrence, date: string): boolean {
  if (r.frequency === 'DAILY') return true;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return r.weekdays.includes(WEEKDAYS[(dow + 6) % 7] as Weekday);
}

const ScheduleCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/, 'Código de 2 a 24 letras, números o guiones');

const IsoDate = z.iso.date();

const scheduleFields = {
  recurrence: RecurrenceSchema,
  departureTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:mm'),
  validFrom: IsoDate,
  validTo: IsoDate.nullable(),
  excludedDates: z.array(IsoDate).max(SCHEDULE_MAX_EXCLUDED_DATES),
  /** Unidad por defecto de los viajes generados (null: se generan sin unidad). */
  vehicleId: z.uuid().nullable(),
  /** Plano por defecto (null: el asignado a la unidad el día de cada salida). */
  layout: z
    .object({ layoutId: z.uuid(), version: z.number().int().min(1) })
    .strict()
    .nullable(),
};

const scheduleRules = (
  s: {
    validFrom: string;
    validTo: string | null;
    excludedDates: string[];
    vehicleId: string | null;
    layout: unknown;
  },
  ctx: z.RefinementCtx,
) => {
  if (s.validTo !== null && s.validTo <= s.validFrom) {
    ctx.addIssue({ code: 'custom', message: 'El fin es posterior al inicio', path: ['validTo'] });
  }
  if (new Set(s.excludedDates).size !== s.excludedDates.length) {
    ctx.addIssue({ code: 'custom', message: 'Fechas excluidas repetidas', path: ['excludedDates'] });
  }
  if (s.layout !== null && s.vehicleId === null) {
    ctx.addIssue({ code: 'custom', message: 'Elige la unidad antes que el plano', path: ['layout'] });
  }
};

export const CreateScheduleRequestSchema = z
  .object({ code: ScheduleCodeSchema, routeId: z.uuid(), ...scheduleFields })
  .strict()
  .superRefine(scheduleRules);
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

/** El código y la ruta no cambian. Los viajes ya generados tampoco. */
export const UpdateScheduleRequestSchema = z.object(scheduleFields).strict().superRefine(scheduleRules);
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequestSchema>;

export const ScheduleSchema = z.object({
  id: z.string(),
  code: z.string(),
  routeId: z.string(),
  routeCode: z.string(),
  routeName: z.string(),
  recurrence: RecurrenceSchema,
  rrule: z.string(),
  departureTime: z.string(),
  timezone: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  excludedDates: z.array(z.string()),
  vehicle: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  layout: z.object({ layoutId: z.string(), name: z.string(), version: z.number().int() }).nullable(),
  archived: z.boolean(),
  /** Última fecha (exclusiva) hasta la que se generó, y cuándo. */
  generatedUntil: z.string().nullable(),
  lastGeneratedAt: z.string().nullable(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const SchedulesResponseSchema = z.object({ schedules: z.array(ScheduleSchema) });
export type SchedulesResponse = z.infer<typeof SchedulesResponseSchema>;

/** Resultado de generar: lo creado, lo que ya existía, lo omitido y lo creado sin unidad, con su motivo. */
export const GenerateScheduleResponseSchema = z.object({
  scheduleId: z.string(),
  /** Fechas consideradas: `[from, until)`. */
  from: z.string(),
  until: z.string(),
  created: z.array(
    z.object({ tripId: z.string(), code: z.string(), date: z.string(), vehicleCode: z.string().nullable() }),
  ),
  existing: z.number().int(),
  skipped: z.array(z.object({ date: z.string(), reason: z.string() })),
  withoutUnit: z.array(z.object({ date: z.string(), reason: z.string() })),
});
export type GenerateScheduleResponse = z.infer<typeof GenerateScheduleResponseSchema>;

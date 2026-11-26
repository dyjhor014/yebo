'use client';

import type {
  EquipmentCategory,
  EquipmentStatus,
  InspectionResult,
  InspectionStatus,
  InspectionSummary,
  VehicleEquipment,
} from '@yebo/contracts';
import type { ReactNode } from 'react';
import { fmtDate, type ChipTone } from '@/components/panel/kit';
import { fmtLocal } from '@/components/trips/trip-kit';

/** Piezas comunes del equipamiento y las inspecciones (Fase 7.5c, maqueta 7.5 aprobada; API de la 7.E1). */

export const CATEGORY_NAME: Record<EquipmentCategory, string> = {
  SAFETY: 'Seguridad',
  EMERGENCY: 'Emergencia',
  OPERATION: 'Operación',
};

export const EQUIPMENT_STATUS: Record<EquipmentStatus, { label: string; tone: ChipTone }> = {
  OPERATIVE: { label: 'Operativo', tone: 'ok' },
  DETERIORATED: { label: 'Deteriorado', tone: 'warn' },
  INOPERATIVE: { label: 'No operativo', tone: 'bad' },
  UNVERIFIED: { label: 'Sin verificar', tone: 'none' },
};

export const INSPECTION_STATUS: Record<InspectionStatus, { label: string; tone: ChipTone }> = {
  DRAFT: { label: 'Borrador', tone: 'none' },
  COMPLETED: { label: 'Completada', tone: 'ok' },
  COMPLETED_WITH_OBSERVATIONS: { label: 'Con observaciones', tone: 'warn' },
};

/** Vencimiento del elemento declarado: el texto y su tono (null si no tiene fecha). */
export function expiryOf(e: Pick<VehicleEquipment, 'expiresOn' | 'expiry'>): {
  text: string;
  tone: ChipTone | null;
} {
  if (!e.expiresOn) return { text: '—', tone: null };
  if (e.expiry === 'EXPIRED') return { text: `Venció el ${fmtDate(e.expiresOn)}`, tone: 'bad' };
  if (e.expiry === 'EXPIRING') return { text: `Vence el ${fmtDate(e.expiresOn)}`, tone: 'warn' };
  return { text: fmtDate(e.expiresOn), tone: null };
}

/** Instante ISO → «AAAA-MM-DDTHH:mm» en Lima (las fechas de inspección llegan como instantes). */
export function isoToLocal(iso: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** «lun. 23 nov. 06:40» de un instante. */
export const fmtInstant = (iso: string) => fmtLocal(isoToLocal(iso));

/** Quién hizo la inspección: quien la completó o, en borrador, quien la empezó. */
export const inspectorOf = (i: Pick<InspectionSummary, 'completedBy' | 'startedBy'>) =>
  (i.completedBy ?? i.startedBy).name ?? 'Una persona de la empresa';

/** Cuándo: al completar o, en borrador, al empezar. */
export const whenOf = (i: Pick<InspectionSummary, 'completedAt' | 'startedAt'>) =>
  fmtInstant(i.completedAt ?? i.startedAt);

/**
 * Los cuatro resultados (maqueta 7.5): cada uno con color, ícono y texto, para que no dependa solo del color.
 * Sin marcar: superficie suave con el texto en el color del estado; marcado: relleno sólido con texto claro.
 * Contraste medido en claro y oscuro (semantic.css): todos ≥ 5,4:1.
 */
export const RESULTS: readonly {
  id: InspectionResult;
  label: string;
  soft: string;
  solid: string;
  icon: ReactNode;
}[] = [
  {
    id: 'CONFORMING',
    label: 'Conforme',
    soft: 'border-success/40 bg-success-surface text-success',
    solid: 'border-success bg-success text-raised',
    icon: <path d="M4 12.5 9.5 18 20 6" />,
  },
  {
    id: 'OBSERVED',
    label: 'Observado',
    soft: 'border-warning/40 bg-warning-surface text-warning',
    solid: 'border-warning bg-warning text-raised',
    icon: <path d="M12 4v10M12 19.5v.5" />,
  },
  {
    id: 'NOT_OPERATIONAL',
    label: 'No operativo',
    soft: 'border-danger/40 bg-danger-surface text-danger',
    solid: 'border-danger bg-danger text-raised',
    icon: <path d="M6 6l12 12M18 6 6 18" />,
  },
  {
    id: 'NOT_AVAILABLE',
    label: 'No disponible',
    soft: 'border-control bg-ink/8 text-ink',
    solid: 'border-ink-muted bg-ink-muted text-raised',
    icon: <path d="M5 12h14" />,
  },
];

export const RESULT_NAME = Object.fromEntries(RESULTS.map((r) => [r.id, r.label])) as Record<
  InspectionResult,
  string
>;

export function ResultIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-5 shrink-0"
    >
      {children}
    </svg>
  );
}

/** El resultado ya marcado, en solo lectura (inspección completada): mismo color, ícono y texto. */
export function ResultBadge({ result }: { result: InspectionResult }) {
  const r = RESULTS.find((x) => x.id === result)!;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.8125rem] font-bold whitespace-nowrap ${r.soft}`}
    >
      <ResultIcon>{r.icon}</ResultIcon>
      {r.label}
    </span>
  );
}

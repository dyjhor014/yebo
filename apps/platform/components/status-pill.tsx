import type { TenantStatus } from '@yebo/contracts';
import { STATUS_LABEL, STATUS_TONE, type StatusTone } from '@/lib/tenants';

const TONE: Record<StatusTone, string> = {
  ok: 'bg-action/20 text-ink',
  warning: 'bg-warning-surface text-warning',
  danger: 'bg-danger-surface text-danger',
  neutral: 'bg-ink/5 text-ink',
};

/** Estado siempre con texto; el color acompaña (nunca es la única señal). */
export function Pill({ tone, children }: { tone: StatusTone; children: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[0.8125rem] font-semibold whitespace-nowrap ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: TenantStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>;
}

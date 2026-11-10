'use client';

import {
  PlansResponseSchema,
  TenantBillingResponseSchema,
  TenantDetailSchema,
  TenantUsageResponseSchema,
  type Plan,
  type PlanVersion,
  type TenantBillingResponse,
  type TenantDetail,
  type TenantUsageResponse,
} from '@yebo/contracts';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { can, useSession } from '@/components/session';
import { DANGER_LINK, LINK, SECONDARY, Success } from '@/components/ui';
import { ApiError, get } from '@/lib/api';
import { addDays, date, today } from '@/lib/format';
import { journey } from '@/lib/journey';
import { STATUS_LABEL, operationLine } from '@/lib/tenants';
import { ChangePlan } from './actions/change-plan';
import { ChangeStatus } from './actions/change-status';
import { InviteToTenant } from './actions/invite-to-tenant';
import { OpenSupport } from './actions/open-support';
import { BillingTab, periodLastDay } from './billing-tab';
import { HistoryTab } from './history-tab';
import { ModulesTab } from './modules-tab';
import { SummaryTab } from './summary-tab';
import { SupportTab } from './support-tab';

type Data = {
  tenant: TenantDetail;
  billing: TenantBillingResponse;
  plans: Plan[];
  plan: { name: string; version: PlanVersion } | null;
  usage: TenantUsageResponse | null;
};

const TABS = [
  { key: 'resumen', label: 'Resumen' },
  { key: 'facturacion', label: 'Facturación y consumo' },
  { key: 'soporte', label: 'Accesos de soporte', permission: 'platform.support.access' },
  { key: 'modulos', label: 'Módulos y excepciones' },
  { key: 'historial', label: 'Historial' },
] as const;
type TabKey = (typeof TABS)[number]['key'];
type Action = 'invite' | 'plan' | 'support' | 'status' | null;

/** Ficha de empresa (maqueta 4.7 v2): cabecera con acciones, trayecto de estados y cinco pestañas. */
export function TenantFile({ tenantId }: { tenantId: string }) {
  const session = useSession();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const tabs = TABS.filter((t) => !('permission' in t) || can(session, t.permission));
  const requested = params.get('seccion') as TabKey | null;
  const tab: TabKey = tabs.some((t) => t.key === requested) ? (requested as TabKey) : 'facturacion';
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [supportKey, setSupportKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const base = `/api/v1/platform/tenants/${tenantId}`;
      const [tenant, billing, plans] = await Promise.all([
        get(base, TenantDetailSchema),
        get(`${base}/billing`, TenantBillingResponseSchema),
        get('/api/v1/platform/plans', PlansResponseSchema),
      ]);
      const sub = tenant.subscription;
      const found = sub
        ? plans.plans
            .flatMap((p) => p.versions.map((v) => ({ name: p.name, version: v })))
            .find((x) => x.version.id === sub.planVersionId)
        : undefined;
      const usage = sub
        ? await get(
            `${base}/usage?from=${sub.currentPeriodStart}&to=${addDays(sub.currentPeriodEnd, -1)}`,
            TenantUsageResponseSchema,
          )
        : null;
      setData({ tenant, billing, plans: plans.plans, plan: found ?? null, usage });
    } catch (e) {
      setError(
        e instanceof ApiError
          ? { status: e.status, message: e.message }
          : { status: 0, message: 'No se pudo cargar la ficha. Recarga la página.' },
      );
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb name={null} />
        <p role="alert" className="rounded-[var(--radius-control)] bg-danger-surface px-4 py-3 text-danger">
          {error.status === 404 ? 'Esta empresa no existe.' : error.message}
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <p role="status" className="text-ink-muted">
        Cargando la ficha…
      </p>
    );
  }

  const { tenant, billing, plan, usage, plans } = data;
  const tz = tenant.timezone;
  const policy = plan?.version.suspensionPolicy;
  const grace = policy?.pastDueGraceDays ?? 7;
  const trip = journey({
    status: tenant.status,
    timezone: tz,
    statusChangedAt: tenant.statusChangedAt,
    trialEndsAt: tenant.trialEndsAt,
    cancelledAt: tenant.cancelledAt,
    history: [...tenant.statusHistory].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
    periodLastDay: periodLastDay(tenant),
    pastDueGraceDays: grace,
    cancelledClosingDays: policy?.cancelledClosingDays ?? 30,
  });
  const suspendsOn =
    tenant.status === 'PAST_DUE' ? date(addDays(today(tz, new Date(tenant.statusChangedAt)), grace)) : null;
  const host = tenant.domains.find((d) => d.isPrimary)?.host ?? null;
  const enabled = tenant.services.filter((s) => s.enabled);
  const select = (key: TabKey) => router.replace(`${path}?seccion=${key}`, { scroll: false });

  return (
    <>
      <Breadcrumb name={tenant.tradeName} />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-[1.875rem] font-extrabold tracking-[-0.02em]">
            {tenant.tradeName}
          </h1>
          <p className="text-sm text-ink-muted">
            {[
              host,
              operationLine({
                modalities: [...new Set(enabled.map((s) => s.modality))],
                services: [...new Set(enabled.map((s) => s.service))],
              }),
              `${tenant.taxIdType} ${tenant.taxId}`,
              tz === 'America/Lima' ? 'hora de Lima' : tz,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {can(session, 'platform.tenants.manage') && tenant.status !== 'CANCELLED' && (
            <button type="button" onClick={() => setAction('invite')} className={SECONDARY}>
              Invitar a la empresa
            </button>
          )}
          {can(session, 'platform.billing.manage') && tenant.subscription && (
            <button type="button" onClick={() => setAction('plan')} className={SECONDARY}>
              Cambiar plan
            </button>
          )}
          {can(session, 'platform.support.access') && tenant.status !== 'CANCELLED' && (
            <button type="button" onClick={() => setAction('support')} className={SECONDARY}>
              Abrir acceso de soporte
            </button>
          )}
          {can(session, 'platform.tenants.manage') && tenant.status !== 'CANCELLED' && (
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => setAction('status')}
              className={DANGER_LINK}
            >
              Suspender o cancelar…
            </button>
          )}
        </div>
      </header>

      <section
        aria-label="Trayecto de la empresa"
        className="yebo-rail flex flex-col gap-3.5 rounded-xl bg-rail px-6 py-5 text-on-rail"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[0.8125rem] font-semibold text-on-rail-muted">
            Trayecto · ahora: {STATUS_LABEL[tenant.status]}
          </span>
          <span className="text-[0.9375rem] font-semibold text-rail-highlight">{trip.next}</span>
        </div>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {trip.stops.map((s) => (
            <li
              key={s.status}
              aria-current={s.state === 'current' ? 'step' : undefined}
              className="flex flex-col gap-2"
            >
              <span
                className={`h-1 rounded-full ${s.state === 'current' ? 'bg-rail-highlight' : s.state === 'done' ? 'bg-rail-accent' : 'bg-rail-track'}`}
              />
              <span className={`text-sm font-semibold ${s.state === 'pending' ? 'text-on-rail-muted' : ''}`}>
                {s.label}
                {s.state === 'current' && <span className="sr-only"> (estado actual)</span>}
              </span>
              <span className="text-[0.8125rem] text-on-rail-muted">{s.note}</span>
            </li>
          ))}
        </ol>
      </section>

      {notice && <Success>{notice}</Success>}

      <nav aria-label="Secciones de la empresa" className="flex flex-wrap gap-1 border-b border-divider">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`${path}?seccion=${t.key}`}
            scroll={false}
            onClick={(e) => {
              e.preventDefault();
              select(t.key);
            }}
            aria-current={t.key === tab ? 'page' : undefined}
            className={`-mb-px inline-flex min-h-11 items-center px-3.5 ${t.key === tab ? 'border-b-[3px] border-control-strong font-semibold' : 'font-medium text-ink-muted hover:text-ink'}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'resumen' && <SummaryTab tenant={tenant} />}
      {tab === 'facturacion' && (
        <BillingTab
          tenant={tenant}
          billing={billing}
          plan={plan}
          usage={usage}
          suspendsOn={suspendsOn}
          onChanged={() => void load()}
        />
      )}
      {tab === 'soporte' && <SupportTab tenantId={tenant.id} timezone={tz} refreshKey={supportKey} />}
      {tab === 'modulos' && <ModulesTab tenantId={tenant.id} timezone={tz} />}
      {tab === 'historial' && <HistoryTab tenant={tenant} />}

      {action === 'invite' && (
        <InviteToTenant
          tenantId={tenant.id}
          tradeName={tenant.tradeName}
          host={host}
          onClose={() => setAction(null)}
        />
      )}
      {action === 'plan' && (
        <ChangePlan
          tenantId={tenant.id}
          tradeName={tenant.tradeName}
          plans={plans}
          currentVersionId={tenant.subscription?.planVersionId ?? null}
          onClose={() => setAction(null)}
          onChanged={() => void load()}
        />
      )}
      {action === 'support' && (
        <OpenSupport
          tenantId={tenant.id}
          tradeName={tenant.tradeName}
          onClose={() => setAction(null)}
          onOpened={() => {
            setSupportKey((k) => k + 1);
          }}
        />
      )}
      {action === 'status' && (
        <ChangeStatus
          tenant={tenant}
          onClose={() => setAction(null)}
          onChanged={(t) => {
            setAction(null);
            setNotice(`La empresa pasó a «${STATUS_LABEL[t.status]}».`);
            void load();
          }}
        />
      )}
    </>
  );
}

function Breadcrumb({ name }: { name: string | null }) {
  return (
    <nav aria-label="Ruta" className="text-sm text-ink-muted">
      <Link href="/empresas" className={LINK}>
        Empresas
      </Link>
      {name && (
        <>
          {' '}
          <span aria-hidden="true">/</span> <span aria-current="page">{name}</span>
        </>
      )}
    </nav>
  );
}

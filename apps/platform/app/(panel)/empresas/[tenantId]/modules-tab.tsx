'use client';

import {
  ModuleOverridesResponseSchema,
  OperationOverridesResponseSchema,
  PlatformModulesResponseSchema,
  type ModuleOverride,
  type OperationOverride,
  type PlatformModulesResponse,
} from '@yebo/contracts';
import { useCallback, useEffect, useState } from 'react';
import { can, useSession } from '@/components/session';
import { Alert, Input, PRIMARY, Select, Textarea } from '@/components/ui';
import { ApiError, get, post } from '@/lib/api';
import { addDays, today } from '@/lib/format';

/**
 * Pestaña «Módulos y excepciones»: excepciones de módulo (conceder o retirar un módulo fuera del plan, F4-Q2) y de
 * operación (permitir altas de usuarios en un estado que las bloquea, como mucho 30 días).
 */
export function ModulesTab({ tenantId, timezone }: { tenantId: string; timezone: string }) {
  const session = useSession();
  const manage = can(session, 'platform.tenants.manage');
  const [modules, setModules] = useState<PlatformModulesResponse['modules']>([]);
  const [mods, setMods] = useState<ModuleOverride[] | null>(null);
  const [ops, setOps] = useState<OperationOverride[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeZone: timezone });
  const base = `/api/v1/platform/tenants/${tenantId}`;

  const load = useCallback(() => {
    Promise.all([
      get(`${base}/module-overrides`, ModuleOverridesResponseSchema),
      get(`${base}/operation-overrides`, OperationOverridesResponseSchema),
    ])
      .then(([m, o]) => {
        setMods(m.overrides);
        setOps(o.overrides);
      })
      .catch((e: Error) => setFailure(e.message));
  }, [base]);
  useEffect(load, [load]);
  useEffect(() => {
    get('/api/v1/platform/modules', PlatformModulesResponseSchema)
      .then((r) => setModules(r.modules))
      .catch(() => setModules([]));
  }, []);

  async function end(path: string) {
    setFailure(null);
    try {
      await post(path);
      load();
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo terminar la excepción.');
    }
  }

  const name = (code: string) => modules.find((m) => m.code === code)?.name ?? code;
  const until = (iso: string | null) => (iso ? `hasta el ${fmt.format(new Date(iso))}` : 'sin fecha de fin');

  return (
    <div className="flex flex-col gap-5">
      {failure && <Alert>{failure}</Alert>}
      <section aria-labelledby="exc-mod" className="rounded-xl border border-divider bg-raised">
        <h2 id="exc-mod" className="border-b border-divider px-5 py-4 font-display text-lg font-bold">
          Excepciones de módulo
        </h2>
        {mods?.length === 0 && (
          <p className="px-5 py-5 text-ink-muted">
            Sin excepciones: la empresa tiene los módulos de su plan.
          </p>
        )}
        <ul>
          {mods?.map((o) => (
            <li
              key={o.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-divider px-5 py-3.5 first:border-t-0"
            >
              <span>
                <strong>{o.effect === 'GRANT' ? 'Concede' : 'Retira'}</strong> {name(o.moduleCode)} ·{' '}
                {until(o.validTo)}
                <span className="block text-sm text-ink-muted">
                  {o.reason}
                  {o.endedAt && ` · terminada el ${fmt.format(new Date(o.endedAt))}`}
                </span>
              </span>
              {manage && !o.endedAt && (
                <button
                  type="button"
                  onClick={() => end(`/api/v1/platform/tenants/${tenantId}/module-overrides/${o.id}/end`)}
                  className="min-h-11 px-2 font-semibold text-danger underline underline-offset-4"
                >
                  Terminar
                </button>
              )}
            </li>
          ))}
        </ul>
        {manage && modules.length > 0 && (
          <NewModuleOverride tenantId={tenantId} modules={modules} onCreated={load} />
        )}
      </section>

      <section aria-labelledby="exc-op" className="rounded-xl border border-divider bg-raised">
        <h2 id="exc-op" className="border-b border-divider px-5 py-4 font-display text-lg font-bold">
          Excepciones de operación
        </h2>
        {ops?.length === 0 && <p className="px-5 py-5 text-ink-muted">Sin excepciones de operación.</p>}
        <ul>
          {ops?.map((o) => (
            <li
              key={o.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-divider px-5 py-3.5 first:border-t-0"
            >
              <span>
                <strong>Permite dar de alta usuarios</strong> · del {fmt.format(new Date(o.validFrom))}{' '}
                {until(o.validTo)}
                <span className="block text-sm text-ink-muted">
                  {o.reason}
                  {o.endedAt && ` · terminada el ${fmt.format(new Date(o.endedAt))}`}
                </span>
              </span>
              {manage && !o.endedAt && (
                <button
                  type="button"
                  onClick={() => end(`${base}/operation-overrides/${o.id}/end`)}
                  className="min-h-11 px-2 font-semibold text-danger underline underline-offset-4"
                >
                  Terminar
                </button>
              )}
            </li>
          ))}
        </ul>
        {manage && <NewOperationOverride tenantId={tenantId} timezone={timezone} onCreated={load} />}
      </section>
    </div>
  );
}

function NewModuleOverride({
  tenantId,
  modules,
  onCreated,
}: {
  tenantId: string;
  modules: PlatformModulesResponse['modules'];
  onCreated: () => void;
}) {
  const [code, setCode] = useState(modules[0]?.code ?? '');
  const [effect, setEffect] = useState<'GRANT' | 'REVOKE'>('GRANT');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const reasonError = tried && reason.trim().length < 3 ? 'Escribe el motivo (al menos 3 caracteres).' : null;
  async function create() {
    setTried(true);
    if (reason.trim().length < 3) return;
    setFailure(null);
    try {
      await post(`/api/v1/platform/tenants/${tenantId}/module-overrides`, {
        moduleCode: code,
        effect,
        reason: reason.trim(),
      });
      setReason('');
      setTried(false);
      onCreated();
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo crear la excepción.');
    }
  }
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      className="flex flex-col gap-4 border-t border-divider px-5 py-4"
    >
      <h3 className="font-semibold">Nueva excepción de módulo</h3>
      {failure && <Alert>{failure}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Módulo" value={code} onChange={(e) => setCode(e.target.value)}>
          {modules.map((m) => (
            <option key={m.code} value={m.code}>
              {m.name}
            </option>
          ))}
        </Select>
        <Select
          label="Efecto"
          value={effect}
          onChange={(e) => setEffect(e.target.value as 'GRANT' | 'REVOKE')}
        >
          <option value="GRANT">Conceder (aunque el plan no lo incluya)</option>
          <option value="REVOKE">Retirar (aunque el plan lo incluya)</option>
        </Select>
      </div>
      <Textarea
        label="Motivo"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        error={reasonError}
        rows={2}
      />
      <div>
        <button type="submit" className={PRIMARY}>
          Crear excepción
        </button>
      </div>
    </form>
  );
}

function NewOperationOverride({
  tenantId,
  timezone,
  onCreated,
}: {
  tenantId: string;
  timezone: string;
  onCreated: () => void;
}) {
  const todayLocal = today(timezone);
  const max = addDays(todayLocal, 30);
  const [to, setTo] = useState(addDays(todayLocal, 7));
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const reasonError = tried && reason.trim().length < 3 ? 'Escribe el motivo (al menos 3 caracteres).' : null;
  const dateError =
    tried && (!to || to <= todayLocal || to > max) ? 'Elige un día entre mañana y dentro de 30 días.' : null;
  async function create() {
    setTried(true);
    if (reason.trim().length < 3 || !to || to <= todayLocal || to > max) return;
    setFailure(null);
    try {
      // Fin a las 23:59 del día elegido en Perú (UTC−5, sin horario de verano).
      await post(`/api/v1/platform/tenants/${tenantId}/operation-overrides`, {
        category: 'USERS_ADD',
        validTo: new Date(`${to}T23:59:00-05:00`).toISOString(),
        reason: reason.trim(),
      });
      setReason('');
      setTried(false);
      onCreated();
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo crear la excepción.');
    }
  }
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      className="flex flex-col gap-4 border-t border-divider px-5 py-4"
    >
      <h3 className="font-semibold">Permitir altas de usuarios temporalmente</h3>
      {failure && <Alert>{failure}</Alert>}
      <Input
        label="Hasta el día"
        type="date"
        value={to}
        min={addDays(todayLocal, 1)}
        max={max}
        onChange={(e) => setTo(e.target.value)}
        error={dateError}
        hint="Como mucho 30 días. Termina a las 23:59 de ese día."
      />
      <Textarea
        label="Motivo"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        error={reasonError}
        rows={2}
      />
      <div>
        <button type="submit" className={PRIMARY}>
          Crear excepción
        </button>
      </div>
    </form>
  );
}

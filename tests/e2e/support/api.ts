import type { Page } from '@playwright/test';

/** Llamadas a la API con la sesión del navegador (mismo origen) y el CSRF de su cookie, para preparar datos. */
export async function apiPost(page: Page, path: string, body?: unknown): Promise<unknown> {
  const ctx = page.context();
  let csrf = (await ctx.cookies()).find((c) => c.name === '__Host-yebo_csrf')?.value;
  if (!csrf) {
    await page.request.get('/api/v1/platform/auth/csrf');
    csrf = (await ctx.cookies()).find((c) => c.name === '__Host-yebo_csrf')?.value;
  }
  const res = await page.request.post(path, { data: body ?? {}, headers: { 'X-CSRF-Token': csrf ?? '' } });
  if (!res.ok()) throw new Error(`${path} → ${res.status()}: ${await res.text()}`);
  return res.status() === 204 ? undefined : res.json();
}

type Version = { id: string };
/** Plan «Básico E2E» con dos versiones publicadas (v2 = upgrade) y sin prueba: las empresas nacen «Al día». */
export async function seedPlan(page: Page): Promise<{ v1: string; v2: string }> {
  const plan = (await apiPost(page, '/api/v1/platform/plans', {
    code: 'basico-e2e',
    name: 'Básico E2E',
    description: 'Plan de los E2E',
  })) as { id: string };
  const base = {
    currency: 'PEN',
    billingInterval: 'MONTHLY',
    trialDays: 0,
    paymentTermsDays: 7,
    modules: ['PASSENGERS', 'CARGO'],
  };
  const v1 = (await apiPost(page, `/api/v1/platform/plans/${plan.id}/versions`, {
    ...base,
    basePrice: '99.00',
    includedUsers: 5,
    extraUserPrice: '15.00',
  })) as Version;
  await apiPost(page, `/api/v1/platform/plan-versions/${v1.id}/publish`);
  const v2 = (await apiPost(page, `/api/v1/platform/plans/${plan.id}/versions`, {
    ...base,
    basePrice: '149.00',
    includedUsers: 10,
    extraUserPrice: '12.00',
  })) as Version;
  await apiPost(page, `/api/v1/platform/plan-versions/${v2.id}/publish`);
  return { v1: v1.id, v2: v2.id };
}

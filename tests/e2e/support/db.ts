import { Pool } from 'pg';
import { E2E } from './env';

/** Rol de PRUEBAS yebo_test_bypass (ADR-034): prepara datos que el panel aún no crea (facturas) en yebo_test. */
export function bypassPool(): Pool {
  const user = process.env.TEST_PG_BYPASS_USER;
  const password = process.env.TEST_PG_BYPASS_PASSWORD;
  if (!user || !password) throw new Error('Faltan TEST_PG_BYPASS_USER/PASSWORD (apps/api/.env.test)');
  const url = new URL(`postgresql://${process.env.PG_HOST ?? '127.0.0.1'}:${process.env.PG_PORT ?? '5433'}`);
  url.username = user;
  url.password = password;
  url.pathname = `/${E2E.database}`;
  return new Pool({ connectionString: url.toString(), max: 2, application_name: 'yebo-e2e' });
}

export async function withDb<T>(fn: (db: Pool) => Promise<T>): Promise<T> {
  const db = bypassPool();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Fecha civil de hoy en Lima ± días (`YYYY-MM-DD`). */
export function limaDay(offsetDays = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Factura vencida de 204.00 (base 99 + 7 adicionales × 15) emitida hace 8 días y vencida ayer, y la empresa en
 * PAST_DUE desde ahora (como la dejaría el job de estados). Devuelve el id de la factura.
 */
export async function seedOverdueInvoice(tenantId: string): Promise<string> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO platform_invoices (tenant_id, code, status, issue_date, due_date, currency, subtotal, tax, total, balance)
       VALUES ($1, 'YB-' || to_char(now(), 'YYYYMM') || '-' || upper(substr(md5(random()::text), 1, 8)), 'OVERDUE', $2, $3, 'PEN', 204, 0, 204, 204)
       RETURNING id`,
      [tenantId, limaDay(-8), limaDay(-1)],
    );
    const invoiceId = rows[0]!.id;
    await db.query(
      `INSERT INTO platform_invoice_lines (tenant_id, invoice_id, kind, description, quantity, unit_price, amount) VALUES
         ($1, $2, 'BASE', 'Plan Básico (versión 1)', 1, 99, 99),
         ($1, $2, 'EXTRA_USERS', '7 usuarios adicionales', 7, 15, 105)`,
      [tenantId, invoiceId],
    );
    const [prev] = (
      await db.query<{ status: string }>('SELECT status::text FROM tenants WHERE id = $1', [tenantId])
    ).rows;
    await db.query(
      "UPDATE tenants SET status = 'PAST_DUE', status_changed_at = now(), updated_at = now() WHERE id = $1",
      [tenantId],
    );
    await db.query(
      `INSERT INTO tenant_status_history (id, tenant_id, from_status, to_status, reason, occurred_at)
       VALUES (gen_random_uuid(), $1, $2::tenant_status, 'PAST_DUE', 'Factura vencida (datos E2E)', now())`,
      [tenantId, prev!.status],
    );
    return invoiceId;
  });
}

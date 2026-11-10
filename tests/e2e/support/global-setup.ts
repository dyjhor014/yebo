import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { E2E, ROOT } from './env';

/**
 * Antes de los E2E: yebo_test limpia (staff, catálogo, empresas y facturación), límites de intentos de Redis
 * a cero y un superadmin nuevo creado con el bootstrap real (sin MFA: el recorrido la activa por la interfaz).
 */
export default async function globalSetup() {
  const url = new URL(`postgresql://${process.env.PG_HOST ?? '127.0.0.1'}:${process.env.PG_PORT ?? '5433'}`);
  url.username = process.env.PG_OWNER_USER ?? '';
  url.password = process.env.PG_OWNER_PASSWORD ?? '';
  url.pathname = `/${E2E.database}`;
  const owner = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    await owner.query(
      `TRUNCATE platform_audit_logs, platform_setup_tokens, platform_sessions, platform_users, plan_version_modules,
                plan_versions, plans, subscription_payments, platform_invoice_lines, platform_invoices,
                usage_period_calculations, billing_periods, usage_daily_snapshots, membership_invitations,
                membership_status_history, support_access_logs, support_sessions, support_handoffs,
                support_access_grants, tenant_module_overrides, tenant_operation_overrides, subscriptions,
                tenant_settings, tenant_services, tenant_status_history, membership_roles, role_permissions, roles,
                tenant_memberships, authorization_codes, refresh_tokens, tenant_sessions, identity_sessions, users,
                tenant_domains, tenants CASCADE`,
    );
  } finally {
    await owner.end();
  }
  try {
    const redis = [
      'exec',
      'yebo-dev-redis-1',
      'redis-cli',
      '--no-auth-warning',
      '-a',
      process.env.REDIS_PASSWORD ?? '',
    ];
    const keys = execFileSync('docker', [...redis, '--scan', '--pattern', 'rl:*'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    if (keys.length) execFileSync('docker', [...redis, 'del', ...keys]);
  } catch {
    console.warn('E2E: no se pudieron limpiar los límites de intentos de Redis (continúa).');
  }
  execFileSync(
    process.execPath,
    ['dist/modules/platform-admin/cli/bootstrap.js', '--email', E2E.staffEmail, '--name', E2E.staffName],
    {
      cwd: resolve(ROOT, 'apps/api'),
      env: { ...process.env, PG_DATABASE: E2E.database, PLATFORM_BOOTSTRAP_PASSWORD: E2E.staffPassword },
      stdio: 'pipe',
    },
  );
}

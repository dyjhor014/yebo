import { Pool } from 'pg';
import { buildPostgresUrl, type DbConnectionEnv, type DbRole } from '../../src/config/database-urls';

export function testDbUrl(role: DbRole, database: string): string {
  return buildPostgresUrl(process.env as unknown as DbConnectionEnv, role, database);
}

export function testPool(role: DbRole, database: string, max = 10): Pool {
  return new Pool({
    connectionString: testDbUrl(role, database),
    max,
    application_name: `yebo-test-${role}`,
  });
}

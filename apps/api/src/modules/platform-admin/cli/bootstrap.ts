/**
 * Alta del PRIMER superadmin de YEBO (Fase 4.1):
 *   pnpm --filter @yebo/api build
 *   pnpm --filter @yebo/api platform:bootstrap -- --email ana@yebo.pe --name "Ana Pérez"
 *
 * Solo funciona si no existe ningún miembro del staff. La contraseña se pide sin eco (o se toma de
 * PLATFORM_BOOTSTRAP_PASSWORD, p. ej. en CI). La verificación en dos pasos se activa en el primer acceso al panel.
 */
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { buildPostgresUrl } from '../../../config/database-urls';
import { parseEnv } from '../../../config/env';
import { loadEnvFileIfPresent } from '../../../config/load-env-file';
import { createPrismaClient } from '../../../infrastructure/database/create-prisma-client';
import { PasswordHasher } from '../../identity/password-hasher';
import { PLATFORM_PASSWORD_MIN_LENGTH } from '../platform-auth.service';
import { bootstrapSuperadmin } from '../staff.service';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((done) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      done(answer);
    });
    muted = true;
  });
}

async function main(): Promise<void> {
  loadEnvFileIfPresent(resolve(__dirname, '..', '..', '..', '..', '.env'));
  const env = parseEnv(process.env);
  const email = arg('email');
  const fullName = arg('name');
  if (!email || !fullName) throw new Error('Uso: platform:bootstrap -- --email <correo> --name "<nombre>"');

  let password = process.env.PLATFORM_BOOTSTRAP_PASSWORD;
  if (!password) {
    password = await askHidden('Contraseña: ');
    if ((await askHidden('Repite la contraseña: ')) !== password)
      throw new Error('Las contraseñas no coinciden');
  }
  if (password.length < PLATFORM_PASSWORD_MIN_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${PLATFORM_PASSWORD_MIN_LENGTH} caracteres`);
  }

  const hasher = new PasswordHasher(env);
  await hasher.onModuleInit();
  const db = createPrismaClient({
    connectionString: buildPostgresUrl(env, 'backoffice', env.PG_DATABASE),
    max: 1,
    applicationName: 'yebo-platform-bootstrap',
  });
  try {
    await bootstrapSuperadmin(db, { email, fullName, passwordHash: await hasher.hash(password) });
    console.warn(
      `Superadmin creado. Entra en https://${env.PLATFORM_ADMIN_HOST} y activa la verificación en dos pasos.`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

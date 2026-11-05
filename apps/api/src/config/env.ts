import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');
const port = z.coerce.number().int().min(1).max(65535);
const secret = z.string().min(16, 'debe tener al menos 16 caracteres');

/** Esquema de configuración. La aplicación no arranca si la configuración es inválida. */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_VERSION: z.string().default('0.0.0'),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: port.default(4100),
    WORKER_HEALTH_HOST: z.string().default('127.0.0.1'),
    WORKER_HEALTH_PORT: port.default(4101),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: booleanString.default(false),
    TRUST_PROXY: z.string().default('loopback'),
    SWAGGER_ENABLED: booleanString.default(false),

    PG_HOST: z.string().min(1),
    PG_PORT: port,
    PG_DATABASE: z.string().min(1),
    PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    PG_APP_USER: z.string().min(1),
    PG_APP_PASSWORD: secret,
    PG_PLATFORM_USER: z.string().min(1),
    PG_PLATFORM_PASSWORD: secret,
    // Credenciales de propietario: solo para migraciones. Opcionales para la API en ejecución.
    PG_OWNER_USER: z.string().min(1).optional(),
    PG_OWNER_PASSWORD: secret.optional(),
    PG_SHADOW_DATABASE: z.string().optional(),

    REDIS_HOST: z.string().min(1),
    REDIS_PORT: port,
    REDIS_PASSWORD: secret,
    BULLMQ_PREFIX: z
      .string()
      .regex(/^[a-z0-9_-]+$/)
      .default('yebo'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.LOG_PRETTY) {
      ctx.addIssue({ code: 'custom', path: ['LOG_PRETTY'], message: 'no se permite en producción' });
    }
    if (env.PG_APP_USER === env.PG_PLATFORM_USER) {
      ctx.addIssue({
        code: 'custom',
        path: ['PG_PLATFORM_USER'],
        message: 'el rol de plataforma debe ser distinto del rol de aplicación (ADR-003)',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export class InvalidConfigurationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Configuración inválida:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'InvalidConfigurationError';
  }
}

/** Valida el entorno. Los mensajes nunca incluyen valores (podrían ser secretos). */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new InvalidConfigurationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`),
    );
  }
  return result.data;
}

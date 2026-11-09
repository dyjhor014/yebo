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
    // Rol dedicado de identidad (Fase 3.2a): solo lo usa el módulo identity. Opcional para el worker.
    PG_IDENTITY_USER: z.string().min(1).default('yebo_identity'),
    PG_IDENTITY_PASSWORD: secret.optional(),
    // Rol del superadmin (Fase 4, F4-Q2): solo el módulo platform-admin. Opcional para el worker.
    PG_BACKOFFICE_USER: z.string().min(1).default('yebo_backoffice'),
    PG_BACKOFFICE_PASSWORD: secret.optional(),
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

    // Autenticación (security.md §1; identity-and-sessions §6–7)
    /** Clave privada Ed25519 (PKCS#8 PEM codificado en base64) para firmar los access tokens (EdDSA). */
    /** Opcional en el esquema: solo la exige el módulo de identidad (el worker no firma tokens). */
    AUTH_JWT_PRIVATE_KEY: z.string().min(1).optional(),
    AUTH_JWT_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .default('k1'),
    /** Claves públicas anteriores aún válidas (rotación): JSON [{"kid":"…","key":"<PEM SPKI en base64>"}]. */
    AUTH_JWT_PREVIOUS_PUBLIC_KEYS: z.string().default('[]'),
    AUTH_JWT_ISSUER: z.string().min(1).default('yebo'),
    /** Audiencia de los access tokens de empresa. Un token de otra audiencia (p. ej., plataforma) se rechaza. */
    AUTH_JWT_AUDIENCE: z.string().min(1).default('yebo-tenant-api'),
    /** Host del hub de cuentas (identity-and-sessions §2). Único lugar donde se escriben credenciales. */
    AUTH_HUB_HOST: z
      .string()
      .regex(/^[a-z0-9.-]+$/)
      .default('cuentas.yebo.pe'),
    /** Clave HMAC de las cookies del flujo (petición de autorización y sesión del hub). Opcional para el worker. */
    AUTH_COOKIE_SECRET: z.string().min(32, 'debe tener al menos 32 caracteres').optional(),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
    AUTH_REFRESH_GRACE_SECONDS: z.coerce.number().int().min(1).max(60).default(20),
    AUTH_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(43200).default(720),
    AUTH_SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    // Argon2id: los mínimos son los de OWASP (m=19 MiB, t=2, p=1). Se recalibran con scripts/calibrate-argon2.ts.
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(19456).max(1048576).default(19456),
    ARGON2_ITERATIONS: z.coerce.number().int().min(2).max(10).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),
    /** Cálculos de Argon2id simultáneos por proceso y cola máxima (hallazgo M6): el exceso responde 503. */
    ARGON2_MAX_CONCURRENT: z.coerce.number().int().min(1).max(64).default(4),
    ARGON2_MAX_QUEUE: z.coerce.number().int().min(0).max(10000).default(64),

    // Panel de administración de YEBO (Fase 4.1)
    /** Host del panel y de la API de plataforma (F4-Q4). Reservado: ningún tenant puede registrarlo. */
    PLATFORM_ADMIN_HOST: z
      .string()
      .regex(/^[a-z0-9.-]+$/)
      .default('admin.yebo.pe'),
    /**
     * Dominio base de los tenants (Fase 4.3): el subdominio por defecto de una empresa es `<slug>.<dominio base>`. El
     * hub y el panel deben ser subdominios suyos, y sus etiquetas quedan reservadas.
     */
    TENANT_BASE_DOMAIN: z
      .string()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
      .default('yebo.pe'),
    PLATFORM_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    PLATFORM_SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24).default(12),
    /** Cifrado de campo (ADR-019): clave AES-256 en base64 (32 bytes). Opcional para el worker. */
    FIELD_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'debe ser una clave de 32 bytes en base64')
      .optional(),
    FIELD_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(32767).default(1),
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
    // ADR-034: el rol exclusivo de pruebas (salta RLS) nunca puede ser la identidad de un servicio de ejecución.
    for (const key of [
      'PG_APP_USER',
      'PG_PLATFORM_USER',
      'PG_IDENTITY_USER',
      'PG_BACKOFFICE_USER',
      'PG_OWNER_USER',
    ] as const) {
      if (env[key]?.toLowerCase().includes('bypass')) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'un rol que salta RLS no puede usarse en la API, el worker ni las migraciones (ADR-034)',
        });
      }
    }
    const runtimeUsers = [
      env.PG_APP_USER,
      env.PG_PLATFORM_USER,
      env.PG_IDENTITY_USER,
      env.PG_BACKOFFICE_USER,
    ];
    if (new Set(runtimeUsers).size !== runtimeUsers.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['PG_BACKOFFICE_USER'],
        message: 'cada servicio de ejecución usa un rol de PostgreSQL distinto (ADR-034)',
      });
    }
    if (env.PLATFORM_ADMIN_HOST === env.AUTH_HUB_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['PLATFORM_ADMIN_HOST'],
        message: 'el panel de administración y el hub de cuentas deben estar en hosts distintos',
      });
    }
    for (const key of ['AUTH_HUB_HOST', 'PLATFORM_ADMIN_HOST'] as const) {
      const label = env[key].slice(0, -(env.TENANT_BASE_DOMAIN.length + 1));
      if (!env[key].endsWith(`.${env.TENANT_BASE_DOMAIN}`) || !/^[a-z0-9-]+$/.test(label)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'debe ser un subdominio directo de TENANT_BASE_DOMAIN (su etiqueta queda reservada)',
        });
      }
    }
    if (env.PG_IDENTITY_USER === env.PG_APP_USER || env.PG_IDENTITY_USER === env.PG_PLATFORM_USER) {
      ctx.addIssue({
        code: 'custom',
        path: ['PG_IDENTITY_USER'],
        message: 'el rol de identidad debe ser distinto de los roles de aplicación y de plataforma',
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

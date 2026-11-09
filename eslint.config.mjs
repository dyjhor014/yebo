// Configuración ESLint (flat) compartida por todo el monorepo.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const PUBLIC_DECORATOR = {
  selector: "Decorator[expression.callee.name='Public']",
  message:
    'Rutas públicas solo en health, tenancy e identity/http, y registradas en PUBLIC_ROUTES (denegar por defecto, Fase 3.3).',
};
const GLOBAL_GUARDS = {
  selector: "Identifier[name='APP_GUARD']",
  message: 'La cadena de guards globales solo se registra en modules/access/access.module.ts (Fase 3.3).',
};
const USE_GLOBAL_GUARDS = {
  selector: "MemberExpression[property.name='useGlobalGuards']",
  message:
    'No se sustituyen los guards globales: se registran en modules/access/access.module.ts (Fase 3.3).',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/generated/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'docs/**',
      'scripts/render-diagrams/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Regla 7 del proyecto: no usar `any` indiscriminadamente.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // NestJS: los tipos de los parámetros del constructor se emiten como metadatos (inyección de dependencias).
    // Sin esto, consistent-type-imports convertiría esas importaciones en `import type` y rompería la DI.
    files: ['apps/api/**/*.ts'],
    languageOptions: { parserOptions: { emitDecoratorMetadata: true, experimentalDecorators: true } },
  },
  {
    // Frontera 1 · El cliente Prisma de plataforma (BYPASSRLS) solo se usa en los módulos autorizados
    // (multitenancy §3). Cubre TODO apps/api/src, no solo modules/ (hallazgo M3 de la auditoría de la 3.2a).
    files: ['apps/api/src/**/*.ts'],
    // Autorizados a usar PlatformPrismaService. Añadir uno exige revisión. identity ya NO está: usa yebo_identity.
    ignores: [
      'apps/api/src/infrastructure/database/**',
      'apps/api/src/modules/health/**',
      'apps/api/src/modules/tenancy/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/platform-prisma.service', '**/platform-prisma.service.js'],
              message: 'PlatformPrismaService omite RLS. Solo módulos de plataforma autorizados (ADR-003).',
            },
          ],
        },
      ],
    },
  },
  {
    // Frontera 2 · El cliente con el rol yebo_identity (sesiones y tokens) solo existe dentro del módulo identity.
    // Regla distinta de la frontera 1 (la versión de typescript-eslint) para que ninguna de las dos anule a la otra.
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/modules/identity/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/identity-prisma.service', '**/identity-prisma.service.js'],
              message: 'IdentityPrismaService (rol yebo_identity) es exclusivo del módulo identity.',
            },
          ],
        },
      ],
    },
  },
  {
    // Frontera 3 · Denegar por defecto (Fase 3.3, diseño aceptado el 2026-11-09). Las rutas públicas solo se
    // declaran en los módulos autorizados (y además figuran en PUBLIC_ROUTES), y la cadena de guards globales solo
    // se registra en access.module.ts. Las dos reglas comparten `no-restricted-syntax`: los bloques siguientes
    // sustituyen la lista completa para sus archivos, así que cada uno repite lo que sigue prohibido.
    files: ['apps/api/src/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', PUBLIC_DECORATOR, GLOBAL_GUARDS, USE_GLOBAL_GUARDS] },
  },
  {
    files: [
      'apps/api/src/modules/health/**/*.ts',
      'apps/api/src/modules/tenancy/**/*.ts',
      'apps/api/src/modules/identity/http/**/*.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', GLOBAL_GUARDS, USE_GLOBAL_GUARDS] },
  },
  {
    files: ['apps/api/src/modules/access/access.module.ts'],
    rules: { 'no-restricted-syntax': ['error', PUBLIC_DECORATOR, USE_GLOBAL_GUARDS] },
  },
);

// Configuración ESLint (flat) compartida por todo el monorepo.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
);

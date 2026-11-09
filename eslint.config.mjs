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
    // El cliente Prisma de plataforma (BYPASSRLS) solo puede usarse desde módulos autorizados (multitenancy §3).
    files: ['apps/api/src/modules/**/*.ts'],
    // Módulos de plataforma autorizados a usar PlatformPrismaService (omite RLS). Añadir uno exige revisión.
    ignores: ['apps/api/src/modules/health/**', 'apps/api/src/modules/tenancy/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '../../infrastructure/database/platform-prisma.service',
              message: 'PlatformPrismaService omite RLS. Solo módulos de plataforma autorizados (ADR-003).',
            },
          ],
          patterns: [
            {
              group: ['**/infrastructure/database/platform-prisma.service'],
              message: 'PlatformPrismaService omite RLS. Solo módulos de plataforma autorizados (ADR-003).',
            },
          ],
        },
      ],
    },
  },
);

# Plataforma SaaS multitenant de transporte

Plataforma para empresas de transporte terrestre y fluvial: pasajeros, encomiendas, carga y vehículos transportados.

- Estado actual: [`PROJECT_STATUS.md`](PROJECT_STATUS.md)
- Roadmap: [`docs/development/roadmap.md`](docs/development/roadmap.md)
- Auditoría inicial: [`docs/development/phase-0-audit.md`](docs/development/phase-0-audit.md)
- Resultados de la Fase 2: [`docs/development/phase-2-results.md`](docs/development/phase-2-results.md)
- Resultados de la Fase 3: [`docs/development/phase-3-results.md`](docs/development/phase-3-results.md)
- Decisiones de arquitectura: [`docs/architecture/architecture-decisions.md`](docs/architecture/architecture-decisions.md)

## Requisitos de desarrollo

- Node.js 24 LTS (`nvm use`)
- pnpm 10
- Docker + Docker Compose

## Puesta en marcha

```bash
nvm use
pnpm install
pnpm setup:env          # genera los .env con contraseñas aleatorias (no sobrescribe)
pnpm infra:up           # PostgreSQL 17 (5433) y Redis 7 (6380)
pnpm generate           # clientes Prisma
pnpm dev                # api, worker, web y platform
```

## Verificación

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm test:integration   # requiere pnpm infra:up
```

CI (`.github/workflows/ci.yml`) ejecuta lo mismo en cada PR, incluida la prueba obligatoria de deriva entre migraciones, esquema Prisma y base real (ADR-024).

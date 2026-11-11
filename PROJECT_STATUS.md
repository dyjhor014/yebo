# Estado del proyecto — YEBO

**Última actualización:** 2026-11-10 (Fase 5.5, cierre de la Fase 5)

## Fase actual

**Fase 3: Multitenancy y seguridad — en curso** (rama `fase-3/multitenancy-seguridad`, apilada sobre `fase-2/fundacion-tecnica` por decisión del responsable, sin esperar al merge del PR #1). **Etapa 3.1** (esquema base de tenancy e identidad + resolución del tenant por host) **lista para revisión** (PR #4). **Etapa 3.2a** (servicios de sesión) **lista para revisión tras la segunda iteración** en la rama `fase-3/3.2-sesiones`, apilada sobre la 3.1. Incluye:
- Argon2id;
- JWT EdDSA con `aud`;
- verificación de sesión en PostgreSQL en cada request;
- sucesor cifrado;
- rol dedicado `yebo_identity`.

La **3.2b** (hub de cuentas y flujo OAuth propio + PKCE S256, con sus pantallas y la identidad visual YEBO v1.0) está **implementada y pendiente de revisión**. La 3.2 completa está en un **commit local** (`83df1c1`, rama `fase-3/3.2-sesiones`, sin push).

La **3.3** (autorización y estado del tenant: guards globales con denegación por defecto, permisos, matriz de estados y gestión mínima de accesos) está en un **commit local** (`1c695b1`, rama `fase-3/3.3-autorizacion`, sin push).

La **3.4** (cierre: aislamiento de extremo a extremo y medición del coste de una transacción por operación) está en un **commit local** (`da999d8`, rama `fase-3/3.4-cierre`). **Criterio de aceptación de la Fase 3 cumplido**; resultados en [phase-3-results.md](docs/development/phase-3-results.md).

**ADR-034 aplicado** y **regla de §4.2 adoptada** (2026-11-10), en la rama `fase-3/adr-034-privilegios`, sin commit. `yebo_platform` ya no salta RLS. El clúster de desarrollo está endurecido y **`yebo_dev` migrada** (7 migraciones).

**Fase 4 implementada (4.1–4.8), pendiente de revisión** (rama `fase-4/plan`, solo commits locales). **Criterio de aceptación cumplido:** una prueba de extremo a extremo crea la empresa, le asigna el plan, mide sus usuarios durante un mes y calcula la factura (S/ 174.00), en la CI como parte de `pnpm test:integration`. Incluye:
- el staff con MFA;
- el catálogo comercial;
- el alta y los estados de las empresas;
- las invitaciones;
- la medición diaria;
- los períodos, las facturas, los pagos (con su anulación) y el cambio de plan;
- el acceso de soporte;
- el panel del staff (`apps/platform`), con E2E de Playwright y axe.

Todas las migraciones están aplicadas a `yebo_dev` con copia previa. Hay además un modo HTTPS local para probar desde la red (`pnpm https:up`). **Push y PR en espera** por decisión del responsable. Resultados en [phase-4-results.md](docs/development/phase-4-results.md); plan en [phase-4-plan.md](docs/development/phase-4-plan.md).

**Fase 5 (white label) implementada (5.1–5.5), pendiente de revisión** (rama `fase-5/plan`, desde `c98ab2e`; PR #11). **Criterio de aceptación cumplido:** «Dos portales visualmente distintos sin duplicar apps».
- **CI:** tres empresas configuran y publican su sitio por la API y cada host sirve solo el suyo; el mismo código de `apps/web` resuelve tokens distintos.
- **E2E:** la misma compilación de `apps/web` sirve dos portales con estilos y capturas distintos (más del 50 % de los píxeles).

Incluye el sitio versionado con contraste AA, los archivos en S3 (Garage en desarrollo), el portal por host y el editor «Mi sitio», revisado con Impeccable. Las migraciones de la 5.1 y la 5.2 están aplicadas a `yebo_dev` con copia previa (`~/yebo-backups/`). Resultados en [phase-5-results.md](docs/development/phase-5-results.md); plan en [phase-5-plan.md](docs/development/phase-5-plan.md).

La Fase 2 sigue en revisión mediante el PR #1, sin merge. Orden de integración previsto: #1 → #3 → #2.

## Fases completadas

- **Fase 0:** auditoría ([informe](docs/development/phase-0-audit.md)).
- **Fase 1:** arquitectura y diseño, aprobada el 2026-11-05 (ADR-001 a 023; [registro de decisiones](docs/architecture/decision-log.md)).

## Estado de la Fase 2

| Verificación requerida para el PR | Resultado |
|---|---|
| Migración desde una base vacía | ✅ producción y las dos PoC |
| Migración desde el esquema anterior (con datos) | ✅ las dos PoC; en producción no hay esquema anterior |
| Aislamiento RLS, con contexto vacío y conexiones reutilizadas | ✅ 25 pruebas + verificación estática de ADR-025 |
| Repetición de las 40 colisiones | ✅ 0 interbloqueos con ADR-026 (antes, 18–28 de 40) |
| Mayor concurrencia (300 ventas, 40 conexiones) | ✅ solo errores controlados; 0 dobles ventas |
| Tramos superpuestos y no superpuestos | ✅ |
| Formato, lint, typecheck, unitarias (38 tras la revisión; antes 32) y build | ✅ |
| Integración (6 suites, 74 pruebas tras la revisión; antes 66) | ✅ en desarrollo y en una sala limpia que simula CI (antes de la revisión) |
| Revisión del PR #1 | ✅ 9 hallazgos corregidos con pruebas; 1 diferido ([resultados §7](docs/development/phase-2-results.md)) |

## ADR

- ADR-001 a 023: aceptados (Fase 1).
- **ADR-024, 025 y 026: aceptados** (2026-11-05), con estas precisiones:
  - **ADR-024:** prueba de deriva obligatoria en CI.
  - **ADR-025:** tenant fijado por transacción, nunca heredado.
  - **ADR-026:** orden de bloqueo determinista; los conflictos se traducen en errores controlados.

## Supuestos y puntos por validar (no bloquean)

D1 (cliente piloto), D6 (propietarios), D7 (agencias), S2 (contrato de la API de facturación; bloquea solo el adaptador), S5 (impuestos con un contador), S6 (formatos de manifiestos), D9 (pasarela de pago) y D12 (hosting).

## Entorno

- Node 24 (`nvm use`). El Node 18 del sistema no cumple `engines`.
- Docker Desktop: `systemctl --user start docker-desktop`. Puertos 5433 (PostgreSQL), 6380 (Redis) y 3900 (Garage, S3 de desarrollo, Fase 5.2).
- Los volúmenes creados antes de este cambio necesitan la base `yebo_migrations` (ver phase-2-results §4). Ya está creada en el entorno local.
- Disco: 36 GB libres (93 %).
- **ADR-034 en un volumen existente** (ya aplicado en el de este equipo):
  1. `scripts/dev/init-env.sh`, que añade `TEST_PG_BYPASS_PASSWORD` y crea `apps/api/.env.test`;
  2. `scripts/dev/harden-roles.sh --test-role`;
  3. `pnpm --filter @yebo/api db:migrate:deploy`.

## Errores conocidos

Ninguno abierto. El `500` intermitente bajo carga de `isolation-e2e` se corrigió el 2026-11-10 (aprobado y en un commit local): espera configurable `PG_TX_MAX_WAIT_MS` y `503` reintentable si se agota. Detalle en [phase-4-plan.md](docs/development/phase-4-plan.md) (4.3b, «Pendiente»).

## Próximas tareas

1. Revisión de los PR abiertos por el responsable del proyecto; el merge lo hace él. Orden de integración previsto: #1 (Fase 2) → #3 (Impeccable) → #2 (MKT-01) → #4 (Fase 3.1, apilado sobre la rama de la Fase 2).
2. Tras el cierre de la Fase 2: activar la protección de `main` exigiendo el check de CI.
3. Revisión de la etapa 3.1 (PR #4) y de la etapa 3.2a.
4. Revisión de los PR apilados (subidos el 2026-11-10 con autorización del responsable): #6 (3.2) → #7 (3.3) → #8 (3.4) → #9 (ADR-034) → #10 (Fase 4) → #11 (Fase 5), cada uno sobre el anterior y este sobre el #4. El merge lo hace el responsable.
5. La Fase 6 no empieza sin aprobación expresa.

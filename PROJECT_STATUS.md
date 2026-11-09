# Estado del proyecto — YEBO

**Última actualización:** 2026-11-10

## Fase actual

**Fase 3: Multitenancy y seguridad — en curso** (rama `fase-3/multitenancy-seguridad`, apilada sobre `fase-2/fundacion-tecnica` por decisión del responsable, sin esperar al merge del PR #1). **Etapa 3.1** (esquema base de tenancy e identidad + resolución del tenant por host) **lista para revisión** (PR #4). **Etapa 3.2a** (servicios de sesión) **lista para revisión tras la segunda iteración** en la rama `fase-3/3.2-sesiones`, apilada sobre la 3.1. Incluye:
- Argon2id;
- JWT EdDSA con `aud`;
- verificación de sesión en PostgreSQL en cada request;
- sucesor cifrado;
- rol dedicado `yebo_identity`.

La **3.2b** (hub de cuentas y flujo OAuth propio + PKCE S256, con sus pantallas y la identidad visual YEBO v1.0) está **implementada y pendiente de revisión**. La 3.2 completa está en un **commit local** (`83df1c1`, rama `fase-3/3.2-sesiones`, sin push).

La **3.3** (autorización y estado del tenant: guards globales con denegación por defecto, permisos, matriz de estados y gestión mínima de accesos) está **implementada y pendiente de revisión** en la rama `fase-3/3.3-autorizacion`, sin commit. `support_access_grants` pasa a la Fase 4. Sus migraciones no se aplicaron a ninguna base del proyecto. Plan: [phase-3-plan.md](docs/development/phase-3-plan.md).

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
- Docker Desktop: `systemctl --user start docker-desktop`. Puertos 5433 (PostgreSQL) y 6380 (Redis).
- Los volúmenes creados antes de este cambio necesitan la base `yebo_migrations` (ver phase-2-results §4). Ya está creada en el entorno local.
- Disco: 36 GB libres (93 %).

## Errores conocidos

Ninguno abierto.

## Próximas tareas

1. Revisión de los PR abiertos por el responsable del proyecto; el merge lo hace él. Orden de integración previsto: #1 (Fase 2) → #3 (Impeccable) → #2 (MKT-01) → #4 (Fase 3.1, apilado sobre la rama de la Fase 2).
2. Tras el cierre de la Fase 2: activar la protección de `main` exigiendo el check de CI.
3. Revisión de la etapa 3.1 (PR #4) y de la etapa 3.2a.
4. Revisión del SQL de **ADR-034** (separación de privilegios: `yebo_platform` sin BYPASSRLS; rol `yebo_test_bypass` solo para pruebas), propuesto en [phase-3-plan](docs/development/phase-3-plan.md). Dirección aprobada; **no implementado**.
5. Para migrar `yebo_dev` tras aprobar la 3.2 y la 3.3: `scripts/dev/create-identity-role.sh` y después `pnpm --filter @yebo/api db:migrate:deploy` (reversiones en [phase-3-plan](docs/development/phase-3-plan.md)).
6. Revisión de la 3.2b (commit local `83df1c1`) y de la **3.3** (rama `fase-3/3.3-autorizacion`, sin commit). La 3.4 (cierre de la Fase 3) **solo con autorización expresa**.

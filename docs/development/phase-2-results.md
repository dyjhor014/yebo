# Fase 2 — Fundación técnica: resultados

**Fecha:** 2026-11-05 · **Rama:** `fase-2/fundacion-tecnica` · **ADR de la fase:** 024, 025 y 026 (aceptados)

## 1. Qué se construyó

| Pieza | Contenido |
|---|---|
| Monorepo | pnpm 10 + Turborepo 2; `apps/api`, `apps/web`, `apps/platform`, `packages/contracts`, `packages/config` (ADR-002) |
| `apps/api` | NestJS 11 con dos procesos: `main.ts` (HTTP) y `worker.ts` (BullMQ) (ADR-001). Configuración validada con Zod, logs Pino con `traceId`, contexto por request (CLS), filtro global de errores con formato único, Helmet, límite de cuerpo de 1 MB, OpenAPI desde los contratos Zod, `/api/v1/health/live` y `/ready` |
| Base de datos | Prisma 7.10 con `@prisma/adapter-pg`; dos clientes: `yebo_app` (sin BYPASSRLS) y `yebo_platform` (BYPASSRLS). Extensión de tenant de producción en `src/infrastructure/database/tenant-scope/` (filtro + sesión RLS) |
| `apps/web`, `apps/platform` | Next.js 16 / React 19, página inicial que consulta el estado del API |
| `packages/contracts` | Contratos Zod compartidos (salud, formato de error) |
| Infraestructura local | `infrastructure/docker/compose.dev.yaml`: PostgreSQL 17.6 (puerto 5433) y Redis 7.4.6 (6380), solo en 127.0.0.1; roles y bases creados por `postgres/init/`; contraseñas aleatorias con `pnpm setup:env` |
| CI | `.github/workflows/ci.yml`: formato, lint, typecheck, unitarias, build e integración (incluida la prueba de deriva de ADR-024) contra PostgreSQL y Redis reales |

## 2. Verificación previa al PR

Todo se ejecutó el 2026-11-05 con Node 24.22.2, dos veces:

- **Entorno de desarrollo:** los volúmenes existentes.
- **Sala limpia** que simula CI: una copia del repositorio sin `node_modules`, sin `.env` y sin artefactos, con `pnpm install --frozen-lockfile`, contraseñas nuevas y volúmenes de Docker nuevos (el script de inicialización de roles y bases se ejecuta desde cero).

| Verificación | Desarrollo | Sala limpia |
|---|---|---|
| `pnpm format:check` | ✅ | ✅ |
| `pnpm lint` | ✅ 6/6 | ✅ 6/6 |
| `pnpm typecheck` | ✅ 6/6 | ✅ 6/6 |
| `pnpm test` (unitarias) | ✅ 32 (api 30, contracts 2) | ✅ 32 |
| `pnpm build` | ✅ | ✅ |
| `pnpm test:integration` | ✅ 6 suites · 66 correctas · 1 omitida | ✅ 6 suites · 66 correctas · 1 omitida |

La prueba omitida es "migración desde el esquema anterior" del conjunto de **producción**: `main` no contiene ningún esquema y la Fase 2 crea la primera migración, así que no hay un esquema anterior. Ese camino sí se prueba en los dos conjuntos de migraciones de las PoC (§2.1).

### 2.1 Migraciones (`test/integration/migration-paths.int-spec.ts`, ADR-024/025)

Usa la base desechable `yebo_migrations` (nueva en el script de inicialización). Cada escenario la vacía con `DROP SCHEMA public CASCADE` y comprueba que no quedan objetos ni extensiones.

| Escenario | Producción | PoC aislamiento | PoC inventario |
|---|---|---|---|
| **Desde base vacía:** `migrate deploy`, `migrate status` al día, sin deriva entre la **base real** y el esquema, extensiones correctas, RLS forzado y políticas con `NULLIF` en `USING` y `WITH CHECK`, 0 filas sin contexto y con contexto `''`, segundo `deploy` sin pendientes | ✅ | ✅ | ✅ |
| **Desde el esquema anterior con datos:** se aplican solo las migraciones previas a ADR-024/025 y se siembran dos tenants. Se confirma el fallo anterior (contexto `''` → `22P02`) y se aplican las migraciones nuevas. Los datos se conservan fila por fila, cada tenant ve solo lo suyo y el estado final es idéntico al de una base nueva | n/a | ✅ | ✅ |
| **Deriva migraciones ↔ esquema** (`migrations.int-spec.ts`, obligatoria en CI) | ✅ | ✅ | ✅ |

### 2.2 Aislamiento RLS (`test/poc/tenancy`, ADR-003 y ADR-025): 25 pruebas

Pruebas previas: aislamiento por tenant, IDOR → 404, escrituras cruzadas rechazadas, RLS sin la barrera de aplicación, FK compuestas, 120 operaciones concurrentes de dos tenants sobre 2 conexiones, y transacciones interactivas.

Nuevas, con **una sola conexión física reutilizada** (se comprueba el mismo `pg_backend_pid`):

| Caso | Resultado |
|---|---|
| Contexto vacío explícito (`set_config('app.tenant_id', '', true)`) | 0 filas, sin error |
| Conexión nueva sin contexto | 0 filas |
| Tras `COMMIT` con el tenant A | la conexión queda sin tenant; otra transacción fija B y ve solo B |
| Tras `ROLLBACK` | sin tenant, 0 filas |
| Tras un error dentro de la transacción | sin tenant, 0 filas |
| Extensión Prisma con 1 conexión, 20 operaciones alternando A/B (por operación y en transacción interactiva) | cada una ve solo su tenant; entre operaciones, 0 filas |

**Verificación estática** (`tenant-context-policy.spec.ts`, unitaria, corre en CI): recorre `src`, `test` y `prisma` y falla ante:

- `set_config('app.tenant_id', …)` sin `true`;
- `SET` o `SET SESSION app.tenant_id`;
- `ALTER ROLE` o `ALTER DATABASE … app.tenant_id`.

Se comprobó que falla al introducir a propósito un `set_config(…, false)`.

### 2.3 Concurrencia (`test/poc/inventory`, ADR-007 y ADR-026): 23 pruebas

**Tramos superpuestos y no superpuestos**

| Caso | Resultado |
|---|---|
| §6.1 · 50 ventas simultáneas del mismo asiento y tramo | 1 éxito |
| §6.2 · tramos contiguos [0,1) y [1,3) | ambos se venden |
| §6.3 · superpuestos [0,2) y [1,3) (20 rondas) | 1 éxito por ronda |
| **Nuevo** · no superpuestos [0,1), [1,2) y [2,3) simultáneos (20 rondas) | los 3 se venden, 0 rechazos |
| **Nuevo** · [0,3) frente a [0,1), [1,2) y [2,3) simultáneos (20 rondas) | o gana [0,3) solo, o ganan los 3 tramos; nunca una mezcla |
| Camarotes y camas, aforo por tramo, peso + volumen, retenciones, ventas combinadas, RLS | ✅ (sin cambios respecto a la versión anterior) |

**Repetición de las 40 colisiones** (asiento 12A, [0,2) frente a [1,3), simultáneas). Siete ejecuciones: cinco seguidas en desarrollo, la de la suite completa y la de la sala limpia.

| Diseño | Ventas | `ResourceUnavailableError` | Interbloqueos `40P01` | Errores internos | Ronda más lenta |
|---|---|---|---|---|---|
| **ADR-026 (bloqueo ordenado)** | 40/40 | 40/40 | **0** en las 7 ejecuciones | 0 | 11–35 ms |
| Referencia sin bloqueo previo | 40/40 | 12–22 | **18–28** de 40 | 0 | ~1 040 ms (`deadlock_timeout`) |

**Mayor concurrencia** (nuevo): 300 ventas simultáneas sobre 40 conexiones, en un viaje de 6 paradas con 6 asientos y aforo de 4. Cada venta pide un tramo aleatorio, 1 o 2 asientos en orden aleatorio y aforo por persona.

| Ejecución | Ventas | `ResourceUnavailableError` | `CapacityExceededError` | Otros errores | Tiempo |
|---|---|---|---|---|---|
| 7 ejecuciones (rango) | 10–23 | 231–277 | 0–59 | **0** | 0,71–0,86 s |

Cada ejecución verifica, además:

- 0 pares de asignaciones activas superpuestas en el mismo asiento;
- las asignaciones activas coinciden exactamente con las ventas confirmadas;
- el aforo nunca supera la capacidad, y la reconciliación de contadores es correcta;
- **cada rechazo está justificado** por el estado final: un asiento ocupado en un tramo superpuesto, o un tramo sin aforo.

Los conflictos de disponibilidad llegan siempre como errores de dominio controlados. En la API se expondrán como `409` con el formato único (Fase 8).

## 3. Hallazgos de las pruebas de concepto y decisiones

| Hallazgo | Decisión |
|---|---|
| Prisma Migrate elimina en la siguiente migración las FK escritas a mano en SQL | **ADR-024:** FK en el esquema Prisma; EXCLUDE, CHECK y RLS en SQL; prueba de deriva obligatoria en CI |
| En una conexión reutilizada, `current_setting('app.tenant_id', true)` devuelve `''` y `''::uuid` lanza `22P02` | **ADR-025:** políticas con `NULLIF(…, '')`; tenant fijado por transacción, nunca heredado |
| Con solo la exclusión GIST, las colisiones simultáneas abortan a menudo con `40P01` (~1 s) en lugar de `23P01` | **ADR-026:** bloqueo ordenado `FOR NO KEY UPDATE` de los recursos antes del INSERT |
| Las PrismaPromise son perezosas: el tenant se lee al hacer `await` | El `await` debe ocurrir dentro del contexto CLS (documentado en la extensión) |
| La extensión de sesión no sirve dentro de transacciones interactivas | `setTransactionTenant` como primera sentencia (probado) |

## 4. Notas de entorno

- Node 24 vía `nvm use` (`.nvmrc`). Con el Node 18 del sistema, `pnpm` funciona pero no cumple `engines`.
- Docker Desktop debe estar iniciado (`systemctl --user start docker-desktop`). Solo comparte rutas bajo `/home`, así que las copias del repositorio fuera de `/home` no pueden montar el script de inicialización.
- **Volúmenes de desarrollo creados antes de este cambio:** no tienen la base `yebo_migrations`. Se crea una vez con el bloque del script `infrastructure/docker/postgres/init/01-roles-and-databases.sh` (como superusuario, vía `docker exec`), o recreando los volúmenes. Ya está aplicado en el entorno local.
- Disco: 36 GB libres (93 %).
- Las PoC no forman parte del esquema de producción. El módulo `inventory` se construirá en las Fases 6–8 a partir de `allocator.ts`.

## 7. Revisión del PR #1 (2026-11-05)

Revisión de código del PR, nivel medio. Se verificaron en el código los hallazgos de producción (1–4); los demás son razonables según el código, y cada corrección lleva una prueba de regresión. Tras las correcciones: unitarias **38** (api 36, contracts 2), integración **6 suites · 74 correctas · 1 omitida**, y lint, typecheck y build 15/15.

| # | Hallazgo | Corrección | Prueba |
|---|---|---|---|
| 1 | `TenantDbService.client` exponía `$transaction`: una transacción interactiva abierta desde él ejecutaría cada operación de tenant en otra transacción por lotes, fuera de la atomicidad del llamador | `withoutInteractiveTransactions()`: sin `$transaction` en los tipos y en tiempo de ejecución (`TenantTransactionMisuseError`). Las transacciones de tenant usan `TenantDbService.transaction()` | PoC 1: `client.$transaction` rechazado y el resto del cliente operativo |
| 2 | Comentario que remitía a `runTenantTransaction`, que no existe | Remite a `TenantDbService.transaction()` / `setTransactionTenant` | — |
| 3 | La verificación estática de ADR-025 recortaba el código tras `SELECT *` o `--`: falso negativo | Solo se descartan líneas que son enteramente comentario | 3 pruebas del propio detector (`SELECT *`, resta, comentario final) |
| 4 | `RedisService` enviaba `QUIT` aunque la conexión nunca se hubiera abierto o Redis no respondiera | `quit()` solo con `ready`; en otro estado, `disconnect()` | `redis.service.spec.ts` (3 casos) |
| 5 | PoC 2 · `release()` bloqueaba los contadores asignación por asignación, sin el orden global | Un solo bloqueo ordenado `(pool_id, segment_seq)` para todas las asignaciones del titular | 20 rondas de liberación en orden inverso frente a una venta: 0 errores |
| 6 | PoC 2 · al liberar una retención vencida de un recurso no se liberaba su aforo | Liberación previa y **completa** (recursos + pools) de las retenciones vencidas que estorban, en una transacción aparte | Asiento + aforo con capacidad 1; retención solo de aforo |
| 7 | PoC 2 · pedir un camarote y una de sus camas duplicaba la cama | Hojas sin duplicados | Camarote libre + cama: se vende |
| 8 | PoC 2 · el mismo pool pedido dos veces fallaba con un mensaje engañoso | Demandas agregadas por pool | `[1, 2]` sobre el mismo pool → uso 3 |
| 9 | PoC 2 · `sell()` lanzaba errores de forma síncrona; un `ROLLBACK` fallido ocultaba el error original y devolvía al pool una conexión rota | `sell` asíncrona; `ROLLBACK` protegido y `release(err)` | Rechazo como promesa; cliente simulado con `ROLLBACK` fallido |
| 10 | `api-status.ts` duplicado en `apps/web` y `apps/platform` | **Diferido** (decisión del responsable): se unificará con `packages/api-client` (ADR-006) | — |

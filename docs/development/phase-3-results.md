# Fase 3 — Multitenancy y seguridad: resultados

**Fecha:** 2026-11-10 · **Estado:** etapas 3.1 a 3.4 implementadas; **pendiente de revisión** · **Plan:** [phase-3-plan.md](phase-3-plan.md)

**Criterio de aceptación (roadmap):** las pruebas demuestran el aislamiento total entre tenants (multitenancy §7). **Cumplido:** las siete pruebas de §7 se ejecutan en CI, sobre endpoints reales donde aplica, y todas pasan (§2).

## 1. Qué se construyó

| Etapa | Contenido | Dónde está |
|---|---|---|
| **3.1** | Esquema de tenancy e identidad (9 tablas); RLS forzado con `NULLIF`; resolución del tenant por host con caché | PR #4 (`183f640`) |
| **3.2a** | Sesiones de identidad y de empresa: Argon2id, JWT EdDSA, refresh rotativo con sucesor cifrado y verificación en PostgreSQL en cada request; rol `yebo_identity` | Commit local `83df1c1` (`fase-3/3.2-sesiones`) |
| **3.2b** | Hub de cuentas y flujo propio OAuth 2.0 + PKCE S256; cookies `__Host-`, CSRF y límites de intentos; pantallas con la identidad YEBO v1.0 | Commit local `83df1c1` |
| **3.3** | Denegar por defecto: cadena de guards globales (host → autenticación → permiso → estado del tenant), lista blanca de rutas públicas y ESLint; permisos y plantillas; matriz de estados; gestión mínima de accesos | Commit local `1c695b1` (`fase-3/3.3-autorizacion`) |
| **3.4** | Pruebas de extremo a extremo sobre endpoints autenticados; medición del coste de una transacción por operación; este informe | Rama `fase-3/3.4-cierre`, sin commit |

Fuera de la Fase 3 por decisión del responsable: `platform_users`, MFA del staff y `support_access_grants` (Fase 4).

## 2. Las pruebas de multitenancy §7

| § | Prueba | Dónde | Sobre endpoints reales |
|---|---|---|---|
| 7.1 | Un usuario de A con ids de B recibe `404`, no `403` | `access.int-spec` (suspender, reactivar, cerrar sesiones, asignar roles y roles de B) | ✅ |
| 7.2 | Token de A en el host de B → `401` | `access.int-spec` (todas las rutas protegidas, por barrido); `isolation-e2e.int-spec` (100 peticiones cruzadas con carga) | ✅ |
| 7.3 | Persona con membresía en A y B: con sesión en A no ve B | `access.int-spec`; `isolation-e2e.int-spec` (misma persona, misma sesión de identidad, 600 peticiones entrelazadas) | ✅ |
| 7.4 | `yebo_app` sin `app.tenant_id`: 0 filas | `tenancy.int-spec` (todas las tablas de tenant); `isolation-e2e.int-spec` (en el pool de la API, tras la carga) | ✅ |
| 7.5 | FK cruzada entre tenants → violación | `tenancy.int-spec` (también con `yebo_platform`); `isolation-e2e.int-spec` (ninguna fila mezcla tenants tras 40 escrituras concurrentes) | ✅ |
| 7.6 | N peticiones paralelas de tenants distintos no mezclan contexto | `tenancy.int-spec` (200, sitio público); `isolation-e2e.int-spec` (600 autenticadas + 40 escrituras) | ✅ |
| 7.7 | Toda tabla con `tenant_id` tiene RLS habilitado y forzado | `tenancy.int-spec` (recorre el esquema; excepciones globales declaradas) | ✅ |

**Requisito de la 3.3** (verificación de sesión en todas las rutas protegidas): un barrido recorre las rutas registradas y comprueba que cada una es pública y está en la lista blanca, o está protegida. En cada ruta protegida verifica el rechazo sin token, con la sesión revocada, con un token de otra empresa, con una versión de permisos anterior y con un host desconocido.

**Pruebas de mutación** (cada protección desactivada a propósito; la suite debe fallar):

| Etapa | Mutaciones detectadas |
|---|---|
| 3.2a | Carreras de refresh, orden de bloqueo y revocación ([phase-3-plan](phase-3-plan.md)) |
| 3.3 | Los 4 guards, CSRF, versión de permisos, anti-escalada, `FOR UPDATE` y cierre de sesiones al suspender y reactivar. Una sola mutación sobrevive y es equivalente (falla cerrado) |
| 3.4 | `set_config(..., false)`, que hace el contexto persistente en la conexión (lo detecta §7.4 tras la carga). Un guard que reutiliza el tenant de una petición anterior (lo detectan 3 pruebas) |

### Totales (2026-11-10, Node 24.22.2, PostgreSQL 17.6, Redis 7.4.6)

| Verificación | Resultado |
|---|---|
| `pnpm format:check`, `lint`, `typecheck` y `build` | ✅ |
| Unitarias | ✅ 100 (api 98, contracts 2) |
| Integración | ✅ **12 suites, 213 pruebas**: access 30, sessions 31, hub-flow 31, boundaries 29, tenancy 13, http 9, migration-paths 6, migrations 3, isolation-e2e 4, queue 1, PoC tenancy 26, PoC inventory 30 |

Las pruebas de integración se ejecutaron contra contenedores desechables de PostgreSQL y Redis, creados con los mismos scripts de inicialización que usa CI. **No se aplicaron migraciones a `yebo_dev`** ni a ninguna base del proyecto.

**Sala limpia que simula CI** (como en la Fase 2):
- **Origen:** una copia que contiene solo los archivos versionados, sin `node_modules` ni `.env`, y no incluye la carpeta local `identidad/`.
- **Preparación:** `pnpm install --frozen-lockfile`, credenciales nuevas con `scripts/dev/init-env.sh` y una base creada desde cero con los scripts de `postgres/init/`.
- **Resultado:** formato, lint, tipos, 100 unitarias, build y 213 pruebas de integración en verde.
- **Diferencia con CI:** la infraestructura se levantó con `docker run` en puertos propios (55434 y 6390), no con `pnpm infra:up`. El compose fija el nombre de proyecto `yebo-dev` y habría actuado sobre el entorno de desarrollo, que estaba en marcha.

## 3. Coste de "una transacción por operación" (multitenancy §4.2)

**Qué se mide.** Fuera de una transacción explícita, cada operación de tenant viaja como un lote: `BEGIN`, `set_config('app.tenant_id', …, true)`, la consulta y `COMMIT`. Son **4 idas y vueltas** en lugar de una. Medición: `pnpm --filter @yebo/api bench` (`test/bench/tenant-transaction.bench-spec.ts`). No forma parte de CI porque los tiempos dependen de la máquina.

**Entorno:** portátil de 8 núcleos y 7 GB; PostgreSQL 17.6 en Docker en la misma máquina; Prisma 7.10 con `@prisma/adapter-pg`; pool de 10 conexiones (`PG_POOL_MAX` por defecto). En serie: 2000 muestras tras 200 de calentamiento. Concurrente: 20 tareas × 150. En milisegundos:

| Escenario | Media | p50 | p95 | p99 | Ops/s |
|---|---|---|---|---|---|
| 0a · `SELECT 1` con el driver `pg` (una ida y vuelta) | 1,01 | 0,93 | 1,43 | 1,90 | — |
| 0b · `SELECT 1` con Prisma (`$queryRaw`) | 1,38 | 1,28 | 1,93 | 2,31 | — |
| 0c · `BEGIN; set_config; SELECT; COMMIT` con el driver `pg` | 4,34 | 3,96 | 5,97 | 8,12 | — |
| 1 · Lectura sin RLS ni transacción (`yebo_platform`, referencia) | 2,14 | 2,02 | 2,80 | 3,58 | — |
| 2 · Lectura con `yebo_app`, una transacción por operación | 6,75 | 6,39 | 8,65 | 11,83 | — |
| 3a · 3 lecturas en serie, una transacción cada una | 19,17 | 18,23 | 24,07 | 31,06 | — |
| 3b · 3 lecturas en paralelo, una transacción cada una | 9,21 | 8,68 | 11,93 | 17,17 | — |
| 4 · 3 lecturas en **una** transacción | 10,57 | 9,91 | 13,39 | 20,44 | — |
| 1 · Referencia, 20 concurrentes | 13,88 | 13,51 | 17,82 | 23,19 | 1433 |
| 2 · Una transacción por operación, 20 concurrentes | 48,73 | 47,51 | 62,13 | 81,56 | 408 |
| 3a · 3 lecturas, una transacción cada una, 20 concurrentes | 144,21 | 142,74 | 169,88 | 204,01 | 138 |
| 4 · 3 lecturas en una transacción, 20 concurrentes | 81,92 | 79,03 | 110,94 | 125,12 | 243 |

Peticiones HTTP reales con la cadena de guards completa (500 en serie):

| Petición | Transacciones de PostgreSQL por petición | Media | p50 | p95 | p99 |
|---|---|---|---|---|---|
| `GET /api/v1/public/site` (resolver en caché, sin sesión) | ~0 | 4,29 | 4,13 | 5,47 | 8,96 |
| `GET /api/v1/auth/session` (sesión + permisos) | ~2 | 22,14 | 21,20 | 28,37 | 35,28 |
| `GET /api/v1/members` (sesión + permisos + lista + personas) | ~4 | 38,01 | 36,96 | 46,15 | 53,94 |

### Lectura de los datos

- **El coste es de latencia, no de trabajo de PostgreSQL.** Una ida y vuelta cuesta ~1 ms en este entorno (red de Docker). La transacción por operación añade 3 idas y vueltas: con el driver directo pasa de ~1 a ~4,3 ms, y con Prisma de 2,1 a 6,8 ms (**×3,2**). En producción el factor depende de la distancia entre la API y la base de datos.
- **Penaliza sobre todo en peticiones con varias lecturas.** Con k lecturas, una transacción por operación cuesta unas 4·k idas y vueltas; agruparlas, k + 3. Con 3 lecturas en serie, agrupar reduce la latencia a la mitad (19,2 → 10,6 ms).
- **Bajo concurrencia limita el rendimiento.** Cada operación retiene una conexión del pool durante 4 idas y vueltas. Con 20 tareas concurrentes, agrupar 3 lecturas sube el rendimiento de 138 a 243 peticiones/s (**×1,76**).
- **Paralelizar no sustituye a agrupar.** Lanzar las 3 lecturas en paralelo (3b) baja la latencia en serie, pero ocupa 3 conexiones por petición y empeora el comportamiento bajo carga.

### Recomendación (pendiente de decisión)

Multitenancy §4.2 ya prevé el remedio: "si penaliza, se agrupan las lecturas de un request en una sola transacción". Los datos muestran que penaliza en peticiones con varias lecturas. Propongo:

1. **Mantener la transacción por operación como comportamiento por defecto.** Es la que garantiza que el contexto nunca se hereda (ADR-025), y en operaciones sueltas su coste es aceptable.
2. **Regla para los servicios de negocio:** cuando un caso de uso hace dos o más operaciones de tenant, usa `TenantDbService.transaction(...)`, que ya existe y fija el tenant una sola vez. Se revisaría en cada PR y se mediría en los módulos de negocio con `pnpm bench`.
3. **No abrir una transacción por request completo.** Retendría una conexión durante toda la petición, también mientras se espera a Redis, a `yebo_identity` o a servicios externos, y agotaría el pool bajo carga.
4. **Despliegue:** la API y PostgreSQL en la misma zona de red. El coste escala con la latencia de ida y vuelta.

Aplicado a lo que ya existe, `GET /members` hace 2 transacciones de tenant (permisos y lista) que van en momentos distintos de la petición (guard y servicio). Agruparlas exigiría compartir una transacción entre el guard y el servicio. No lo propongo hasta que haya casos de uso de negocio que midan el beneficio real.

## 4. Pendientes para cerrar la Fase 3

| Tema | Estado | Quién decide |
|---|---|---|
| Revisión de la 3.1 (PR #4), 3.2 (`83df1c1`), 3.3 (`1c695b1`) y 3.4 | Pendiente | Responsable |
| **ADR-034** (separación de privilegios: `yebo_platform` sin BYPASSRLS; rol de pruebas `yebo_test_bypass`) | Dirección aprobada; SQL propuesto en phase-3-plan; **no aplicado**. Hoy el aislamiento queda demostrado para `yebo_app` y `yebo_identity`. `yebo_platform` sigue con BYPASSRLS, limitado por ESLint a `tenancy`, `health` e `infrastructure/database` | Responsable |
| Migrar `yebo_dev` (4 migraciones de la Fase 3) | Pendiente de autorización; reversiones documentadas | Responsable |
| Regla "≥ 2 operaciones → una transacción" (§3) | Recomendación | Responsable |
| Commits, push y PR de la 3.2–3.4 | Solo commits locales de la 3.2 y la 3.3 | Responsable |

Pendientes ya asignados a otras fases (detalle en phase-3-plan): `platform_users`, MFA y `support_access_grants`, que van a la Fase 4. También la auditoría persistente de denegaciones; la invalidación de la caché del tenant desde la máquina de estados (Fase 4); los tokens `Bearer` para dispositivos (Fase 14); y la gestión de roles e invitaciones.

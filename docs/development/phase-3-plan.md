# Fase 3 — Multitenancy y seguridad: plan de trabajo

- **Estado:** 🚧 En curso desde el 2026-11-05, en la rama `fase-3/multitenancy-seguridad`, apilada sobre `fase-2/fundacion-tecnica` (PR #1 aún sin integrar), por decisión del responsable.
- **Criterio de aceptación (roadmap):** las pruebas demuestran el aislamiento total entre tenants (multitenancy §7).
- **Decisiones que se implementan:**
  - ADR-003, ADR-004 y ADR-005, ADR-009, ADR-019 (parcial), ADR-022, ADR-023 y ADR-025;
  - D3 y D13;
  - `security.md` §1–3;
  - `identity-and-sessions.md`.

  **No se cambia ninguna decisión aprobada.** Si una etapa encuentra un conflicto, se documenta y se consulta antes de seguir.

## Etapas

Cada etapa termina con sus pruebas y se presenta para revisión antes de empezar la siguiente.

| Etapa | Contenido | Pruebas de aceptación |
|---|---|---|
| **3.1 · Esquema base y resolución del tenant** | Tablas `tenants` y `tenant_domains` (globales); `users` (global); `tenant_memberships`, `roles`, `role_permissions` y `membership_roles` (de tenant, con RLS y FK compuestas); catálogos `permissions` y `role_templates`. Matriz de privilegios por rol de BD. `TenantResolver` (host → tenant, caché Redis de TTL corto) y contexto de tenant por request. `GET /api/v1/public/site` mínimo | §7.4 (0 filas sin contexto), §7.5 (FK cruzada), §7.7 (cobertura RLS), matriz de privilegios, el host resuelve solo dominios verificados, `X-Forwarded-Host` solo desde el proxy de confianza, registro de modelos de tenant completo |
| **3.2 · Autenticación y sesiones** (dividida en 3.2a y 3.2b, ver más abajo) | Argon2id calibrado; `platform_users`; hub de cuentas (`authorization code` + PKCE); `identity_sessions`, `tenant_sessions`, `refresh_tokens` (rotación con ventana de 20 s y detección de reutilización), `authorization_codes`; JWT EdDSA de 10 min; cookies `__Host-`; CSRF *double submit*; rate limit de login; revocación inmediata vía Redis; evaluación de `oidc-provider` (identity §4) | Flujos de identity-and-sessions §3–8; enumeración uniforme; reutilización de refresh → revocación de la familia |
| **3.3 · Autorización y estado del tenant** | Guard de autenticación (host = `tid` del token, sesión activa, versión de permisos); `@RequirePermission`; plantillas de roles; `TenantStatusGuard` + `@TenantOperation` (matriz de multitenancy §5); `support_access_grants` | §7.1–7.3 por endpoint; matriz de estados del tenant |
| **3.4 · Cierre** | Medición del coste de "una transacción por operación" (multitenancy §4.2); pruebas de aislamiento de extremo a extremo y de concurrencia (§7.6) sobre los endpoints reales; resultados en `phase-3-results.md` | Todas las de §7 en CI |

## Fuera del alcance de la Fase 3

- Planes, suscripciones, medición y alta de tenants desde el superadmin: Fase 4.
- Subdominios reservados (MKT-D6): Fase 4.
- `membership_status_history` (fuente de la medición D5) y su trigger: con la gestión de membresías de la Fase 4.
- `membership_branch_scopes`: requiere `branches` (Fase 6).
- Cifrado de campo (ADR-019): se incorpora cuando aparezca el primer dato que lo requiera (`users.phone`, `mfa_secret` en 3.2).

## Notas de implementación de la etapa 3.1

- **Dominio principal único por tenant:** el diccionario define `is_primary bool` con un "único parcial por tenant". Se implementa con `is_primary boolean NULL` limitado a `TRUE` o `NULL` (CHECK) y `UNIQUE (tenant_id, is_primary)`. Así se obtiene la misma garantía sin un índice parcial que Prisma no modela y que la prueba de deriva (ADR-024) marcaría.
- **Privilegios (multitenancy §4.3):**
  - `yebo_app` no tiene ningún acceso a `tenants`, `tenant_domains` ni `users` (el hash de contraseña nunca está a su alcance);
  - `yebo_app` tiene solo `SELECT` sobre los catálogos (`permissions`, `role_templates`) y sobre `tenant_memberships`, que se gestiona desde identidad con `yebo_platform`;
  - `yebo_app` tiene DML con RLS sobre `roles`, `role_permissions` y `membership_roles` (configuración del tenant).
- **Resolución del tenant:** se resuelve por `req.hostname`, que solo considera `X-Forwarded-Host` si la petición llega de `TRUST_PROXY`. Solo resuelven los dominios `VERIFIED`. Un host desconocido responde `404`, igual que un recurso inexistente.

## Resultados de la etapa 3.1 (2026-11-05)

| Entregable | Estado |
|---|---|
| Migración `20261105195054_fase3_1_tenancy_identity` | 9 tablas; CHECK de normalización (host, slug, dominio principal); RLS forzado con `NULLIF` en las 4 tablas de tenant; matriz de privilegios |
| Registro de modelos de tenant | `TENANT_SCOPED_MODELS` (4) + excepción global explícita `TenantDomain`; prueba unitaria que lo contrasta con `schema.prisma` |
| Módulo `tenancy` (L0, autorizado a usar `yebo_platform` en `eslint.config.mjs`) | `TenantResolverService` (caché Redis: 60 s positiva y 15 s negativa; si Redis falla, consulta PostgreSQL), `TenantHostGuard`, `GET /api/v1/public/site` con contrato Zod en `@yebo/contracts` |

| Prueba | Resultado |
|---|---|
| §7.4 · `yebo_app` sin contexto o con contexto vacío | 0 filas en las 4 tablas de tenant |
| §7.5 · FK cruzada (rol de B en una membresía de A), incluso con `yebo_platform` | Rechazada (`P2003`) |
| §7.6 · 200 requests concurrentes de dos hosts | Ninguna mezcla de tenant |
| §7.7 · cobertura de RLS | Todas las tablas con `tenant_id` tienen RLS forzado, salvo la excepción declarada `tenant_domains` (sin RLS y sin acceso para `yebo_app`) |
| §4.3 · privilegios | `yebo_app`: sin acceso a `tenants`, `tenant_domains` ni `users`; solo lectura de catálogos y membresías; DML con RLS en roles |
| ADR-004 · host | Solo dominios `VERIFIED`; host desconocido → `404 NOT_FOUND`; `X-Forwarded-Host` solo desde el proxy de confianza; invalidación de caché |
| Extensión de producción con modelos reales | Filtra por el tenant del contexto; lectura cruzada por id → `null` |
| Migraciones | Desde base vacía y **desde el esquema de la Fase 2** (ya no se omite); sin deriva |
| Totales | Unitarias **41** · integración **7 suites, 88 pruebas** · lint, typecheck y build 15/15 |

**Pendiente para la etapa 3.2:** autenticación y sesiones. La base de desarrollo (`yebo_dev`) se actualiza con `pnpm --filter @yebo/api db:migrate:deploy`.

## Etapa 3.2 · división en 3.2a y 3.2b

La etapa 3.2 se divide en dos entregas revisables por separado:

| Subetapa | Contenido | Depende de |
|---|---|---|
| **3.2a · Servicios de sesión** (esta entrega) | Argon2id calibrable; access tokens JWT EdDSA de 10 min; `identity_sessions`, `tenant_sessions` y `refresh_tokens`; rotación con ventana de gracia de 20 s y detección de reutilización; verificación de sesión en PostgreSQL en cada request (segunda iteración; antes, Redis); revocación (identity-and-sessions §6–8) | — |
| **3.2b · Flujos HTTP del hub** | `authorization_codes` y PKCE; `/authorize`, login, `POST /auth/token`, refresh y logout por HTTP; cookies `__Host-`; CSRF *double submit*; rate limit y respuesta uniforme del login; `GET /me/memberships`; `platform_users` y MFA TOTP (con el cifrado de campo de ADR-019) | Flujo propio OAuth 2.0 + PKCE (**decidido** el 2026-11-09, abajo) |

Motivo: la decisión sobre `oidc-provider` (ADR-022, "por evaluar en la Fase 3") condiciona el modelo de `authorization_codes` y de la sesión del hub, pero no las sesiones de empresa ni los refresh tokens, que son propios en cualquier caso (ADR-009).

## Evaluación de `oidc-provider` (ADR-022) · decidida el 2026-11-09

**Decisión del responsable:** flujo propio OAuth 2.0 *Authorization Code* + PKCE, exclusivamente para el hub y las aplicaciones de YEBO, con las protecciones de RFC 6749, RFC 7636 y RFC 9700 (lista en la sección de la segunda iteración). No se usa `oidc-provider`. Se implementará en la 3.2b, que aún no está autorizada. Comparación que llevó a la decisión:

**Qué cubriría:** solo el paso hub → código → canje (authorize, código de un solo uso, PKCE). Las sesiones de empresa, los refresh tokens con ventana de gracia, la revocación inmediata vía Redis y las cookies por dominio (ADR-009) son propios con o sin la librería.

| Criterio | `oidc-provider` 9.13.3 | Implementación propia mínima |
|---|---|---|
| Madurez y seguridad | Certificada OpenID; mantenida (MIT, última publicación 2026-10-29); PKCE y códigos de un solo uso incluidos | Superficie pequeña: una tabla, código de 60 s y un solo uso, `S256`. Se prueba contra RFC 7636 y RFC 9700 |
| Encaje con el diseño | Trae su propio modelo de sesión, *grants*, interacciones y adaptador de almacenamiento, en paralelo a `identity_sessions` y a la revocación de §8 | Usa directamente `identity_sessions` y la revocación ya implementada en 3.2a |
| Clientes | Cada dominio verificado sería un cliente dinámico (`findClient` sobre `tenant_domains`) | `redirect_uri` derivado del host verificado (identity-and-sessions §5), sin registro de clientes |
| Stack | Basada en Koa (montada dentro de NestJS/Express); añade `koa`, `jose` y sus dependencias transitivas, sujetas a revisión de terceros | Sin dependencias nuevas |
| Funciones que no se usan | ID tokens, *userinfo*, *discovery*, consentimiento | — |

**Recomendación (aceptada):** implementación propia mínima para la 3.2b, porque el flujo es de primera parte: YEBO es a la vez el proveedor y el único cliente, y no hay clientes de terceros. Se reevaluaría `oidc-provider` si en el futuro se ofrece OIDC a integraciones externas.

## Notas de implementación de la etapa 3.2a (primera iteración)

> Las notas marcadas con **[sustituida]** se cambiaron en la segunda iteración, tras la auditoría; el motivo está en la sección correspondiente más abajo.

- **Sin dependencias nuevas.** Argon2id usa `crypto.argon2` de Node 24 (API reciente de Node; si diera problemas, la alternativa es el paquete `argon2`). Los JWT se firman y verifican con Ed25519 de `node:crypto`: solo `alg: EdDSA` y `kid` conocido, firma verificada antes de leer los claims, claims con esquema Zod estricto. La alternativa sería la librería `jose`.
- **Parámetros de Argon2id:** el esquema de entorno impone los mínimos de OWASP (m = 19 MiB, t = 2, p = 1). `pnpm --filter @yebo/api calibrate:argon2` mide combinaciones en la máquina donde se ejecuta; la calibración definitiva se hace en el hardware de producción (Fase 15). En el portátil de desarrollo, el mínimo tarda unos 70 ms.
- **Clave de firma:** `AUTH_JWT_PRIVATE_KEY` (Ed25519, PEM en base64). Solo la exige el módulo de identidad; el worker no la necesita. `scripts/dev/init-env.sh` la genera, y en un `.env` existente la añade si falta. La rotación admite claves públicas anteriores (`AUTH_JWT_PREVIOUS_PUBLIC_KEYS`).
- **Modelo de datos** (identity-and-sessions §11), con FK compuestas que impiden que una sesión de empresa use la membresía de otro usuario o de otro tenant, o cuelgue de la sesión de identidad de otro usuario. `tenant_sessions` es una **excepción global con `tenant_id`**, como `tenant_domains`: se consulta para validar el token antes de abrir el contexto de tenant. `yebo_app` no tiene acceso a ninguna de las tres tablas.
- **Diferencia con el diccionario de datos:** `refresh_tokens.successor_id` no se guarda; el sucesor se obtiene por `parent_id`, con `UNIQUE (tenant_session_id, parent_id)`. Es el mismo dato sin redundancia.
- **[sustituida] Ventana de gracia:** el sucesor se guardaba en claro en Redis durante 20 s. La auditoría (A3) demostró que llegaba al disco (AOF y RDB). Ahora se guarda cifrado en la propia fila.
- **[sustituida] Revocación:** el estado se replicaba en Redis con 60 s de TTL. La auditoría (A1, A2) demostró que una sesión revocada podía aceptarse hasta 60 s, **incluso con Redis sano**, y que este texto ("inmediata") era incorrecto. Ahora cada verificación consulta PostgreSQL.
- **Eventos de seguridad:** la reutilización de un refresh token se registra en el log (`auth.refresh_token_reuse`); `audit_logs` llega con su módulo.
- **[sustituida] Módulo `identity`** usaba `PlatformPrismaService`. Ahora usa su propio rol, `yebo_identity`, y ya no está en la lista de módulos autorizados a usar `PlatformPrismaService`.
- **Inactividad y máximo absoluto:** 12 h y 30 días por defecto, por configuración global. La configuración por tenant llega con `tenant_settings` (Fase 4).

## Resultados de la etapa 3.2a, primera iteración (2026-11-09; superados por la segunda)

| Prueba | Resultado |
|---|---|
| Privilegios | `yebo_app` sin acceso a `identity_sessions`, `tenant_sessions` ni `refresh_tokens` |
| FK compuestas | Membresía de otro tenant o de otro usuario, y sesión de identidad ajena: rechazadas incluso con `yebo_platform` |
| Apertura de sesión | Access token con `sub`, `sid`, `tid`, `mid`, `ver`; solo el SHA-256 del refresh token en la BD; rechazo sin membresía ACTIVE, con usuario deshabilitado, o con un host de otro tenant o no verificado; el estado del tenant no bloquea la sesión |
| Rotación | Sucesor nuevo en cada uso; **10 refrescos concurrentes → el mismo sucesor y una sola fila nueva**; reutilización fuera de la gracia → familia revocada (`REFRESH_REUSE`) y sucesor inválido; sin caché dentro de la gracia → `409` sin revocar; otro dominio o token inventado → `401` sin revocar; inactividad → sesión expirada |
| Verificación y revocación | Revocación efectiva desde la siguiente verificación; con Redis caído se consulta PostgreSQL; un miss repone el estado con la versión de permisos vigente; "cerrar sesión" revoca A y B del navegador y no otros dispositivos; revocar la membresía en A no afecta a B; "cerrar en todos los dispositivos" puede conservar la sesión actual |
| JWT (unitarias) | `alg: none`, HS256, `kid` desconocido, firma ajena, payload alterado, claims extra, emisor ajeno, expirado y emitido en el futuro: rechazados; rotación de claves aceptada |
| Migraciones | Desde base vacía y **desde el esquema de la 3.1 con datos**; sin deriva |
| Totales | Unitarias **53** · integración **8 suites, 106 pruebas** · formato, lint, typecheck y build en verde |

**Pendiente para la 3.2b:** los flujos HTTP del hub. La decisión sobre `oidc-provider` quedó tomada el 2026-11-09.

## Etapa 3.2a · segunda iteración: correcciones de la auditoría (2026-11-09)

### Migración 20261109140000 y su reversión

**Qué hace** (`apps/api/prisma/migrations/20261109140000_fase3_2a_identity_role/migration.sql`):

1. Añade `refresh_tokens.successor_ciphertext bytea NULL`, con un CHECK: solo en tokens ya rotados y de exactamente 61 bytes (versión, IV, sucesor y etiqueta GCM).
2. Quita a `yebo_platform` todo acceso a `identity_sessions`, `tenant_sessions` y `refresh_tokens`.
3. Concede a `yebo_identity`:
   - `SELECT, INSERT, UPDATE` sobre esas tres tablas;
   - `SELECT` sobre `users`, `tenant_memberships` y `tenant_domains`.
4. Crea la política RLS `identity_read_memberships` en `tenant_memberships`: solo `SELECT`, solo para `yebo_identity`.

**Requisito previo:** el rol `yebo_identity` debe existir, porque los roles son del clúster, no de la base:
- en volúmenes nuevos lo crea `infrastructure/docker/postgres/init/01-roles-and-databases.sh`;
- en volúmenes existentes, `scripts/dev/create-identity-role.sh`, que es idempotente.

Antes, `scripts/dev/init-env.sh` añade `PG_IDENTITY_PASSWORD` a los `.env` que no la tengan.

**Efecto en las bases locales:**
- `yebo_test` y las bases auxiliares de las pruebas (`yebo_migrations`, `yebo_shadow`) se migran automáticamente al ejecutar la integración;
- **`yebo_dev` no se migra en esta iteración**. Cuando se apruebe: `scripts/dev/create-identity-role.sh` y después `pnpm --filter @yebo/api db:migrate:deploy`.

**Reversión** (como `yebo_owner`, en cada base migrada; el último paso, como superusuario):

```sql
DROP POLICY IF EXISTS "identity_read_memberships" ON "tenant_memberships";
REVOKE ALL ON "identity_sessions", "tenant_sessions", "refresh_tokens", "users", "tenant_memberships", "tenant_domains" FROM yebo_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON "identity_sessions", "tenant_sessions", "refresh_tokens" TO yebo_platform;
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_successor_ciphertext_shape";
ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "successor_ciphertext";
DELETE FROM _prisma_migrations WHERE migration_name = '20261109140000_fase3_2a_identity_role';
-- Rol (superusuario, una vez por clúster; antes, en cada base: REVOKE CONNECT/USAGE):
-- DROP ROLE yebo_identity;
```

Al revertir, el código de la iteración anterior vuelve a requerir `yebo_platform` (rama sin estas correcciones).

### Decisiones aprobadas por el responsable (2026-11-09)

- Argon2id nativo (`crypto.argon2` de Node 24).
- JWT propio con Ed25519, con las correcciones de esta iteración. Sin `jose`.
- `parent_id` en lugar de `successor_id`.
- Flujo OAuth propio (*Authorization Code* + PKCE) para el hub en la 3.2b, en lugar de `oidc-provider`.

### 1. Revocación: PostgreSQL en cada verificación

**Cambio respecto al diseño aprobado** (ADR-009 e identity-and-sessions §7 decían "estado de la sesión en Redis, con PostgreSQL como respaldo"):
- `SessionService.checkSession` consulta **siempre** PostgreSQL, en **una sola sentencia**: sesión de empresa, sesión de identidad, membresía y usuario (por clave primaria, con tres JOIN). Devuelve la `permissions_version` vigente.
- Ya no hay caché positiva en Redis, y el módulo `identity` ya no usa Redis.

**Motivo:** una caché positiva no puede garantizar la revocación. La auditoría demostró que una entrada obsoleta se aceptaba hasta 60 s:
- tras un fallo de Redis al borrar (D1);
- por carreras de reposición con Redis sano (D2, D3).

El responsable pidió que PostgreSQL sea la fuente de verdad en cada petición autenticada. El texto de ADR-009 no se edita; esta precisión queda registrada aquí, en identity-and-sessions §7 y en el registro de decisiones.

**Coste:** una consulta por clave primaria por request autenticado. Se medirá en la etapa 3.4, junto con el coste de "una transacción por operación". Si fuera necesario, la alternativa admisible es una caché **negativa** (marcas de "revocada"), que nunca puede aceptar de más.

**Garantía resultante:** una revocación surte efecto en **toda verificación que empiece después de su COMMIT**.

**Carreras que no se pueden evitar** (documentadas, no resueltas):

| Caso | Efecto | Límite |
|---|---|---|
| Petición en curso cuya verificación terminó antes del COMMIT de la revocación | Esa petición termina con la sesión que tenía | Duración de esa petición. La siguiente se rechaza |
| Verificación concurrente con la revocación (`READ COMMITTED`) | Ve el estado anterior al COMMIT | Igual que el caso anterior |
| Access token ya emitido | Sigue siendo criptográficamente válido hasta su `exp` (≤ 900 s) | Lo invalida la verificación de sesión, no el token: cualquier ruta que acepte el token sin `checkSession` sería un fallo (lo impone el guard de la 3.3) |

**Carreras resueltas con bloqueos** (ADR-026):
- **Orden de bloqueo:** sesión de identidad → sesiones de empresa (por id) → refresh tokens.
- **Renovación ↔ revocación:** la renovación bloquea la sesión antes que el token. Si confirma primero, la revocación revoca también el sucesor; si confirma después, la renovación ve la sesión revocada. Prueba: 20 pares concurrentes, sin interbloqueos y sin sesiones vivas. **Mutación:** sin el bloqueo de sesión aparecen interbloqueos y sesiones vivas.
- **Apertura ↔ "cerrar sesión":** la apertura bloquea la sesión de identidad con `FOR SHARE`. Nunca queda una sesión de empresa viva colgando de una identidad revocada. **Mutación:** sin `FOR SHARE`, 20 de 20 quedaron vivas.
- **Coherencia (hallazgo M1):** la renovación y la verificación comprueban también la sesión de identidad, la membresía y el usuario. Un cambio hecho directamente en la base se refleja en la siguiente verificación (resuelve también M2).

### 2. Sucesor del refresh token: AES-256-GCM con clave HKDF del token padre

Columna `refresh_tokens.successor_ciphertext`, en la fila del token padre:

```
clave   = HKDF-SHA256(ikm = padre en claro (32 bytes), sal = id del padre, info = "yebo:refresh-successor:v1")
cifrado = 0x01 ‖ IV (12) ‖ AES-256-GCM(sucesor (32 bytes)) ‖ etiqueta (16)   → 61 bytes
AAD     = "v1|<id del padre>|<id de la sesión>"
```

- **Quién puede descifrarlo:** solo quien presenta el token padre, que nunca se guarda (la base tiene su SHA-256, que no sirve como clave). Sin clave de servidor que gestionar.
- **Datos asociados (AAD):** impiden trasladar el cifrado a otra fila o a otra sesión.
- **Comportamiento:** el de los 20 s se mantiene. Dentro de la ventana, el mismo token devuelve el **mismo** sucesor, descifrado y comprobado contra su hash. Un cifrado manipulado da `401`.
- **Sin Redis:** la gracia ya no depende de Redis, y desaparece el `409` por caché vacía. El `409` solo queda si falta el cifrado dentro de la ventana, cosa que no debería ocurrir.
- **Ciclo de vida del cifrado:** se elimina al revocar la sesión y cuando el sucesor rota fuera de la gracia de su padre.
- **Nunca en claro:** ni en PostgreSQL, ni en Redis, ni en logs (probado).

### 3. Rol `yebo_identity` y frontera de acceso

**Permisos exactos de cada rol** sobre las tablas de las etapas 3.1 y 3.2 (`S`, `I`, `U` y `D` son SELECT, INSERT, UPDATE y DELETE; "—" significa sin acceso):

| Tabla | `yebo_app` (RLS) | `yebo_platform` (BYPASSRLS) | `yebo_identity` (sin BYPASSRLS) |
|---|---|---|---|
| `tenants` | — | S I U D | — |
| `tenant_domains` | — | S I U D | **S** |
| `users` | — | S I U D | **S** |
| `tenant_memberships` | S (RLS de su tenant) | S I U D | **S** (política propia `identity_read_memberships`, solo SELECT) |
| `roles`, `role_permissions`, `membership_roles` | S I U D (RLS de su tenant) | S I U D | — |
| `permissions`, `role_templates` | S | S I U D | — |
| `identity_sessions`, `tenant_sessions`, `refresh_tokens` | — | **— (retirado en esta iteración)** | **S I U** (sin DELETE ni TRUNCATE) |

`yebo_identity` se crea `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` y recibe solo `CONNECT` y `USAGE` del esquema. **No** está en los privilegios por defecto, así que no recibe acceso automático a tablas futuras.

**Frontera en el código:**
- **Inyección de dependencias:** `IdentityPrismaService` es un proveedor del módulo `identity` que **no se exporta**. Un proveedor de fuera no puede inyectarlo; está probado.
- **ESLint, en todo `apps/api/src`** (antes solo cubría `modules/`):
  - **frontera 1:** `PlatformPrismaService` solo en `infrastructure/database`, `health` y `tenancy`;
  - **frontera 2:** `IdentityPrismaService` solo en `modules/identity`.

  Las dos fronteras usan reglas distintas para que ninguna anule a la otra. Una prueba lintea ejemplos reales en cada ubicación.

**El tenant sale del contexto, nunca del llamador:**
- `openTenantSession` deriva el tenant del host (dominio VERIFIED) y, si el request ya tiene tenant, exige que coincida.
- `revokeTenantSession` y `revokeMembershipSessions` toman el tenant del contexto del request (fijado por `TenantHostGuard`) y lo rechazan si falta (`403`).
- `checkSession` y `refresh` rechazan una sesión de otro tenant del contexto.
- Las operaciones de ámbito de usuario o de identidad (`revokeIdentitySession`, `revokeAllForUser`) no son de empresa; en la 3.2b sus ids saldrán de la sesión autenticada del hub.

### 4. JWT

- **Audiencia:** `aud` obligatoria e igual a `AUTH_JWT_AUDIENCE` (por defecto, `yebo-tenant-api`). Un token de otra audiencia, como uno futuro de plataforma, o sin `aud`, se rechaza.
- **Vida máxima:** se rechaza un token con `exp − iat` mayor de 900 s, aunque esté bien firmado. La vida configurada nunca supera ese máximo.

**Procedimiento de rotación de claves:**
1. Generar un par Ed25519 nuevo con un `kid` nuevo (p. ej. `k2`).
2. Desplegar en **todas** las instancias con `AUTH_JWT_PRIVATE_KEY` = la clave nueva, `AUTH_JWT_KEY_ID=k2` y `AUTH_JWT_PREVIOUS_PUBLIC_KEYS=[{"kid":"k1","key":"<pública anterior, PEM SPKI en base64>"}]`. Desde ese momento se firma con `k2` y se acepta `k1`.
3. **Retirar** `k1` de `AUTH_JWT_PREVIOUS_PUBLIC_KEYS` cuando hayan pasado al menos 900 s (vida máxima) más el margen de reloj (5 s) desde el despliegue del paso 2 en la última instancia. Recomendado: en el siguiente despliegue, nunca antes de 15 minutos.
4. **Compromiso de una clave:** rotar sin conservar la anterior (los tokens emitidos con ella dejan de valer de inmediato) y revocar las sesiones afectadas si procede.

En producción, la clave privada se inyecta como secreto montado o de un gestor de secretos (Fase 15), nunca en el repositorio.

### 5. Pruebas nuevas

| Ámbito | Prueba |
|---|---|
| Privilegios | `yebo_app` y `yebo_platform` sin acceso a las tablas de sesión; `yebo_identity` sin DELETE ni TRUNCATE, solo lectura de `users`, `tenant_memberships` y `tenant_domains`, sin acceso a tenants ni a datos de empresa; la política de membresías es solo para `yebo_identity` y `yebo_app` sigue aislado; atributos del rol |
| Frontera | ESLint en 6 ubicaciones para las dos fronteras; DI rechaza inyectar `IdentityPrismaService` fuera del módulo |
| Revocación | Efecto en la siguiente verificación; cambios directos de membresía, usuario y permisos; identidad revocada por cualquier vía (M1); carrera renovación ↔ revocación (20 pares); carrera apertura ↔ "cerrar sesión" (20 pares). Las dos carreras están validadas por mutación |
| Sucesor | Cifrado de 61 bytes sin el sucesor en claro; solo lo descifra el padre; ligado a la fila y a la sesión; manipulación → `401`; borrado al revocar y al rotar fuera de la gracia; Redis sin claves de sesión |
| Redis | Con Redis caído: apertura, rotación, gracia, verificación y revocación funcionan |
| Logs | Ningún refresh ni access token aparece en los logs, ni al detectar una reutilización |
| Tenant del contexto | Operaciones de empresa sin contexto → `403`; desde B no se revoca, verifica ni renueva una sesión de A; la apertura exige que el tenant del contexto coincida con el del host |
| Expiraciones | Inactividad, máximo absoluto y caducidad del propio refresh token |
| JWT | `aud` distinta o ausente; vida de 901 s y de 1 día rechazada; vida configurada recortada a 900 s |
| Arranque y entorno | Sin `AUTH_JWT_PRIVATE_KEY` o sin `PG_IDENTITY_PASSWORD` la API no arranca; `init-env.sh` sobre archivos existentes (sin duplicar) y desde cero; el rol de identidad debe ser distinto de los otros |

**Totales:**
- unitarias: **63** (10 suites);
- integración: **136** (9 suites);
- formato, lint, typecheck y build: en verde.

### 6. Pendiente y riesgos residuales

**Pendiente** (hallazgos bajos de la auditoría y M5, sin cambios en esta iteración):
- **B1:** varias raíces de refresh token por sesión.
- **B3:** gestión de secretos en producción, en la Fase 15.
- **B4:** esquema estricto de claims.
- **B5:** límite de memoria al analizar un hash y normalización Unicode de la contraseña.
- **B6:** estabilidad de `crypto.argon2`.
- **B7:** caso límite de la cadena de tokens.
- **B9:** prefijo de entorno en las claves de Redis; ya no aplica a identidad.
- **B10:** retención de la IP y del navegador.
- **M5:** purga de sesiones y tokens.
- **M6:** concurrencia de Argon2id, en la 3.2b.

**Riesgos residuales:**
- Las carreras de la tabla del punto 1.
- `yebo_platform` sigue siendo BYPASSRLS con DML sobre el resto de tablas: lo acota la frontera 1, no la base de datos.
- El cifrado del sucesor permanece en la base desde que termina la ventana de gracia hasta que el sucesor rota (normalmente unos 10 minutos). Explotarlo exige a la vez el token padre en claro y acceso de lectura a la base.
- `yebo_dev` no se migró en esta iteración (ver la migración y su reversión, arriba).

**Requisitos de la 3.2b** (OAuth 2.0 + PKCE propio):
- solo `S256`, con `code_verifier` de 43–128 caracteres;
- código de al menos 128 bits, guardado solo como hash, válido 60 s y de un solo uso, consumido de forma atómica;
- si se reutiliza un código, revocar lo emitido con él;
- código ligado a la empresa, al `redirect_uri` exacto derivado de un dominio verificado, al host que lo canjea y a la sesión del hub;
- `state` ligado a una cookie temporal;
- canje solo por `POST`, con límite de intentos;
- `Referrer-Policy: no-referrer` y `frame-ancestors 'none'` en el hub;
- sin flujo implícito ni `redirect_uri` enviado por el cliente.

## Separación efectiva de privilegios de PostgreSQL (ADR-034)

> **Estado (2026-11-09):** dirección **aprobada** por el responsable y registrada como [ADR-034](../architecture/architecture-decisions.md). El SQL de la sección siguiente está **pendiente de revisión** y **no se ha aplicado**. Las pruebas de concepto usarán un rol de pruebas propio (decisión del responsable).

### Situación actual (medida en `yebo_test`, 2026-11-09)

| Hecho | Evidencia |
|---|---|
| **Privilegios por defecto en modo "lista negra"** | `pg_default_acl` de `yebo_owner`: toda tabla nueva concede `SELECT, INSERT, UPDATE, DELETE` a `yebo_app` **y** a `yebo_platform` (también secuencias y funciones). Cada migración tiene que **retirar** lo que sobra; si se olvida, el rol conserva el acceso |
| `yebo_platform` tiene `BYPASSRLS` y DML sobre todas las tablas, salvo las de sesión | Matriz de permisos de la segunda iteración |
| **Uso real de `yebo_platform` en ejecución** | Solo dos: `TenantResolverService` (lee `tenant_domains` y, por relación, `id, slug, trade_name, status` de `tenants`) y el health check (`SELECT 1`). El worker solo lo usa para el health check |
| Qué depende hoy de `BYPASSRLS` | **Nada en ejecución.** Solo las pruebas: la siembra de membresías en `sessions` y `tenancy`, `migration-paths` y las dos PoC |
| Contención actual | Solo ESLint (frontera 1). Con las credenciales de `yebo_platform` se pueden leer y modificar los datos de todas las empresas |

### Propuesta

| Rol | Atributos | Permisos sobre tablas | Conexión en ejecución |
|---|---|---|---|
| `yebo_app` | Sin BYPASSRLS (igual que hoy) | **Lista blanca explícita por migración** (sin privilegios por defecto): hoy, DML en `roles`, `role_permissions` y `membership_roles`; SELECT en `permissions`, `role_templates` y `tenant_memberships`. Toda tabla de tenant nueva declara su GRANT y su RLS forzado | `AppPrismaService` y `TenantDbService` (API y worker) |
| `yebo_identity` | Sin BYPASSRLS (igual que en la segunda iteración) | Sin cambios | `IdentityPrismaService` (solo API, módulo identity) |
| `yebo_platform` | **Sin BYPASSRLS** (hoy lo tiene) | **Solo `SELECT` en `tenants` y `tenant_domains`**. Sin DML ni acceso a ninguna tabla de tenant | `PlatformPrismaService` (resolvedor y health) |
| `yebo_owner` | Propietario; sujeto al RLS forzado (igual que hoy) | DDL y migraciones; nunca en ejecución | Solo Prisma CLI |

Cambios concretos:

1. **Migración nueva** (como `yebo_owner`):
   - `ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public REVOKE ALL ON TABLES|SEQUENCES|FUNCTIONS FROM yebo_app, yebo_platform`;
   - `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM yebo_platform`, y después `GRANT SELECT ON tenants, tenant_domains TO yebo_platform`;
   - reafirmar con GRANT explícito los permisos actuales de `yebo_app`.
2. **`ALTER ROLE yebo_platform NOBYPASSRLS`:** es un atributo del clúster y `yebo_owner` no puede cambiarlo. Se hace en `01-roles-and-databases.sh` para volúmenes nuevos, y con un script idempotente con superusuario (como `create-identity-role.sh`) para volúmenes existentes y producción.
3. **Init:** quitar los `ALTER DEFAULT PRIVILEGES … GRANT` actuales.

**Fase 4 en adelante** (superadmin, alta de tenants, facturación SaaS, medición): cada necesidad se cubre de forma explícita y revisada, nunca con `BYPASSRLS`:
- las tablas de plataforma (`plans`, `subscriptions`, `platform_invoices`…) con GRANT explícito;
- las lecturas entre tenants (medición D5) con una política `FOR SELECT TO <rol>` por tabla, como `identity_read_memberships`;
- las escrituras en tablas de tenant (por ejemplo, la configuración inicial al dar de alta una empresa) con `yebo_app` y el contexto de ese tenant fijado por transacción (ADR-025), de modo que el RLS sigue aplicando;
- si el superadmin y los jobs necesitan permisos distintos, roles separados (por ejemplo, `yebo_platform_admin` y `yebo_jobs`), con el mismo patrón que `yebo_leads` en ADR-028.

### Implicaciones

| Ámbito | Implicación |
|---|---|
| ADR | Elimina `BYPASSRLS` de `yebo_platform`, que ADR-003 y multitenancy §4.2 describen como "BYPASSRLS, acceso restringido". **No se edita ADR-003:** hace falta un ADR nuevo que lo precise. Ojo con la numeración: ADR-027 a 033 existen en otras ramas (PR #2 y #5), así que sería el ADR-034 |
| Mantenimiento | Toda tabla nueva necesita su GRANT explícito. Se compensa con una **prueba de "foto de privilegios"**: compara `role_table_grants`, `pg_policies`, `pg_default_acl` y los atributos de los roles con una matriz esperada versionada, y falla ante cualquier permiso de más o de menos |
| Pruebas existentes | Hay que reescribir las siembras que usan `yebo_platform` como superusuario de datos (`sessions`, `tenancy` §7.5, `migration-paths`): pasan a `yebo_owner` con `set_config('app.tenant_id', …, true)` por transacción. Las PoC de la Fase 2 dependen de `BYPASSRLS` en sus propias bases: o se adaptan igual, o se les da un rol de PoC aparte. **Decisión pendiente** |
| Producción | Script con superusuario para `ALTER ROLE` en el despliegue (Fase 15). Si se revierte, se restaura `BYPASSRLS` y los privilegios por defecto (reversión documentada en la migración) |
| Seguridad | Unas credenciales de `yebo_platform` filtradas solo permitirían leer empresas y dominios, no los datos de negocio. ESLint pasa a ser una defensa adicional, no la única |
| Riesgo de la propia migración | `REVOKE ALL … FROM yebo_platform` rompe cualquier uso no inventariado. Hoy no hay ninguno (inventario de arriba). El health check y el resolvedor siguen funcionando |

**Verificación prevista:**
- la foto de privilegios;
- `SELECT current_user` desde cada servicio Prisma en ejecución (cada uno conecta con el rol esperado);
- `yebo_platform`: no puede escribir `tenants` ni `tenant_domains`, ni leer `tenant_memberships`, `users`, sesiones o roles, y `rolbypassrls = false`;
- la integración completa en verde con las siembras adaptadas.

## Requisito de la etapa 3.3: verificación de sesión en TODAS las rutas protegidas

> **Estado:** diseño **aceptado** el 2026-11-09 (guard global con denegación por defecto, lista de rutas públicas, ESLint y pruebas automáticas de cobertura de rutas). **Implementado el 2026-11-10** en la rama `fase-3/3.3-autorizacion`, pendiente de revisión: ver [la sección de la etapa 3.3](#etapa-33--autorización-y-estado-del-tenant-implementada-el-2026-11-10-pendiente-de-revisión).

**Regla:** todo endpoint que no sea explícitamente público verifica, **en cada petición**:
1. el access token (firma EdDSA, `iss`, `aud`, vida ≤ 900 s);
2. `tid` igual al tenant resuelto por el host (ADR-004);
3. `SessionService.checkSession(sid)` en PostgreSQL (sesión de empresa y de identidad vigentes, membresía y usuario ACTIVE);
4. `ver` igual a la `permissions_version` vigente; si no, `401 PERMISSIONS_CHANGED`.

Sin esta verificación, un access token de una sesión revocada seguiría valiendo hasta su `exp`.

**Cómo se impide que una ruta la omita:**

| Mecanismo | Detalle |
|---|---|
| **Guard global y "denegar por defecto"** | `TenantHostGuard` y el guard de autenticación se registran como `APP_GUARD`, en ese orden. Toda ruta queda protegida salvo que lleve `@Public()`. No depende de que cada controlador recuerde `@UseGuards` |
| Lista blanca de rutas públicas | Las rutas `@Public()` aprobadas (hoy: health y `GET /api/v1/public/site`) se versionan en un archivo. Añadir una pública obliga a cambiar ese archivo, lo que se ve en la revisión del PR |
| Metadatos obligatorios | Toda ruta protegida declara `@RequirePermission(...)` o `@AuthenticatedOnly()`, y su categoría `@TenantOperation(...)` (ADR-023). Si falta, el guard la **rechaza** con `500` y una prueba la detecta |
| ESLint | Prohibir `@Public()` fuera de los módulos autorizados, y prohibir sustituir los guards globales |

**Cómo se probará:**
- **barrido de rutas:** una prueba recorre todas las rutas registradas en Nest/Express y comprueba que cada una es pública y está en la lista blanca, o está protegida;
- en cada ruta protegida (integración, contra la base real):
  - sin token → `401`;
  - token de una sesión revocada → `401`;
  - token de otro tenant presentado en este host → `401`;
  - token con la versión de permisos anterior → `401 PERMISSIONS_CHANGED`;
- **prueba de mutación:** con el guard global desactivado, el barrido debe fallar.

## Clasificación de los pendientes de la auditoría

> **Estado (2026-11-09):** clasificación **aceptada** por el responsable. **Ninguno está resuelto**: cada uno se cerrará solo con su implementación y su prueba, en la etapa indicada.

| ID | Pendiente | ¿Antes de producción? | Etapa | Motivo |
|---|---|---|---|---|
| **M6** | Concurrencia de Argon2id (tope de cálculos simultáneos, `UV_THREADPOOL_SIZE`) | **Sí** | **3.2b** | Llega con el login HTTP y su límite de intentos; sin él, el login es un vector de denegación de servicio |
| **B5** | Límite de memoria al analizar hashes y normalización Unicode (NFKC) | **Sí** | **3.2b** | Junto con la política de contraseñas (longitud mínima 10) del alta y del cambio de contraseña |
| **B6** | Estabilidad de `crypto.argon2` | **Sí** (verificación) | **3.2b** y de nuevo en la **Fase 15** | Confirmarla en la documentación de Node al fijar la versión de producción; si no fuera estable, el plan B es el paquete `argon2` |
| **M5** | Purga de sesiones y tokens caducados, y su índice | **Sí** | **3.4** (cierre de la Fase 3) | La tabla crece sin límite. Job en el worker con retención definida |
| **B10** | Retención de la IP y del navegador de las sesiones (Ley 29733) | **Sí** | **3.4**, con M5 | La misma purga anonimiza o borra pasado el plazo; el plazo lo valida un asesor |
| **B1** | Varias raíces de refresh token por sesión | Recomendable | **3.4** | Endurecimiento (índice único o trigger). El código ya crea una sola raíz |
| **B3** | Clave de firma en variable de entorno; retirada de claves anteriores | **Sí** | **Fase 15** | Secreto montado o gestor de secretos; el procedimiento de rotación ya está documentado |
| **B9** | Prefijo de entorno en las claves de Redis | **Sí**, si hay un Redis compartido entre entornos | **Fase 15** | Ya no afecta a identidad. Una instancia por entorno o un prefijo obligatorio |
| **B4** | Esquema estricto de claims (compatibilidad al añadir uno) | No | **3.3** (documentar) | Procedimiento: desplegar primero quien verifica y después quien firma |
| **B7** | Caso límite de la cadena de tokens dentro de la gracia | No | **3.2b** (evaluar) y **Fases 5/13** (frontend) | Lo mitiga Web Locks en el frontend; en el backend se valorará al implementar el endpoint de refresh |

## SQL propuesto para ADR-034 (aplicado el 2026-11-10, con los ajustes de la sección de implementación)

### Inventario previo (lecturas sobre el clúster local, PostgreSQL 17.6, 2026-11-09)

| Comprobación | Resultado |
|---|---|
| Pertenencias entre roles (`pg_auth_members`) de `yebo_*` | **Ninguna**, ni con roles predefinidos (`pg_read_all_data`, `pg_write_all_data`…) |
| Atributos | Solo `yebo_platform` tiene `BYPASSRLS`. Todos tienen `INHERIT` (sin efecto hoy, porque no hay pertenencias) |
| Funciones `SECURITY DEFINER` fuera del catálogo | **Ninguna** (en `yebo_test` y `yebo_dev`) |
| Configuración por rol o por base (`rolconfig`, `pg_db_role_setting`) | Ninguna |
| Propietarios en `public` | 13 tablas y 7 enums de `yebo_owner`; 235 funciones de las extensiones (`citext`, `btree_gist`) de `postgres`, ejecutables por `PUBLIC`; **sin secuencias** |
| Esquema `public` | Propietario `yebo_owner`; USAGE para app, platform e identity; sin CREATE ni acceso de `PUBLIC` |
| Bases | `CONNECT` de app, platform e identity en **todas** las bases del clúster, incluidas `yebo_shadow` y las de PoC |
| Privilegios por defecto (`pg_default_acl`, en todas las bases) | Tablas: SELECT, INSERT, UPDATE y DELETE; secuencias: SELECT y USAGE; funciones: EXECUTE, a `yebo_app` y `yebo_platform` |
| **Hallazgo:** `_prisma_migrations` | `yebo_app` y `yebo_platform` tienen DML sobre el **historial de migraciones** (por los privilegios por defecto) |

### Parte A · Nivel de clúster (superusuario; idempotente)

Va en `infrastructure/docker/postgres/init/01-roles-and-databases.sh` (volúmenes nuevos) y en un script nuevo `scripts/dev/harden-roles.sh` (volúmenes existentes). En producción irá en el aprovisionamiento de la Fase 15, **sin** la sección A4.

```sql
-- A1. Atributos: ningún rol de ejecución salta RLS ni hereda privilegios.
ALTER ROLE yebo_platform NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE yebo_app      NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE yebo_identity NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE yebo_owner    NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEROLE NOREPLICATION;

-- A2. Sin pertenencias: se revoca cualquiera que exista (también de roles predefinidos de PostgreSQL).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT g.rolname AS grp, m.rolname AS mem
             FROM pg_auth_members am
             JOIN pg_roles g ON g.oid = am.roleid
             JOIN pg_roles m ON m.oid = am.member
            WHERE m.rolname IN ('yebo_app', 'yebo_platform', 'yebo_identity', 'yebo_owner')
  LOOP
    EXECUTE format('REVOKE %I FROM %I', r.grp, r.mem);
  END LOOP;
END $$;

-- A3. Conexión: cada rol de ejecución, solo a las bases que usa.
REVOKE CONNECT ON DATABASE yebo_shadow FROM yebo_app, yebo_platform, yebo_identity;          -- solo Prisma (owner)
REVOKE CONNECT ON DATABASE yebo_poc_tenancy, yebo_poc_inventory FROM yebo_identity;          -- las PoC no usan identidad
-- (yebo_dev, yebo_test y yebo_migrations conservan CONNECT para app, platform e identity)

-- A4. Rol de pruebas (SOLO en clústeres de desarrollo y CI; nunca en producción).
-- La contraseña viene de TEST_PG_BYPASS_PASSWORD en infrastructure/docker/.env.
CREATE ROLE yebo_test_bypass LOGIN PASSWORD :'test_pass'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT BYPASSRLS;   -- (si no existe)
REVOKE CONNECT ON DATABASE yebo_dev, yebo_shadow FROM yebo_test_bypass;  -- no en desarrollo compartido
GRANT  CONNECT ON DATABASE yebo_test, yebo_poc_tenancy, yebo_poc_inventory, yebo_migrations TO yebo_test_bypass;
-- USAGE del esquema en esas cuatro bases (en cada una):
GRANT USAGE ON SCHEMA public TO yebo_test_bypass;
```

Los permisos de tabla del rol de pruebas **no van en ninguna migración** (las migraciones llegan a producción). Los concede `test/support/global-setup.ts`, como `yebo_owner`, después de migrar cada base de prueba:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yebo_test_bypass;
```

### Parte B · Migración nueva (como `yebo_owner`, vía `prisma migrate deploy`)

Nombre propuesto: `2026111xxxxxxx_adr034_privilege_separation`.

```sql
-- B1. Privilegios por defecto: de lista negra a LISTA BLANCA. Ninguna tabla, secuencia o función futura
--     concede nada a los roles de ejecución; cada migración declara sus GRANT.
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public REVOKE ALL ON TABLES    FROM yebo_app, yebo_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM yebo_app, yebo_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM yebo_app, yebo_platform;
-- Funciones propias futuras: tampoco para PUBLIC (las de las extensiones, de postgres, no se tocan).
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- B2. Estado actual: se parte de cero para los tres roles de ejecución y se concede la lista blanca.
--     Incluye _prisma_migrations, que queda SOLO para yebo_owner.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM yebo_app, yebo_platform, yebo_identity;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM yebo_app, yebo_platform, yebo_identity;

-- yebo_app: exactamente lo que tiene hoy, ahora explícito.
GRANT SELECT, INSERT, UPDATE, DELETE ON roles, role_permissions, membership_roles TO yebo_app;
GRANT SELECT ON permissions, role_templates, tenant_memberships TO yebo_app;

-- yebo_identity: igual que la migración 20261109140000.
GRANT SELECT, INSERT, UPDATE ON identity_sessions, tenant_sessions, refresh_tokens TO yebo_identity;
GRANT SELECT ON users, tenant_memberships, tenant_domains TO yebo_identity;

-- yebo_platform: solo lectura de lo que usa el resolvedor de dominios.
GRANT SELECT ON tenant_domains TO yebo_platform;
GRANT SELECT ON tenants TO yebo_platform;
-- Variante más estricta (recomendada; requiere probar las consultas de Prisma): solo las columnas que se usan.
--   GRANT SELECT (id, slug, trade_name, status) ON tenants TO yebo_platform;

-- B3. RLS: sin cambios. El RLS forzado y tenant_isolation (TO public) siguen en las 4 tablas de tenant;
--     identity_read_memberships (TO yebo_identity, FOR SELECT) se mantiene. yebo_platform no recibe ninguna
--     política: no tiene permisos sobre tablas de tenant.
```

**Propietarios, esquema y tipos:**
- todo sigue siendo de `yebo_owner` (tablas y enums) o de `postgres` (funciones de las extensiones), y ningún rol de ejecución es propietario de nada;
- los enums conservan `USAGE` para `PUBLIC` (por defecto en PostgreSQL), que los roles necesitan para leer y escribir columnas enumeradas;
- no hay secuencias (las claves son UUID v7), pero B1 y B2 cubren las futuras.

### Garantías frente a la herencia indirecta

`yebo_platform` no puede obtener `BYPASSRLS` ni privilegios de otros roles por ninguna de estas vías:
1. **`NOBYPASSRLS`:** los atributos de rol no se heredan; solo `SET ROLE` a un rol con BYPASSRLS lo daría.
2. **Pertenencias:** no es miembro de ningún rol. A2 lo garantiza y la prueba de la foto de privilegios lo comprueba, así que no puede hacer `SET ROLE` ni heredar permisos.
3. **`NOINHERIT`:** si en el futuro se le concediera una pertenencia por error, no heredaría sus permisos (aunque podría hacer `SET ROLE`; por eso también se prueba que no haya pertenencias).
4. **Funciones `SECURITY DEFINER`:** no hay ninguna, y la foto lo comprueba. Toda función futura con `SECURITY DEFINER` requerirá revisión explícita.
5. **Privilegios por defecto:** B1 los elimina.
6. **`PUBLIC`:** sin acceso a la base ni al esquema, y sin EXECUTE en funciones propias futuras (B1).
7. **Propiedad:** el propietario de una tabla tiene todos sus permisos, pero ningún rol de ejecución es propietario de nada.

### Compatibilidad

| Caso | Tratamiento |
|---|---|
| Migraciones futuras | Cada `CREATE TABLE` debe ir acompañado de sus GRANT y, si tiene `tenant_id`, de su RLS forzado. La plantilla de migración y la **foto de privilegios** (matriz esperada versionada) lo hacen obligatorio: un GRANT olvidado o sobrante rompe la CI. La prueba de deriva (ADR-024) no ve los GRANT; por eso se añade la foto |
| Volúmenes existentes | 1) `scripts/dev/harden-roles.sh` (parte A, superusuario); 2) `pnpm --filter @yebo/api db:migrate:deploy` (parte B). Las dos partes son independientes e idempotentes |
| Volúmenes nuevos y CI | `01-roles-and-databases.sh` crea los roles ya endurecidos y sin `ALTER DEFAULT PRIVILEGES … GRANT`; las migraciones aplican B |
| PoC de la Fase 2 | Sus bases conservan sus migraciones. Sus pruebas sustituyen el cliente `platform` por `yebo_test_bypass`; los GRANT de este rol los pone `global-setup` |
| Pruebas de integración | Las siembras con `yebo_platform` (`sessions`, `tenancy` §7.5, `migration-paths`) pasan a `yebo_test_bypass`. Las aserciones de privilegios de `yebo_platform` se actualizan a la nueva matriz |
| Producción (Fase 15) | Aprovisionamiento con superusuario: A1–A3, sin A4. Migraciones: B |

**Reversión** (si hiciera falta):
1. `ALTER ROLE yebo_platform BYPASSRLS` y restaurar `INHERIT`, con superusuario;
2. volver a crear los `ALTER DEFAULT PRIVILEGES … GRANT` originales para `yebo_app` y `yebo_platform`;
3. restaurar los GRANT anteriores, incluido el DML de ambos sobre `_prisma_migrations` (no se recomienda);
4. `DELETE FROM _prisma_migrations WHERE migration_name = '<la de B>'`;
5. `DROP ROLE yebo_test_bypass` en los clústeres de desarrollo.

### Rol de pruebas: aislamiento y comprobaciones en CI

| Requisito del responsable | Cómo se cumple | Comprobación automática |
|---|---|---|
| Solo existe en bases de prueba | Lo crea solo el init y el script de **desarrollo y CI**; sin `CONNECT` en `yebo_dev` ni `yebo_shadow`; sus GRANT de tabla, solo en las bases de prueba (`global-setup`) | Prueba: conectar como `yebo_test_bypass` a `yebo_dev` falla (`42501`) |
| No disponible para la aplicación | Sus credenciales viven en `apps/api/.env.test` (variables `TEST_PG_BYPASS_USER` y `TEST_PG_BYPASS_PASSWORD`), que solo carga `test/support`. El esquema de entorno de la API no las conoce y **rechaza** cualquier `PG_*_USER` igual a `yebo_test_bypass` | Unitaria del esquema de entorno; prueba que recorre `apps/api/src` y falla si aparece `TEST_PG_BYPASS` o `yebo_test_bypass` |
| No se usa en producción | No está en ninguna migración ni en el aprovisionamiento de producción | La CI falla si el nombre aparece en `apps/api/prisma/migrations/**` o en los artefactos de despliegue |
| Identificado en la configuración de pruebas | `DbRole` de pruebas separado (`'test-bypass'`) en `test/support/db.ts`, con un comentario explícito | Revisión |
| **Ningún servicio de ejecución lo usa** | — | Integración: cada servicio Prisma de ejecución (`AppPrismaService`, `PlatformPrismaService`, `IdentityPrismaService`) ejecuta `SELECT current_user, rolbypassrls`. Se espera `yebo_app`, `yebo_platform` y `yebo_identity`, **los tres con `rolbypassrls = false`** |

### Verificación prevista al implementar

- **Foto de privilegios** (unitaria contra la BD de pruebas). Compara con una matriz versionada:
  - `role_table_grants` y `column_privileges`;
  - `pg_policies`;
  - `pg_default_acl`;
  - `pg_auth_members`;
  - los atributos de los roles;
  - el ACL de las bases;
  - los propietarios;
  - las funciones `SECURITY DEFINER`.
- **Negativas de `yebo_platform`:** no escribe `tenants` ni `tenant_domains`; no lee `users`, `tenant_memberships`, sesiones, roles ni `_prisma_migrations`; `SET ROLE` a otros roles falla.
- **`_prisma_migrations`:** ningún rol de ejecución lo lee ni lo escribe.
- **Resolvedor y health check** funcionan.
- **Integración completa en verde**, con las siembras sobre `yebo_test_bypass`.

## Etapa 3.2b · Hub de cuentas y flujo OAuth 2.0 + PKCE (implementada el 2026-11-10; pendiente de revisión)

Flujo propio *Authorization Code* + PKCE S256 entre el hub (`AUTH_HUB_HOST`, por defecto `cuentas.yebo.pe`) y los dominios de las empresas, según identity-and-sessions §3–8 y la decisión del 2026-11-09. Sin dependencias nuevas.

### Rutas

| Host | Ruta | Qué hace |
|---|---|---|
| Empresa | `GET /api/v1/auth/start?return=/ruta` | Genera `state` (256 bits) y `code_verifier` (43 caracteres), los guarda en `__Host-yebo_auth` (firmada, 10 min) y redirige al hub con el reto S256. **No envía `redirect_uri`** |
| Hub | `GET /api/v1/hub/authorize` | Parámetros cerrados (`response_type=code`, `tenant_host`, `state`, `code_challenge`, `code_challenge_method=S256`): cualquier otro, incluido `redirect_uri`, → `400` sin redirigir. Solo dominios VERIFIED. Según el caso: sin sesión → `/login`; sin membresía → `/sin-acceso`; si no, emite el código y redirige a `https://<host>/auth/callback` |
| Hub | `GET /api/v1/hub/csrf`, `POST /api/v1/hub/login`, `POST /api/v1/hub/logout` | Login con CSRF y límites de intentos; la sesión de identidad va en `__Host-yebo_hub` (id firmado); el logout revoca la identidad y todas sus sesiones de empresa |
| Hub | `GET /api/v1/hub/me/memberships`, `GET /api/v1/hub/branding` | Empresas del propio usuario (solo ACTIVE, con dominio principal verificado); nombre de la empresa de origen para la pantalla de login (D3.1) |
| Empresa | `POST /api/v1/auth/token` | Canje **solo por POST** (JSON `{code, state}`). Compara `state` con la cookie firmada y usa su `code_verifier`; emite `__Host-yebo_at`, `__Secure-yebo_rt` (`Path=/api/v1/auth`) y `__Host-yebo_csrf` |
| Empresa | `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/csrf` | Renovación y cierre con CSRF *double submit*. El logout revoca la sesión de la empresa y devuelve la URL de cierre del hub |
| Empresa | `GET /api/v1/auth/session` | Verificación completa por request: firma, `aud`, `tid` igual al host, sesión en PostgreSQL y `ver`; si no coincide la versión, `401 PERMISSIONS_CHANGED`. **Es el precursor del guard global de la 3.3** |

**Pantallas** (`apps/web`, estilo neutro: no hay identidad visual aprobada, MKT-D4):
- en el hub: `/login`, `/sin-acceso` (selector de empresas) y `/salir`;
- en el dominio de la empresa: `/auth/callback` (canjea por POST una sola vez y borra el código de la URL) y `/panel` (comprueba la sesión, la renueva en silencio y permite cerrar sesión);
- todas con `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` y `no-store`.

La API aplica `frame-ancestors 'none'` y `no-referrer` a todas sus respuestas (helmet).

### Protecciones (lista acordada para la 3.2b)

| Requisito | Implementación | Prueba |
|---|---|---|
| PKCE S256, verifier de 43–128 caracteres | Solo `S256` (CHECK en BD y esquema cerrado); verifier validado | Vector del Apéndice B de RFC 7636; rangos 42/43/128/129; `plain` → 400 |
| Códigos de ≥ 128 bits, solo el hash | 256 bits; se guarda SHA-256 (CHECK de 32 bytes) | El hash coincide y la longitud es 32 |
| 60 s y uso único atómico | `FOR UPDATE` sobre la fila; consumo en la misma transacción que abre la sesión (`openWithinTransaction`); CHECK de vida ≤ 65 s | Caducidad a los 61 s; **10 canjes concurrentes → 1 sesión**. Mutación: sin `FOR UPDATE`, 5 sesiones |
| Código ligado a tenant, `redirect_uri` verificado, host que canjea y sesión del hub | Columnas y FK compuestas; `redirect_uri` derivado del host (CHECK) | Canje en otro tenant o con otro verifier → 401 y código consumido |
| `state` ligado a una cookie temporal | `__Host-yebo_auth` firmada (HMAC con `AUTH_COOKIE_SECRET`), 10 min, ligada al host | `state` distinto → 401 **sin consumir** el código; cookie ausente, alterada o de otro host → 401 |
| Solo POST para el canje | `POST /api/v1/auth/token`; el callback es una página que lo invoca | Flujo completo |
| Limitación de intentos | Login: 30 por IP y 5 fallos por cuenta (también para cuentas inexistentes) en 15 min; canje: 60 por IP y minuto. Redis, con contador local del proceso si Redis falla | 6.º intento de una cuenta → 429; 31.º por IP → 429 |
| Reutilización del código → revocar lo emitido | `AUTH_CODE_REUSE` revoca la sesión emitida (RFC 6749 §4.1.2) | Segundo canje → 401 y sesión revocada. Mutación: sin revocar, la sesión seguía viva |
| `Referrer-Policy: no-referrer` y `frame-ancestors 'none'` | API (helmet) y pantallas (Next.js) | Cabeceras de `/authorize` |
| Sin flujo implícito ni `redirect_uri` libre | Esquema cerrado de `/authorize` | `response_type=token` y `redirect_uri` → 400 |
| Respuesta uniforme del login | Mismo `401` y mensaje para contraseña errónea, cuenta inexistente o deshabilitada; `verifyDummy` iguala el coste | Cuerpos idénticos |
| CSRF *double submit* | `__Host-yebo_csrf` + `X-CSRF-Token` en login, logout y refresh | Sin cabecera o distinta → 403 |
| Separación de hosts | Hub solo en `AUTH_HUB_HOST` (`HubHostGuard`); empresa solo en dominios verificados (`TenantHostGuard`) | 404 cruzados |
| Ruta de retorno sin redirección abierta | Solo rutas internas (`/…`, sin `//` ni `/\`) | `//evil`, `https://evil`, `/\evil` → `/` |

También se resolvieron dos hallazgos clasificados para la 3.2b:
- **M6:** tope de cálculos de Argon2id simultáneos (`ARGON2_MAX_CONCURRENT`, por defecto 4) con una cola acotada (`ARGON2_MAX_QUEUE`, 64); el exceso responde 503. Pruebas unitarias.
- **B5:** contraseñas normalizadas en NFKC y tope de memoria al leer un hash (1 GiB). Pruebas unitarias.

### Decisiones nuevas de la 3.2b (sin cambiar ningún ADR aceptado)

1. **Cookie del hub:** id de la sesión de identidad **firmado** (HMAC-SHA256 con `AUTH_COOKIE_SECRET`). No requiere guardar ningún token en `identity_sessions`. La revocación se sigue comprobando en PostgreSQL.
2. **El `code_verifier` no pasa por el JavaScript del navegador:** vive en la cookie firmada `httpOnly` del dominio de la empresa.
3. **Un canje fallido** (PKCE, host, tenant o caducidad) **consume el código**. Un `state` distinto, no: así un atacante no puede invalidar el inicio de sesión de otro.
4. **Variables nuevas:**
   - `AUTH_HUB_HOST` y `AUTH_COOKIE_SECRET` (obligatoria para el módulo identity; `init-env.sh` la genera);
   - `ARGON2_MAX_CONCURRENT` y `ARGON2_MAX_QUEUE`.
5. **Código de error nuevo** en `@yebo/contracts`: `PERMISSIONS_CHANGED`.
6. **Nombres comerciales para el hub:** los lee `TenantResolverService.describe` con su rol actual; `yebo_identity` no recibe acceso a `tenants`.
7. **El login no actualiza `users`** (`last_login_at`, rehash si `needsRehash`): `yebo_identity` solo tiene SELECT sobre `users` y esta tarea no cambia permisos. Se habilitará con columnas concretas al implementar ADR-034.

### Migración 20261110090000 y su reversión

`apps/api/prisma/migrations/20261110090000_fase3_2b_authorization_codes/migration.sql`:
- tabla `authorization_codes` (excepción global con `tenant_id`);
- valor `AUTH_CODE_REUSE` en `session_revoke_reason`;
- CHECK de hash, de S256, del `redirect_uri` derivado, del host normalizado, de vida ≤ 65 s y de "sesión solo si está consumido";
- privilegios: se retiran explícitamente los privilegios por defecto de `yebo_app` y `yebo_platform`, y se concede `SELECT, INSERT, UPDATE` a `yebo_identity`, igual que en las tablas de sesión.

**No se aplicó a ninguna base del proyecto.** Se probó en un PostgreSQL desechable, en la integración completa y en las rutas de migración.

**Reversión** (como `yebo_owner`):

```sql
DROP TABLE "authorization_codes";
-- PostgreSQL no permite quitar un valor de un enum; si se exigiera, hay que recrear el tipo:
--   ninguna fila usa 'AUTH_CODE_REUSE' tras borrar las sesiones revocadas por ese motivo (o reasignarlas).
DELETE FROM _prisma_migrations WHERE migration_name = '20261110090000_fase3_2b_authorization_codes';
```

### Resultados

**Totales:**
- unitarias: **75** (API, 12 suites) y **2** (contratos);
- integración: **168** (10 suites; nueva: `hub-flow`, 31 pruebas);
- formato, lint, tipos y build (incluida la web): en verde.

**Entorno de las pruebas:** la integración se ejecutó contra PostgreSQL 17.6 y Redis 7.4 **desechables**, no contra las bases del proyecto.

### Pendiente (no bloqueante)

| Pendiente | Etapa |
|---|---|
| `platform_users` y MFA TOTP (obligatoria para el staff; step-up por empresa) con el cifrado de campo de ADR-019 | Fase 4 (superadmin), o una etapa 3.2c si se prefiere antes |
| Actualizar `last_login_at` y rehacer el hash en el login | Con ADR-034 (GRANT de columnas concretas de `users`) |
| Política de contraseñas (mínimo 10 y listas filtradas) al **fijar** una contraseña | Fase 4 (alta e invitación de usuarios) |
| Pruebas E2E de las pantallas en navegador (requieren HTTPS local para las cookies `__Host-`) | 3.4 o Fase 13 |
| Enrutado de Nginx por host (hub → web y API; dominios de empresa → web y API) | Fase 15 |
| B6 (estabilidad de `crypto.argon2`), B7 (cadena de tokens dentro de la gracia) | Sin cambios respecto a la clasificación aceptada |

### Pantallas de acceso con la identidad visual YEBO v1.0 (2026-11-10; pendiente de revisión)

Rediseño de las pantallas de la 3.2b con la identidad YEBO v1.0 (dirección base, no manual de marca) y las
referencias de Impeccable instaladas en el PR #3, leídas en modo solo lectura. Impeccable no está instalado en esta
rama, así que el lanzador no se ejecutó (`impeccable context` habría derivado a `init`, que no está autorizado).
No es el sistema de diseño de la Fase 4.

- **Flujo sin cambios.** No hay pantalla de consentimiento: el cambio de empresa sigue siendo de un clic
  (ADR-022, identity-and-sessions §4; decisión confirmada el 2026-11-10). La confirmación del acceso se da con el
  destino visible en el login, la transición «Entrando a …» y la pantalla «No tienes acceso a …». Ningún cambio
  en la API.
- **Tokens en dos capas.** `apps/web/app/styles/identity.css` contiene solo las cuatro primitivas de marca;
  `semantic.css` define los roles funcionales (superficies, texto, acción, foco, bordes, estados), que son los
  únicos que usan los componentes. Los tonos intermedios son mezclas de la propia paleta.
- **Contraste medido (WCAG).** Teal sobre Cloud White da 1,96:1, así que en superficies claras el teal solo
  rellena la acción principal, con texto navy (7,99:1). Enlaces y foco en navy; el subrayado teal es decorativo.
  Lime solo sobre navy (13,3:1). Texto secundario 5,7:1; bordes de control 3,75:1; error `#b42318`
  (6,05:1, color funcional fuera de la marca).
- **Tipografía.** Manrope 600/700 para títulos e identidad; Inter para el contenido funcional. Las dos se
  sirven con `next/font` desde el propio dominio. Escala contenida (título de 24/28 px; texto de 16 px).
- **Estructura.** Carril navy de identidad (lateral en escritorio y banda superior en móvil) y superficie clara
  de trabajo. Gesto propio: la línea de trayecto «Cuentas YEBO → empresa», que refleja el estado real
  (destino, entrando, sin acceso, sin sesión activa). Coincide con el isotipo: teal para las rutas y lime
  para el destino.
- **Componentes.** `components/identity` (`Logo`, `Slogan`, `RouteLine`, `AccessShell`), `components/ui` (`Button`,
  `ButtonLink`, `TextField`, `PasswordField`, `Notice`, `TextLink`, `Icon`) y `components/auth` (vistas de
  presentación sin lógica de red). Las páginas son contenedores que solo gestionan el estado.
- **Logotipo.** Se usa el material de `identidad/` (propuesta de trabajo v1.0, no arte final). El isotipo es una
  copia literal de `identidad/brand/yebo-isotipo.svg` en `apps/web/public/brand/`. El nombre se compone en HTML
  según `yebo-logo-oscuro.svg` (Manrope 800, interletrado −0,045 em) y el eslogan «Movemos conexiones.» va en
  Inter 600 teal, como en el logotipo. No se usa el SVG completo como imagen porque dentro de `<img>` no carga
  Manrope. No se modificó ni redibujó ningún archivo de marca.
- **Tokens de `identidad/tokens`.** Se copian sus primitivas (incluida Slate Blue, que como texto sobre navy
  da 1,40:1 y por eso solo se usa como superficie y pista) y los radios (8 px en los controles). La carpeta
  `identidad/` no se versiona: está en la exclusión local de git (`.git/info/exclude`).
- **Tema oscuro.** Sigue la preferencia del sistema; `data-theme="dark"` o `"light"` en `<html>` lo fuerza. Solo
  se reasignan roles en `semantic.css`: lienzo navy y campos slate (valores de `identidad/tokens`), con un filo
  slate que separa el carril. Texto cloud (15,7:1) y secundario (8,6:1 sobre navy, 6,2:1 sobre slate), bordes de
  campo de 4,9:1, foco lime (13,3:1) y error `#ff8b7e` (7,5:1; 6,0:1 sobre su fondo). La acción principal no
  cambia (teal con texto navy). La página de estado de la Fase 2 recupera su modo oscuro, que se había perdido.
- **Favicon.** El isotipo, con sus trazos sin modificar, va sobre un cuadrado Midnight Navy: `app/icon.svg`,
  `app/favicon.ico` (16, 32 y 48 px, cada uno renderizado a su tamaño real) y `app/apple-icon.png` (180 px, a
  sangre para el recorte de iOS). Validación a tamaño real: a 32 y 48 px se lee bien sobre fondos claros y
  oscuros. A 16 px, el hueco entre la ruta teal y la lime mide unos 0,9 px y las dos se funden en un solo trazo;
  la silueta y los dos colores se siguen reconociendo. Corregirlo exige una versión óptica para tamaños pequeños,
  que corresponde al diseño de la marca (identidad/README).
- **Estados.** Login: inicial, validación por campo, credenciales incorrectas, demasiados intentos, servicio
  ocupado, sin conexión y enviando. Empresas: cargando, lista, sin empresas, sin acceso a la empresa
  solicitada, error con reintento y sesión terminada. Entrada: entrando y acceso caducado o ya usado.
  Cierre: cerrando, cerrada y error con reintento. Panel: comprobando, sesión activa y sesión terminada.
- **Revisión visual.** Capturas con Chrome sin interfaz a 320, 390, 1024 y 1440 px. Se corrigieron dos
  defectos: la línea de trayecto se partía en «sin acceso» y los nombres largos de empresa se cortaban.

## Etapa 3.3 · Autorización y estado del tenant (implementada el 2026-11-10; pendiente de revisión)

Rama `fase-3/3.3-autorizacion`, creada desde el commit local de la 3.2 (`83df1c1`, sin push), por decisión del
responsable del 2026-11-10. Implementa el requisito de la 3.3 de [la sección anterior](#requisito-de-la-etapa-33-verificación-de-sesión-en-todas-las-rutas-protegidas).

### Alcance decidido por el responsable (2026-11-10)

| Tema | Decisión |
|---|---|
| `support_access_grants` | **Se pospone a la Fase 4**, con `platform_users`, el login del staff y su MFA. Sin `platform_users`, nadie podría usar el acceso de soporte. Hoy el guard solo acepta tokens de miembros de la empresa, así que ningún acceso de soporte es posible |
| Catálogo de permisos y plantillas | **Solo lo que existe:** permisos de gestión de accesos y la plantilla Administrador. Cada fase añade sus permisos y completa las plantillas (Cajero, Almacenero, Embarque, Contador...) con su propia migración |
| Endpoints | **Gestión mínima de accesos**, sin pantallas: listar miembros y roles, suspender y reactivar membresías, cerrar sus sesiones y asignar roles |

### Cadena de guards globales (denegar por defecto)

Se registran como `APP_GUARD` en `modules/access/access.module.ts`, en este orden. Toda ruta sin `@Public(...)` pasa
por los cuatro:

| Orden | Guard | Qué verifica | Rechazo |
|---|---|---|---|
| 1 | `TenantHostGuard` (tenancy) | Tenant por host verificado (ADR-004) | `404` |
| 2 | `AuthenticationGuard` (identity) | Access token (firma, `iss`, `aud`, ≤ 900 s); `tid` = host; sesión en PostgreSQL con `sub`, `mid` y tenant coincidentes; `ver` vigente; CSRF en mutaciones | `401` / `401 PERMISSIONS_CHANGED` / `403` (CSRF) |
| 3 | `PermissionGuard` (access) | `@RequirePermission(...)` contra los permisos efectivos de la membresía | `403 FORBIDDEN` |
| 4 | `TenantStatusGuard` (access) | `@TenantOperation(...)` contra la matriz de multitenancy §5.2 | `403 TENANT_RESTRICTED` |

- **Política de ruta obligatoria.** Una ruta es `@Public('tenant' | 'hub' | 'none')`, o declara `@RequirePermission(...)` o `@AuthenticatedOnly()`, más `@TenantOperation(...)`. Si falta algo o hay contradicciones (por ejemplo, un `@Public` de clase sobre un método con permiso), el guard responde `500` y el barrido de rutas falla.
- **Lista blanca:** `modules/access/public-routes.ts`. **Precisión del diseño aceptado:** además de health y `GET /public/site`, incluye las rutas del hub y del flujo de entrada de la 3.2b. Ninguna usa el access token de empresa: se autentican con la cookie del hub, la cookie firmada del flujo, el código de autorización o el refresh token, más CSRF.
- **ESLint (frontera 3):** `@Public()` solo en `health`, `tenancy` e `identity/http`; `APP_GUARD` solo en `access.module.ts`; `useGlobalGuards` prohibido en todo `apps/api/src`.
- **Permisos efectivos:** unión de los permisos de los roles no archivados de la membresía. Se leen con `yebo_app` y RLS (`PermissionService`), una vez por request y sin caché entre requests.
- **Matriz de estados:** valor por defecto en código (`tenant-operation.ts`) hasta que existan los planes y `plan_versions.suspension_policy` (Fase 4). `CANCELLED` se divide en el periodo de cierre (30 días desde `cancelled_at`) y lo posterior. Si falta `cancelled_at`, se trata como cerrado (falla cerrado). La fila «Login» se aplica en `GET /auth/start` y en `POST /auth/token`, antes de canjear el código.

### Gestión de accesos (`/api/v1/members`, `/api/v1/roles`)

| Ruta | Permiso | Categoría |
|---|---|---|
| `GET /members` | `members.read` | `READ` |
| `POST /members/:id/suspend` | `members.suspend` | `USERS_REDUCE` |
| `POST /members/:id/reactivate` | `members.reactivate` | `USERS_ADD` (aumenta el consumo facturable) |
| `POST /members/:id/sessions/revoke` | `members.sessions.revoke` | `USERS_REDUCE` |
| `PUT /members/:id/roles` | `roles.assign` | `CONFIGURE` |
| `GET /roles` | `roles.read` | `READ` |
| `GET /auth/session` | `@AuthenticatedOnly()` | `READ` (ahora devuelve también los permisos efectivos) |

Reglas de seguridad:
- **Aislamiento:** un id de otra empresa responde `404`, nunca `403` (§7.1), por RLS y por el filtro de aplicación.
- **Sobre uno mismo:** nadie puede suspenderse, reactivarse ni cambiar sus propios roles (`403`).
- **Anti-escalada:** quien asigna debe tener todos los permisos de los roles que asigna y de los que retira. No puede conceder lo que no tiene ni degradar a alguien con más permisos.
- **Asignar roles:** bloquea la membresía (`FOR UPDATE`), reemplaza sus roles e incrementa `permissions_version` en la misma transacción. Los tokens anteriores reciben `401 PERMISSIONS_CHANGED`.
- **Suspender:** pasa la membresía a `SUSPENDED` y después cierra sus sesiones en esta empresa. El cambio de estado corta el acceso por sí solo, porque cada request exige membresía `ACTIVE`.
- **Reactivar:** primero cierra cualquier sesión que hubiera quedado y después pasa a `ACTIVE`, así que no revive sesiones antiguas. Las transiciones no válidas responden `409`.
- **Datos de las personas:** correo y nombre se leen con `yebo_identity` (`UserDirectoryService`), solo para membresías del propio tenant. `yebo_app` sigue sin acceso a `users`.

### Migración `20261110120000_fase3_3_access` y su reversión

1. Siembra los 6 permisos `ACCESS` y la plantilla `ADMIN` («Administrador»), con `ON CONFLICT DO NOTHING`. La fuente es `permission-catalog.ts` y una prueba compara la base con el código.
2. `GRANT UPDATE (status, permissions_version, updated_at) ON tenant_memberships TO yebo_app`: un privilegio **por columna** y con RLS forzado (política `tenant_isolation`). Va en la línea de ADR-034 (permisos explícitos con RLS activo) y evita usar `yebo_platform`. `yebo_app` sigue sin poder insertar ni borrar membresías, ni cambiar `billable`, `user_id` ni `tenant_id` (probado).

Reversión manual, como `yebo_owner`, documentada en la cabecera de la migración: `REVOKE` del privilegio y, solo si ningún rol usa ya el catálogo, borrado de los permisos, de la plantilla y de la fila en `_prisma_migrations`. **No se aplicó a `yebo_dev` ni a ninguna base del proyecto**: las pruebas usaron contenedores desechables.

### Pruebas

| Suite | Contenido | Resultado |
|---|---|---|
| Unitarias `tenant-operation.spec.ts` | La matriz del código contra la de §5.2 **transcrita del documento**, celda a celda (11 categorías + login × 7 fases). Periodo de cierre y fallo cerrado | ✅ |
| Unitarias `route-policy.spec.ts` | Políticas completas, incompletas y contradictorias → `500` | ✅ |
| Integración `access.int-spec.ts` (30) | Detalle en las filas siguientes | ✅ |
| · Barrido de rutas | El inventario de Nest = las rutas de Express; las públicas son exactamente `PUBLIC_ROUTES`; sin token, toda ruta protegida da `401` | ✅ |
| · Cada ruta protegida | Sesión revocada, token de otra empresa (§7.2), versión anterior (`PERMISSIONS_CHANGED`), host desconocido (`404`); CSRF | ✅ |
| · Permisos y aislamiento | Permisos (`403`/`200`); §7.1 (ids de B → `404`); §7.3 (persona en A y B) | ✅ |
| · Gestión de accesos | Suspensión, reactivación, sesiones sobrantes, acciones sobre uno mismo, anti-escalada y versionado. Concurrencia: 10 rondas de 3 asignaciones simultáneas | ✅ |
| · Estados del tenant | `PAST_DUE`, `SUSPENDED`, `EXPIRED`, cierre y tras el cierre contra endpoints reales, incluido el login | ✅ |
| · Catálogo y privilegios | La migración siembra el catálogo del código; privilegio por columna de `yebo_app` y RLS | ✅ |
| Integración `boundaries.int-spec.ts` | Frontera 3 de ESLint: `@Public`, `APP_GUARD` y `useGlobalGuards` | ✅ |

**Pruebas de mutación** (cada protección desactivada a propósito; la suite debe fallar):
- **Detectadas:**
  - sin `AuthenticationGuard` global (22 fallos);
  - `PermissionGuard` que siempre permite;
  - `TenantStatusGuard` que siempre permite;
  - sin comparar `ver`;
  - sin CSRF;
  - sin anti-escalada;
  - sin incrementar la versión;
  - sin `FOR UPDATE`;
  - suspender sin cerrar sesiones;
  - reactivar sin cerrar las sesiones sobrantes.
- **Mutante equivalente:** quitar `!check.active`, porque una sesión inactiva no devuelve usuario ni tenant, así que las comparaciones siguientes también la rechazan.
- **Corregidas al revisar las mutaciones:** las tres últimas detectadas sobrevivían a la primera versión de la suite y se reforzaron las pruebas.

### Pendiente y riesgos residuales

| Tema | Situación |
|---|---|
| Estado del tenant en caché | El resolver cachea el tenant 60 s (Redis). Un cambio de estado tarda hasta 60 s en aplicarse, salvo que se invalide la entrada. La máquina de estados de la Fase 4 debe llamar a `TenantResolverService.invalidate` (existe desde la 3.1) |
| Auditoría de denegaciones | Multitenancy §5.4 pide auditar cada denegación por estado. Hoy queda en el log estructurado (`tenant_operation_denied`), hasta que exista la tabla de auditoría |
| Límites del trial y aviso de `PAST_DUE` | Con los planes (Fase 4) |
| `support_access_grants` y `platform_users` | Fase 4 (decisión del 2026-11-10) |
| Filas «Portal público» de la matriz | Se aplicarán con el seguimiento y las reservas públicas (fases de negocio) |
| `GET /hub/authorize` y la fila «Login» | El hub todavía emite el código para una empresa cerrada, pero el canje en la empresa lo rechaza. Basta para impedir el acceso; filtrar antes es una mejora menor |
| Permisos y versión en dos consultas | La versión se verifica con `yebo_identity` y los permisos se leen con `yebo_app`. Si los roles cambian entre las dos, la petición usa los permisos más nuevos: la carrera es benigna |
| Suspensión en dos pasos | Cambio de estado (`yebo_app`) y cierre de sesiones (`yebo_identity`) son transacciones distintas. Si el cierre falla, el acceso ya está cortado y la reactivación cierra las sesiones sobrantes (probado) |
| Tokens `Bearer` para dispositivos | Fase 14 (identity-and-sessions §9). Hoy solo se acepta la cookie |
| Gestión de roles (crear y editar) e invitaciones | Fases posteriores. Editar los permisos de un rol obligará a incrementar la versión de todas sus membresías |

## Etapa 3.4 · Cierre (implementada el 2026-11-10; pendiente de revisión)

Rama `fase-3/3.4-cierre`, creada desde el commit local de la 3.3 (`1c695b1`). **Resultados completos en [phase-3-results.md](phase-3-results.md).**

- **Aislamiento de extremo a extremo** (`isolation-e2e.int-spec.ts`) sobre endpoints autenticados reales:
  - 600 lecturas concurrentes y entrelazadas de dos empresas, hechas por la misma persona desde la misma sesión de identidad;
  - 100 peticiones con el token cruzado;
  - 40 escrituras concurrentes en ambas empresas;
  - §7.4 en el pool de la propia API tras la carga.
- **Mutaciones detectadas:** un `set_config` de sesión y un guard que reutiliza el tenant anterior.
- **Medición de §4.2** (`pnpm --filter @yebo/api bench`, fuera de CI): una transacción por operación cuesta unas 4 idas y vueltas (×3,2 frente a una lectura simple). Con varias lecturas por petición, agruparlas en una transacción reduce la latencia a la mitad y sube el rendimiento ×1,76. La recomendación queda pendiente de decisión ([resultados §3](phase-3-results.md#3-coste-de-una-transacción-por-operación-multitenancy-42)).
- **CI:** las siete pruebas de §7 forman parte de `pnpm test:integration`, que CI ya ejecuta en cada PR.
- **Arreglo menor:** las suites nuevas usan un único servidor HTTP escuchando, como `tenancy`, para evitar la fuga de escuchadores con carga.

## ADR-034 · implementación (2026-11-10)

Rama `fase-3/adr-034-privilegios`, desde el commit local de la 3.4 (`da999d8`). Decisión del responsable del
2026-11-10: aplicar ADR-034, adoptar la regla de §4.2 y migrar `yebo_dev`.

### Qué se aplicó

| Pieza | Contenido |
|---|---|
| Parte A · volúmenes nuevos y CI | `01-roles-and-databases.sh` crea los roles sin BYPASSRLS (salvo el de pruebas), NOINHERIT y sin pertenencias. El acceso a las bases queda por rol (`yebo_shadow`, solo el propietario; las PoC, solo `yebo_app`) y las bases de la aplicación no tienen privilegios por defecto. Si existe `TEST_PG_BYPASS_PASSWORD`, crea `yebo_test_bypass` con acceso solo a `yebo_test`, a las PoC y a `yebo_migrations` |
| Parte A · volúmenes existentes | `scripts/dev/harden-roles.sh [--test-role]`: lo mismo sobre un clúster en marcha. Es idempotente y deja una comprobación final de atributos y pertenencias |
| Parte B · migración `20261110130000_adr034_privilege_separation` | Quita los privilegios por defecto (incluido EXECUTE para PUBLIC en funciones futuras). Parte de cero en las tablas y concede la lista blanca, que ahora incluye lo de la 3.2b (`authorization_codes`) y lo de la 3.3 (UPDATE por columna de `yebo_app`). `_prisma_migrations` queda solo para `yebo_owner` |
| Configuración | `init-env.sh` genera `TEST_PG_BYPASS_PASSWORD` en `infrastructure/docker/.env` y `apps/api/.env.test`, que solo carga `test/support`. El compose pasa la contraseña al init. El esquema de entorno de la API rechaza cualquier rol de ejecución que contenga «bypass» |
| Pruebas | Las siembras pasan de `yebo_platform` a `yebo_test_bypass` (`testBypassPool`, `testBypassUrl`). `global-setup` concede al rol de pruebas sus permisos de tabla tras migrar, sin `_prisma_migrations` |

**Ajustes respecto al SQL propuesto:**
- La lista blanca incluye lo que añadieron la 3.2b y la 3.3, posteriores al borrador.
- En las bases de las PoC, que son solo de pruebas y cuyas migraciones no llevan GRANT, `yebo_app` conserva DML por defecto; `yebo_platform` y `yebo_identity` pierden el acceso a ellas.
- La regla de configuración rechaza «bypass» en lugar del nombre del rol, porque el nombre no puede aparecer en `apps/api/src`.

**Regla de §4.2 adoptada:** `MembersService.reactivate` hacía dos operaciones de tenant por separado y, si la membresía no estaba suspendida, cerraba sus sesiones antes de responder `409`. Ahora usa una sola transacción: bloquea, comprueba el estado, cierra las sesiones y reactiva. Una prueba nueva cubre el `409` sin cierre de sesiones.

### Verificación

| Prueba | Resultado |
|---|---|
| `privileges.int-spec.ts` (18) | Foto de privilegios igual a la matriz versionada, por tabla y por columna. También: sin privilegios por defecto, sin `SECURITY DEFINER` y sin pertenencias; atributos de los 5 roles; acceso a las bases; los tres servicios Prisma con su rol y sin BYPASSRLS. Negativas de `yebo_platform` (escrituras, otras tablas, `SET ROLE`) y del historial de migraciones; el rol de pruebas no entra en `yebo_dev`, y su nombre no aparece en `apps/api/src`, en las migraciones ni en `.env.example` |
| Mutaciones de privilegios | Se detectan cuatro: BYPASSRLS devuelto a `yebo_platform`, un INSERT sobrante, una pertenencia a `pg_read_all_data` y un privilegio por defecto |
| Volumen nuevo (init endurecido) | Integración 13 suites / 232 ✅ · unitarias 102 ✅ |
| Volumen heredado (init anterior + migraciones + `harden-roles.sh --test-role`, ejecutado dos veces) | Integración 232 ✅ |
| **Clúster de desarrollo** | Copia de `yebo_dev` y foto de privilegios previas. Después: `init-env.sh`, `harden-roles.sh --test-role` y `db:migrate:deploy`, que aplicó las 4 migraciones pendientes. Integración 232 ✅; `yebo_dev` con la matriz exacta; la API arranca contra `yebo_dev` y el health check responde `ok` para `yebo_app`, `yebo_platform` y Redis |

### ADR-034 · reversión

1. **Parte B**, como `yebo_owner` en cada base de la aplicación:
   - restaurar los `ALTER DEFAULT PRIVILEGES … GRANT` anteriores para `yebo_app` y `yebo_platform` (tablas: SELECT, INSERT, UPDATE y DELETE; secuencias: USAGE y SELECT; funciones: EXECUTE) y `GRANT EXECUTE ON FUNCTIONS TO PUBLIC`;
   - volver a conceder DML general a `yebo_app` y `yebo_platform`, y repetir los `REVOKE` de las migraciones 3.1, 3.2 y 3.2b;
   - `DELETE FROM _prisma_migrations WHERE migration_name = '20261110130000_adr034_privilege_separation'`.
2. **Parte A**, como superusuario:
   - `ALTER ROLE yebo_platform BYPASSRLS INHERIT` e `INHERIT` en los demás;
   - devolver `CONNECT` sobre `yebo_shadow` a los tres roles de ejecución, y sobre las PoC a `yebo_platform` y `yebo_identity`.
3. **Rol de pruebas:**
   - en cada base de prueba, `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM yebo_test_bypass; DROP OWNED BY yebo_test_bypass;`;
   - después, `DROP ROLE yebo_test_bypass`.

La copia de `yebo_dev` previa a la migración está en el directorio temporal de la sesión, fuera del repositorio. `yebo_dev` estaba vacía.

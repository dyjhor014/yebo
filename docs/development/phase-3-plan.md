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
| **3.2 · Autenticación y sesiones** | Argon2id calibrado; `platform_users`; hub de cuentas (`authorization code` + PKCE); `identity_sessions`, `tenant_sessions`, `refresh_tokens` (rotación con ventana de 20 s y detección de reutilización), `authorization_codes`; JWT EdDSA de 10 min; cookies `__Host-`; CSRF *double submit*; rate limit de login; revocación inmediata vía Redis; evaluación de `oidc-provider` (identity §4) | Flujos de identity-and-sessions §3–8; enumeración uniforme; reutilización de refresh → revocación de la familia |
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

# Fase 4 — Superadmin SaaS y membresías: plan de trabajo

- **Estado:** ✅ Plan **aprobado** por el responsable el 2026-11-10, con las decisiones F4-Q1 a F4-Q6 tal como se recomendaron. Etapa **4.1 implementada** (2026-11-10), pendiente de revisión.
- **Rama:** `fase-4/plan`, apilada sobre `fase-3/adr-034-privilegios` (`d21b591`). La Fase 3 sigue en revisión.
- **Criterio de aceptación (roadmap):** crear empresa, asignar plan, medir usuarios y calcular el importe.
- **Decisiones que se implementan:**
  - D5 (medición por pico diario de usuarios habilitados);
  - D8 y D9 (estados del tenant);
  - ADR-010 (versiones inmutables), ADR-016 (medición), ADR-019 (cifrado de campo) y ADR-023 (matriz de estados);
  - ADR-034 (privilegios explícitos, sin BYPASSRLS);
  - MKT-D6 (subdominios reservados);
  - [billing.md](../modules/billing.md) completo;
  - multitenancy §5–6;
  - lo pospuesto por la Fase 3: `platform_users`, MFA del staff y `support_access_grants`.

  **No se cambia ninguna decisión aprobada.** No se fija ningún precio: los planes y sus importes los crea el superadmin; las pruebas usan importes de ejemplo.

## Etapas

Cada etapa termina con sus pruebas y se presenta para revisión antes de empezar la siguiente.

| Etapa | Contenido | Pruebas de aceptación |
|---|---|---|
| **4.1 · Staff de YEBO** | `platform_users` (correo, Argon2id, estado, rol de plataforma); `platform_sessions`; MFA TOTP **obligatorio** con el secreto cifrado (ADR-019, AES-256-GCM con `key_version`); login del staff en el host de administración, separado del hub de clientes y con audiencia propia de JWT (`yebo-platform-api`). Permisos de plataforma (`platform.tenants.manage`, `platform.plans.manage`, `platform.billing.manage`...) y cadena de guards global equivalente a la de la 3.3. `audit_logs` de plataforma | Un token de empresa no vale en la API de plataforma y al revés; sin MFA no hay sesión; enumeración uniforme; revocación inmediata; barrido de rutas de plataforma |
| **4.2 · Catálogo comercial** | `modules`; `plans`, `plan_versions` (inmutables al publicarse, por trigger) y `plan_version_modules`; `tenant_module_overrides`; **módulos efectivos** (plan ∩ servicios de la empresa + excepciones vigentes) y guard `@RequiresModule` (multitenancy §6) | Una versión publicada no se puede modificar; los módulos efectivos son correctos con y sin excepciones; una ruta de un módulo no contratado responde `403` |
| **4.3 · Alta de empresas y membresías** | Alta de tenant (slug y dominios normalizados, **subdominios reservados** MKT-D6, dominio por defecto verificado); `tenant_settings`, `tenant_services`; roles de sistema desde las plantillas; suscripción en `TRIALING`. **Invitaciones** (`membership_invitations`: token de un solo uso con hash y caducidad; aceptación autenticada en el hub, sin revelar si el correo existía). **Máquina de estados del tenant** con `tenant_status_history` (append-only), invalidación de la caché del resolvedor y job de transiciones (`PAST_DUE` → `SUSPENDED` a los 7 días; cierre de 30 días). `USERS_ADD` con excepción temporal de YEBO | Crear una empresa deja un dominio resoluble y un primer administrador invitado; un subdominio reservado se rechaza; invitación caducada o reutilizada rechazada; cada transición queda en el historial y se refleja en la matriz sin esperar a la caché |
| **4.4 · Medición de usuarios** | `membership_status_history` con `EXCLUDE USING gist` y trigger (sin fechas retroactivas, sin `DELETE`, solo se cierra la fila vigente), escrito **en la misma transacción** que cada cambio de membresía o de usuario. `usage_daily_snapshots` (job horario idempotente, `PROVISIONAL` y `FINAL`, `algorithm_version`, detalle auditable) | Las de billing §8: ejemplo de §3.1 = 3 y 4; reemplazo en el mismo instante sin doble conteo; días de 23 y 25 horas; job caído 3 días = mismo resultado; historial inmodificable; staff y cuentas de servicio nunca cuentan |
| **4.5 · Períodos, importe y cobro** | `billing_periods` (zona horaria fija por período), cierre `OPEN → CLOSING → CLOSED` sin días faltantes; `usage_period_calculations` con la copia del plan; `platform_invoices`, líneas y `subscription_payments` (registro manual, sin pagos simulados); triggers de inmutabilidad. Vista del tenant «Obligaciones con YEBO» (`BILLING_SELF`) | La fórmula de billing §5 con las tres métricas; período cerrado inmodificable; revocar usuarios tras el cierre no altera la factura; un pago registrado actualiza el saldo y el estado |
| **4.6 · Acceso de soporte** | `support_access_grants`: temporal, con motivo, visible para el tenant, con aprobación opcional de la empresa y revocable. El guard de empresa acepta la sesión del staff **solo** con un grant vigente para ese tenant, con ámbito `READ_ONLY` o `FULL`, y todo queda auditado | Sin grant → `401`; grant vencido o revocado → `401`; `READ_ONLY` no escribe; el tenant ve quién accedió y cuándo |
| **4.7 · Panel de superadmin** (`apps/platform`) | Pantallas mínimas: login del staff con MFA, empresas (alta, estado, dominios, invitación del primer administrador), planes y versiones, suscripción, consumo diario, períodos, facturas y pagos. Identidad YEBO v1.0 con los mismos componentes y tokens de la 3.2b | Recorrido completo en el navegador; accesibilidad AA; revisión visual con Impeccable |
| **4.8 · Cierre** | Prueba de extremo a extremo del criterio: crear empresa → asignar plan → medir usuarios durante varios días → cerrar el período → importe correcto. Resultados en `phase-4-results.md` | Criterio del roadmap en CI |

## Privilegios de base de datos (ADR-034)

`yebo_platform` sigue como está: solo SELECT sobre `tenants` y `tenant_domains`, para el resolvedor y el health
check. Las escrituras del superadmin necesitan permisos nuevos. ADR-034 dejó para la Fase 4 los roles por
función. Propuesta (decisión **F4-Q2**):

| Rol | Uso | Permisos |
|---|---|---|
| `yebo_backoffice` (nuevo) | API de plataforma (superadmin) | DML explícito sobre las tablas de plataforma (`platform_users`, planes, suscripciones, períodos, facturas, pagos, `tenant_status_history`, `tenants`, `tenant_domains`). Para los datos de tenant que necesite (crear roles e invitar al primer administrador), contexto de tenant fijado y RLS activo, como `yebo_app`. Sin BYPASSRLS |
| `yebo_metering` (nuevo) | Jobs de medición y cierre (worker) | SELECT de `membership_status_history` entre tenants mediante una política `FOR SELECT TO yebo_metering`; escritura de snapshots y cálculos. Sin BYPASSRLS |

Cada rol nuevo se crea en el init y en `harden-roles.sh`, entra en la foto de privilegios y en el esquema de
entorno, y tiene su propia frontera de ESLint.

## Decisiones (todas aprobadas el 2026-11-10 según la recomendación)

| Id | Pregunta | Decisión |
|---|---|---|
| **F4-Q1** | Precio de las suscripciones: ¿modelo aprobado (`plan_versions` + `subscriptions.price_override`) o acuerdos comerciales versionados (ADR-031, **propuesto** en el PR #5, sin aprobar)? | Modelo aprobado ahora, con los precios en un punto único («de dónde sale el precio») para que ADR-031 pueda sustituirlo sin migrar datos. Si apruebas ADR-031 antes de la 4.5, se implementa directamente |
| **F4-Q2** | Roles de BD del superadmin y de la medición | Dos roles por función (`yebo_backoffice`, `yebo_metering`), sin BYPASSRLS (tabla anterior) |
| **F4-Q3** | Entrega de invitaciones sin Mailgun (llega en la Fase 12) | El enlace de invitación (un solo uso, caducidad corta) se muestra una vez a quien invita para que lo envíe por su canal. Con Mailgun, se enviará por correo |
| **F4-Q4** | Host del panel de administración (`admin.yebo.pe` «por definir» en system-overview) | `admin.<dominio>` configurable (`PLATFORM_ADMIN_HOST`), en la lista de subdominios reservados |
| **F4-Q5** | Alcance del soporte: ¿solo `support_access_grants` o también incidencias (`support_incidents`)? | Solo los grants. Las incidencias no son necesarias para el criterio y se planifican aparte |
| **F4-Q6** | Prospectos (ADR-028, PR #2) y fundamentos de diseño MKT-01.1, que el PR #2 sitúa «al inicio de la Fase 4» | Fuera de la Fase 4 hasta que se integre el PR #2. Las pantallas de la 4.7 reutilizan los componentes de la 3.2b sin crear el sistema de diseño completo |

## Fuera del alcance de la Fase 4

- Acuerdos comerciales y comisiones (ADR-031 y ADR-032, propuestos en el PR #5), salvo que se aprueben: ver F4-Q1.
- Incidencias de soporte (F4-Q5), prospectos y sitio comercial (MKT-01).
- Envío de correo (Fase 12), pasarela de pago (D9) y comprobantes fiscales de YEBO (puerto de facturación, Fase 11).
- White label por tenant (Fase 5).

## Etapa 4.1 · Staff de YEBO (implementada el 2026-11-10; pendiente de revisión)

### Decisiones de implementación

| Tema | Decisión | Motivo |
|---|---|---|
| Sesión del staff | **Token opaco** de 256 bits en la cookie `__Host-yebo_admin` (`Secure`, `HttpOnly`, `SameSite=Strict`), con su SHA-256 en `platform_sessions`. Sin JWT | La sesión se verifica en PostgreSQL en cada petición (como en las empresas desde la 3.2a), así que un JWT no ahorra nada y añadiría claves y rotación. La separación de realms la dan la cookie, la tabla y el host |
| Caducidad | 30 min de inactividad y 12 h en total (`PLATFORM_SESSION_*`); la inactividad se renueva como mucho una vez por minuto | El staff accede a datos de todas las empresas: sesiones más cortas que las de clientes |
| MFA | TOTP propio (RFC 6238: HMAC-SHA1, 6 dígitos, 30 s, ±1 paso). Obligatorio: sin MFA activada no hay sesión. El paso usado se consume de forma atómica en la base, así que un código no se reutiliza ni siquiera en peticiones simultáneas. El secreto se cifra con AES-256-GCM (`FIELD_ENCRYPTION_KEY`, `key_version`) y un AAD que lo liga a su fila (ADR-019) | Sin dependencias; probado con los vectores oficiales del RFC |
| Login en dos pasos | Contraseña (respuesta y coste uniformes; límites de 30 intentos por IP y de 5 fallos por cuenta cada 15 min) → cookie firmada de 5 min → alta de MFA o código (5 fallos cada 15 min) → sesión | El primer factor nunca abre sesión |
| Altas del staff | El primer superadmin, con `pnpm --filter @yebo/api platform:bootstrap`, que solo funciona con la tabla vacía. Los demás, desde el panel, con un enlace de configuración de un solo uso (24 h; el token va en el fragmento `#`, que no llega al servidor ni al Referer) que se entrega a quien hace el alta (F4-Q3) | Sin contraseñas iniciales ni secretos compartidos |
| Roles de plataforma | Enum `SUPERADMIN`, `BILLING`, `SUPPORT` y `VIEWER`; sus permisos (`platform.*`) se definen en código | Los permisos de plataforma nunca se mezclan con los de empresa |
| Protecciones | Nadie se desactiva a sí mismo; nunca queda el sistema sin un superadmin activo (bloqueo consultivo: dos desactivaciones cruzadas simultáneas → solo gana una); desactivar cierra sus sesiones en la misma transacción | — |
| Auditoría | `platform_audit_logs`, append-only para el rol de ejecución (solo INSERT y SELECT), escrita en la misma transacción que la acción | — |
| Rutas | Nuevo tipo de ruta `platform` (`@PlatformProtected` / `@PlatformAuthenticated`) y ámbito público `admin`. `PlatformGuard` encabeza la cadena global: exige el host `PLATFORM_ADMIN_HOST` (si no, 404), la sesión del staff, el permiso y el CSRF. Los guards de empresa ignoran estas rutas, y la sesión del staff no sirve en las rutas de empresa | — |

### Base de datos

- **Migración `20261110150000_fase4_1_platform_staff`:** crea `platform_users`, `platform_sessions`, `platform_setup_tokens` y `platform_audit_logs`, con CHECK de correo normalizado, coherencia de la MFA, longitud de los hashes, orden de caducidades y vida máxima de los enlaces. Los permisos son solo para `yebo_backoffice`. La reversión está en su cabecera.
- **Rol `yebo_backoffice`:** sin BYPASSRLS ni herencia. Lo crea el init en los volúmenes nuevos y `harden-roles.sh` en los existentes. Su contraseña (`PG_BACKOFFICE_PASSWORD`) y `FIELD_ENCRYPTION_KEY` las genera `init-env.sh`, y la API no arranca sin ellas.
- **Excepción global:** `platform_audit_logs` es una tabla de plataforma con un `tenant_id` que indica la empresa afectada; se declara como excepción global y entra en la prueba de cobertura de RLS.
- **Frontera 4 de ESLint:** `BackofficePrismaService` solo se puede importar dentro de `platform-admin`.

### Pruebas

| Suite | Contenido | Resultado |
|---|---|---|
| Unitarias: `totp.spec` (12) y `field-encryption.spec` (4) | Vectores oficiales de RFC 6238, base32 y reutilización del código. Cifrado de ida y vuelta, AAD de otra fila, alteración de un byte, otra clave u otra versión | ✅ |
| `platform-auth.int-spec` (14) | Bootstrap único; dos pasos; secreto cifrado; código reutilizado; carrera de verificación; pendiente caducado; respuesta uniforme y 429; inactividad y cierre; realms separados (host, cookie de staff en empresa, token de empresa en el panel); alta con enlace único y contraseña mínima; permisos por rol; 409 y CSRF; desactivación con cierre de sesiones; último superadmin con concurrencia; auditoría | ✅ |
| `privileges.int-spec` y `boundaries.int-spec` | `yebo_backoffice` en la matriz versionada, sus atributos y su acceso a las bases. Frontera 4 y `@Public` en `platform-admin/http`. Arranque sin `PG_BACKOFFICE_PASSWORD` ni `FIELD_ENCRYPTION_KEY` | ✅ |
| Integración completa | 14 suites y 254 pruebas en un volumen nuevo, y otra vez en uno heredado (init de ADR-034 + `harden-roles.sh`, que crea el rol) | ✅ |

**Mutaciones detectadas (13):**
- en el guard: sin host, sin permiso, sin CSRF;
- en el login: el pendiente sin caducidad, la respuesta no uniforme;
- en la sesión: sin caducidad por inactividad;
- en el MFA: sin consumo atómico del paso;
- en el staff: desactivar sin cerrar sesiones, sin la regla del último superadmin, sin el bloqueo de desactivaciones;
- en el enlace: reutilizable.

Dos de ellas sobrevivían a la primera versión de la suite (sin consumo atómico y desactivar sin cerrar sesiones), igual que la de la respuesta uniforme, cuya prueba comparaba dos cuentas inexistentes. Se reforzaron las pruebas y ahora las tres se detectan.

«TOTP reutilizable» queda cubierta por la prueba unitaria; en integración la base de datos también lo bloquea (defensa en profundidad).

### Pendiente

- **Clúster de desarrollo:** ✅ aplicado el 2026-11-10 con autorización del responsable, tras una copia de `yebo_dev`: `init-env.sh`, `harden-roles.sh --test-role` y la migración. La integración (254) pasa contra el clúster y la API arranca contra `yebo_dev`.
- **Rotación de `FIELD_ENCRYPTION_KEY`:** hoy solo existe la clave vigente; las anteriores se añadirán cuando haga falta rotar.
- **Restablecer la MFA de un miembro del staff:** el enlace de configuración solo restablece la contraseña.
- **Pantallas del panel:** etapa 4.7.

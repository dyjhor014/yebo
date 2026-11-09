# Fase 4 — Superadmin SaaS y membresías: plan de trabajo

- **Estado:** ✅ Plan **aprobado** por el responsable el 2026-11-10, con las decisiones F4-Q1 a F4-Q6 tal como se recomendaron. Etapa **4.1 implementada**, pendiente de revisión; etapa **4.2 aprobada** (2026-11-10); etapa **4.3a aprobada** (2026-11-10). Etapa **4.3b aprobada** (2026-11-10). Etapa **4.4 aprobada** (2026-11-10). Etapa **4.5 aprobada** (2026-11-10).
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
| **4.7 · Panel de superadmin** (`apps/platform`) | Pantallas mínimas: login del staff con MFA, empresas (alta, estado, dominios, invitación del primer administrador), **«Invitar usuario» con el destino a elegir: staff de YEBO o una empresa (con sus roles)**, planes y versiones, suscripción, consumo diario, períodos, facturas y pagos. Identidad YEBO v1.0 con los mismos componentes y tokens de la 3.2b | Recorrido completo en el navegador; accesibilidad AA; revisión visual con Impeccable |
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

## Etapa 4.2 · Catálogo comercial (implementada y aprobada el 2026-11-10)

### Decisiones de implementación

| Tema | Decisión | Motivo |
|---|---|---|
| Catálogo de módulos | Fuente única en código (`access/module-catalog.ts`). La migración siembra exactamente esos nueve módulos y una prueba compara la base con el archivo. Un módulo nuevo exige una migración nueva; el panel solo los lee | Los códigos de módulo se usan en `@RequiresModule` con tipo: no pueden aparecer ni desaparecer desde el panel |
| Planes y versiones | `DRAFT → PUBLISHED → RETIRED`. Un borrador se edita completo (campos y módulos). Publicar exige al menos un módulo y pasa el plan a `ACTIVE`. Retirar deja de ofrecer la versión; las suscripciones existentes la conservan. El número de versión es el último + 1, con el plan bloqueado (`FOR UPDATE`) | ADR-010 |
| Inmutabilidad | La API rechaza con `409` modificar lo que no es borrador. Además, dos triggers en la base (`SECURITY INVOKER`): en una versión publicada solo se admite `PUBLISHED → RETIRED` sin tocar ningún otro campo; sus módulos no se insertan, modifican ni borran; una versión publicada no se borra | Defensa en profundidad: la regla se cumple aunque alguien escriba sin pasar por la API |
| Importes | `numeric(14,2)`, con dos decimales como máximo en la entrada (`"99.00"` como texto en el contrato, nunca `float`). Ningún precio lo fija el sistema | — |
| `limits` y `suspension_policy` | `jsonb` validado con un esquema estricto en `@yebo/contracts` (sucursales, vehículos y GB, con `null` = sin límite; 7 días de gracia y 30 de cierre por defecto) y `CHECK` de objeto en la base | Data-dictionary |
| Suscripción vigente | `is_current` (TRUE o NULL, con `CHECK`) y `UNIQUE (tenant_id, is_current)`, en vez del índice único parcial por estado del diccionario | Prisma no representa índices parciales y la prueba de deriva (ADR-024) los rechazaría. Una sola fila vigente por tenant, con la misma garantía. La tabla se crea ya con RLS, pero las suscripciones las crea el alta de empresas (4.3) |
| Excepciones de módulo | `GRANT` o `REVOKE`, con inicio (por defecto, ahora), fin opcional y motivo obligatorio. No se borran: se **terminan** (`ended_at`, `ended_by_platform_user_id`) y quedan en el historial. Las escribe `yebo_backoffice` con el contexto del tenant fijado (`BackofficePrismaService.withTenant`), así que el RLS forzado sigue activo | ADR-025 y ADR-034: sin BYPASSRLS |
| Módulos efectivos | `(módulos del plan vigente ∪ GRANT vigentes) − REVOKE vigentes`, solo con módulos activos. Una consulta con `yebo_app` en el contexto del tenant, una vez por petición (caché en el contexto de la petición). `GET /auth/session` devuelve la lista para que la interfaz oculte lo no habilitado | Multitenancy §6. **La intersección con `tenant_services` llega con la 4.3**, que crea esa tabla |
| `@RequiresModule` | Guard global después del de permisos y antes del de estado del tenant. Una ruta de un módulo no habilitado responde `403 MODULE_NOT_ENABLED`. Solo se admite en rutas de empresa protegidas (si no, error de programación) | La autoridad es el backend |
| Reloj | `Clock` pasa a un `ClockModule` propio, importado por la API, para que `access` y `platform-admin` lo usen sin depender de `identity` | Pruebas con el reloj controlado |
| Rutas del panel | `GET modules`, `GET plans` (`platform.billing.read`); `POST plans`, `POST plans/:id/versions`, `PUT plan-versions/:id`, `POST plan-versions/:id/publish` y `/retire` (`platform.plans.manage`: SUPERADMIN y BILLING); `GET`, `POST tenants/:id/module-overrides` y `POST …/:overrideId/end` (`platform.tenants.read` / `.manage`). Todo cambio queda en `platform_audit_logs` en la misma transacción | — |

### Base de datos

- **Migración `20261110170000_fase4_2_commercial_catalog`:** crea `modules`, `plans`, `plan_versions` y `plan_version_modules` (globales 🌐), y `tenant_module_overrides` y `subscriptions` (de tenant, con RLS forzado). Incluye los `CHECK` de formato de códigos, moneda, importes no negativos, coherencia estado-fechas, ventana de las excepciones y suscripción vigente; los dos triggers de inmutabilidad; y la siembra de los nueve módulos. La reversión está en su cabecera.
- **Privilegios (lista blanca, ADR-034):**
  - `yebo_backoffice`: SELECT en `modules`, `tenants` y `subscriptions`; SELECT, INSERT y UPDATE en `plans`, `plan_versions` y `tenant_module_overrides`; SELECT, INSERT y DELETE en `plan_version_modules` (el trigger solo deja borrar los de un borrador). Sin DELETE en versiones ni excepciones.
  - `yebo_app`: SELECT en `modules`, `plan_version_modules`, `subscriptions` y `tenant_module_overrides`, solo para calcular los módulos efectivos de su tenant (RLS).
- **Tablas de tenant:** `TENANT_SCOPED_TABLES` reúne ahora la lista que antes se repetía en cuatro pruebas (cobertura de RLS, rutas de migración, aislamiento y privilegios).

### Pruebas

| Suite | Contenido | Resultado |
|---|---|---|
| `platform-catalog.int-spec` (13) | Siembra igual a `module-catalog.ts`; permisos por rol; ciclo borrador → publicada → retirada; numeración y publicación sin módulos; validación (3 decimales, moneda, módulo inexistente); el trigger rechaza modificar una publicada y sus módulos aunque se escriba directamente en la base; retirar una sola vez; auditoría. Módulos efectivos: sin excepciones; GRANT vigente que vence a su fin; REVOKE futuro que aún no quita y quita al llegar su inicio; REVOKE gana sobre GRANT; excepción terminada; aislamiento de las excepciones y suscripciones entre tenants (API y `yebo_app` con RLS); ruta de un módulo no contratado → `403` y, con el GRANT, → `200` | ✅ |
| `privileges.int-spec`, `tenancy.int-spec`, `migration-paths.int-spec` | Los permisos nuevos en la matriz versionada; las dos tablas de tenant en la cobertura de RLS y en las rutas de migración | ✅ |
| Integración completa | 15 suites y 267 pruebas | ✅ |
| Unitarias, lint, typecheck y build | 117 unitarias | ✅ |

**Mutaciones detectadas (11):**
- en el guard: no comprobar el módulo;
- en los módulos efectivos: REVOKE no resta; sin inicio de vigencia; sin fin de vigencia; las excepciones terminadas siguen contando;
- en los planes: editar una publicada; publicar sin módulos; retirar dos veces; sin auditoría al publicar;
- en las excepciones: fin anterior al inicio; terminar dos veces.

«Sin fin de vigencia» sobrevivía a la primera versión de la suite: ninguna prueba usaba un GRANT con fin. Se añadió y ahora se detecta.

### Pendiente

- **Clúster de desarrollo:** ✅ migración aplicada a `yebo_dev` el 2026-11-10 con autorización del responsable, tras una copia de la base (`pg_dump`, fuera del repositorio). Nueve módulos sembrados, RLS forzado en las dos tablas de tenant; la API arranca y responde `live` y `ready` contra `yebo_dev`.
- **`tenant_services`** y su intersección con los módulos del plan: etapa 4.3.
- **Límites del plan** (sucursales, vehículos, almacenamiento): se guardan y validan como datos; su aplicación al crear recursos llega con cada módulo que los cree.
- **`config` de `plan_version_modules`:** la columna existe, pero la API aún no la expone.

## Etapa 4.3a · Alta de empresas y máquina de estados (implementada y aprobada el 2026-11-10)

La 4.3 se divide en dos partes, cada una con sus pruebas: **4.3a** (alta de empresas, servicios, estados y la excepción de `USERS_ADD`) y **4.3b** (invitaciones y aceptación en el hub, con la invitación del primer administrador).

### Decisiones del responsable (2026-11-10)

| Pregunta | Decisión |
|---|---|
| ¿Dónde se guarda la excepción temporal de `USERS_ADD` (multitenancy §5.2, nota 2), que no encaja en `tenant_module_overrides`? | Tabla propia `tenant_operation_overrides` (categoría, inicio, fin obligatorio, motivo, quién la otorga y quién la termina), con RLS de tenant |
| ¿Cómo se ejecuta el job de transiciones? | Job repetible de BullMQ en el worker cada 15 minutos (ADR-008), idempotente |
| ¿De dónde sale el dominio del subdominio por defecto? | Variable nueva `TENANT_BASE_DOMAIN`; el hub y el panel deben ser subdominios suyos y sus etiquetas quedan reservadas |

### Decisiones de implementación

| Tema | Decisión | Motivo |
|---|---|---|
| Alta | `POST /platform/tenants` (`platform.tenants.manage`). **Una** transacción con `yebo_backoffice`: tenant, subdominio `<slug>.<TENANT_BASE_DOMAIN>` (`SUBDOMAIN`, principal y `VERIFIED`), y con el contexto del tenant fijado: `tenant_settings`, `tenant_services`, roles de sistema desde **todas** las plantillas de la base, suscripción vigente, primera fila del historial y auditoría. Después del commit se invalida la caché del resolvedor (también la negativa) | Nada queda a medias, y el dominio resuelve en la petición siguiente |
| Slug | Normalizado (minúsculas, sin espacios), 3–40 caracteres, `^[a-z0-9]+(-[a-z0-9]+)*$` (sin guiones al borde ni dobles, así que tampoco `xn--`). Slug o documento repetidos → `409`, también en una carrera (restricción única) | — |
| Subdominios reservados | Los 13 de MKT-D6 más 28 nombres internos (`yebo`, `empresas`, `auth`, `login`, `soporte`, `cdn`, `smtp`, `ns1`, `staging`, `sandbox`…), en `tenancy/reserved-subdomains.ts`, y siempre las etiquetas de `AUTH_HUB_HOST` y `PLATFORM_ADMIN_HOST`. Reservado → `400` | MKT-D6 |
| Plan y trial | Solo una versión **publicada** (`FOR SHARE`: una retirada simultánea espera). Con `trial_days > 0`: tenant `TRIAL` con `trial_ends_at` y suscripción `TRIALING`; con 0: `ACTIVE` desde el alta | — |
| Período | Empieza el día local de la empresa en su zona horaria (IANA validada) y dura el intervalo del plan; PostgreSQL ajusta el fin de mes (31 ene + 1 mes = 28 feb) | billing §2.2 |
| `tenant_settings` | Valores iniciales: PIN de entrega desactivado, 5 intentos, 15 min de reserva, sin pagos parciales, documento del destinatario exigido, entrega excepcional desactivada, iniciales en el seguimiento público. Los cambia la empresa en fases posteriores | Valores conservadores; no son decisiones comerciales |
| Módulos efectivos | `((plan ∩ servicios) ∪ GRANT) − REVOKE`. Un módulo de **servicio** del plan (`PASSENGERS`, `PARCELS`, `CARGO`, `VEHICLE_TRANSPORT`) solo cuenta si la empresa opera ese servicio en alguna modalidad; los demás (`EINVOICING`, `AGENCIES`…) no dependen de los servicios. Una GRANT no exige el servicio | multitenancy §6 |
| Transiciones manuales | `POST /platform/tenants/:id/status` con motivo. TRIAL → ACTIVE, EXPIRED o CANCELLED; ACTIVE → PAST_DUE o CANCELLED; PAST_DUE → ACTIVE, SUSPENDED o CANCELLED; SUSPENDED y EXPIRED → ACTIVE o CANCELLED. CANCELLED es final. Otra → `409`. Fuente única: `platform-admin/tenant-lifecycle.ts` | multitenancy §5.2 |
| Cada transición | Con el tenant bloqueado (`FOR UPDATE`) y en una transacción: estado y `status_changed_at`, `activated_at` o `cancelled_at`, estado de la suscripción vigente (TRIAL → `TRIALING`…), fila del historial y auditoría. Después, invalidación de la caché de todos sus dominios: la matriz aplica el estado nuevo en la petición siguiente | «Se refleja en la matriz sin esperar a la caché» |
| Job de estados | `TRIAL → EXPIRED` al llegar `trial_ends_at`; `PAST_DUE → SUSPENDED` tras los días de gracia de la versión de plan vigente (7 por defecto), contados desde `status_changed_at`. Repetible cada 15 min (`upsertJobScheduler`, uno solo entre réplicas). Cada transición vuelve a comprobarse con el tenant bloqueado (mismo estado y mismo `status_changed_at`), así que dos ejecuciones simultáneas o una evaluación obsoleta no hacen nada. Actor nulo en el historial | El job puede ejecutarse tarde, dos veces o en paralelo |
| Excepción de `USERS_ADD` | Temporal (fin obligatorio, como mucho 30 días, `CHECK`), con motivo, terminable y auditada. El guard de estado solo la consulta **cuando la matriz ya ha denegado**, y solo en `SUSPENDED` y `EXPIRED`; nunca en `CANCELLED` ni para otras categorías | multitenancy §5.2, nota 2 |
| `status_changed_at` | Columna nueva en `tenants`: inicio del estado vigente | El job no necesita leer el historial, que es de tenant (RLS) |
| Worker | `TenantLifecycleWorkerModule` sin controladores (el worker solo expone su health). Usa `yebo_backoffice` como el panel; el worker necesita `PG_BACKOFFICE_PASSWORD` | — |

### Base de datos

- **Migración `20261110190000_fase4_3a_tenant_onboarding`:**
  - crea `tenant_settings` (1:1), `tenant_services`, `tenant_status_history` y `tenant_operation_overrides`, todas con RLS forzado;
  - añade `tenants.status_changed_at`;
  - incluye los `CHECK` de rangos, motivo, ventana de 30 días y coherencia del fin;
  - añade un trigger que hace el historial append-only también para el propietario (salvo `TRUNCATE` de mantenimiento);
  - la reversión está en su cabecera.
- **Privilegios (lista blanca, ADR-034):**
  - `yebo_backoffice`:
    - INSERT en `tenants` y UPDATE solo de las columnas de estado;
    - SELECT e INSERT en `tenant_domains`, `tenant_settings`, `tenant_services` y `tenant_status_history`;
    - SELECT, INSERT y UPDATE en `tenant_operation_overrides`;
    - INSERT en `subscriptions` y UPDATE de su estado;
    - SELECT en `role_templates` y `permissions`, SELECT e INSERT en `roles` e INSERT en `role_permissions`.
  - `yebo_app`: SELECT, con RLS, en las cuatro tablas nuevas.
- ✅ **Aplicada a `yebo_dev`** el 2026-11-10 con autorización del responsable, tras una copia de la base (`pg_dump`). La API y el worker arrancan y responden `ready` contra `yebo_dev`.

### Pruebas

| Suite | Contenido | Resultado |
|---|---|---|
| Unitarias: `reserved-subdomains.spec` (5) y `tenant-lifecycle.spec` (6) | Lista MKT-D6, mayúsculas y espacios, etiquetas de los hosts configurados, formato del slug, zona horaria IANA. CANCELLED final, reactivaciones, estado de la suscripción, vencimiento exacto del trial, gracia por defecto y del plan, estados que nunca cambian solos | ✅ |
| `platform-tenants.int-spec` (18) | **Alta:** dominio resoluble aunque estuviera en la caché negativa; configuración, servicios, rol de sistema con todos sus permisos, suscripción, historial y auditoría; período en la zona de la empresa con ajuste de fin de mes; plan sin trial → ACTIVE; reservados → 400; slug y documento repetidos, versión no publicada → 409; carrera de dos altas; permisos del VIEWER. **Módulos efectivos ∩ servicios.** **Estados:** cada transición aplicada en la petición siguiente; excepción de USERS_ADD vigente, terminada o vencida; la excepción no vale para CONFIGURE ni en CANCELLED; ventana de 30 días; transiciones no permitidas; historial completo y append-only. **Job:** gracia del plan exacta, vencimiento del trial, ejecuciones simultáneas, evaluación obsoleta, planificador único en el worker | ✅ |
| `privileges`, `tenancy`, `migration-paths`, `platform-catalog` | Matriz versionada con los permisos nuevos; las cuatro tablas en la cobertura de RLS; la empresa de la 4.2 con sus servicios | ✅ |
| Integración completa | 16 suites y 285 pruebas | ✅ |
| Unitarias, lint, typecheck, formato y build | 128 unitarias | ✅ |

**Mutaciones (17):**
- **Detectadas por la integración (15):**
  - en el alta: sin reservados, sin invalidar la caché, versión no publicada aceptada, período en UTC, sin roles de sistema;
  - en las transiciones: sin tabla de transiciones, sin invalidar la caché, la suscripción no acompaña, sin historial;
  - en el job: sin volver a comprobar el estado;
  - en las excepciones: válida en cualquier fase, terminada o vencida que siguen contando, sin el límite de 30 días;
  - en los módulos: sin la intersección con los servicios.
- **Detectada por la unitaria (1):** sin las etiquetas de los hosts de la plataforma. `cuentas` y `admin` también están en la lista fija, así que la integración no puede distinguirla.
- **Equivalente (1):** sin la lista de categorías admitidas en `OperationOverridesService`. La consulta ya filtra por una columna enum que solo admite `USERS_ADD`.

«Excepción vencida» y «sin volver a comprobar el estado» sobrevivían a la primera versión de la suite. Se añadieron sus pruebas y ahora se detectan.

### Pendiente

- **4.3b:** ✅ implementada (sección siguiente).
- **`cancelledClosingDays` del plan:** el periodo de cierre sigue siendo la constante de 30 días de `tenant-operation.ts`; leerlo de la política del plan exige llevar la versión de plan al resolvedor.
- **Dominios propios (`CUSTOM`) y su verificación**, y cambiar el plan de una suscripción: fuera de la 4.3.

## Etapa 4.3b · Invitaciones de membresía (implementada y aprobada el 2026-11-10)

### Decisiones del responsable (2026-11-10)

| Pregunta | Decisión |
|---|---|
| ¿Cómo entra una persona invitada que aún no tiene cuenta? Todavía no hay registro ni correo (Fase 12), y el enlace lo ve también quien invita (F4-Q3) | **Crea la cuenta al aceptar.** El enlace (un solo uso, 72 h) sirve como prueba provisional y la cuenta queda con el correo **sin verificar**. **Riesgo residual aceptado:** quien tenga el enlace puede crear esa cuenta y saber si el correo ya tenía una. Se elimina en la Fase 12, cuando el enlace se envíe por correo y deje de mostrarse a quien invita |
| ¿Cómo se comprueban las contraseñas filtradas? | **Lista local**, sin llamadas externas: entre 10 y 128 caracteres; fuera de la lista de filtradas; sin el correo, su parte local, las palabras del nombre ni «yebo» |
| ¿Se puede invitar desde el panel del staff? | **Sí.** Una sola acción, «Invitar usuario», en la que se elige si la persona va al **staff de YEBO** o a **una empresa** |

### Decisiones de implementación

| Tema | Decisión | Motivo |
|---|---|---|
| Token | `<id del tenant>.<secreto de 256 bits>`. En la base, solo el SHA-256 del secreto. El enlace es `https://<AUTH_HUB_HOST>/invitacion#<token>`: el token va en el fragmento, que no llega al servidor ni al Referer, y la página lo quita de la barra de direcciones al leerlo | El id del tenant permite al hub fijar el contexto (RLS) **antes** de buscar el hash. Así la tabla conserva el RLS, sin excepción global |
| Caducidad | 72 h; `CHECK` de un máximo de 7 días | F4-Q3: caducidad corta |
| Invitar desde la empresa | `POST /api/v1/invitations` (`members.invite`, categoría `USERS_ADD`); también listar (`members.read`) y revocar (`members.invite`, `USERS_REDUCE`). Los roles deben ser de la empresa. **No se consulta si el correo tiene cuenta:** la respuesta es idéntica | multitenancy §1.1 |
| Primer administrador | `firstAdminEmail` en el alta (misma transacción, rol Administrador). El enlace se devuelve **una vez** (`Cache-Control: no-store`). La auditoría guarda el id de la invitación, no el correo | F4-Q3; datos personales fuera de la auditoría |
| «Invitar usuario» en el panel | `POST /platform/invitations` con el destino en el cuerpo:<br>• **`STAFF`:** correo, nombre y rol de plataforma; reutiliza el alta de la 4.1 (enlace de configuración, MFA obligatoria) y exige `platform.staff.manage`. Es la **única** forma de dar de alta al staff: `POST /platform/staff` de la 4.1 se retiró (decisión del 2026-11-10) y sus pruebas usan esta ruta.<br>• **`TENANT`:** empresa, correo y roles **de esa empresa** (`GET /platform/tenants/:id/roles` alimenta el selector); se acepta en el hub y exige `platform.tenants.manage`.<br>La ruta exige la sesión del staff y el permiso se comprueba según el destino. Los realms siguen separados: una invitación al staff no crea cuenta ni invitación de empresa, y al revés | Decisión del responsable (2026-11-10) |
| Permiso `members.invite` | Nuevo en el catálogo y en la plantilla Administrador. La migración lo añade a los roles Administrador existentes, tenant a tenant (por el RLS forzado), e incrementa la versión de permisos de sus membresías | — |
| Aceptar (hub) | `POST /hub/invitations/preview`, `/accept` (con la sesión del hub; el correo debe ser el invitado) y `/register` (crea la cuenta y abre la sesión del hub). Siempre con CSRF y un límite de 30 intentos por IP cada 15 min. Token mal formado, inexistente, caducado, revocado o usado: **la misma respuesta** (`404`) | — |
| Un solo uso | La fila se bloquea (`FOR UPDATE`) y se marca aceptada en la misma transacción que crea la membresía | — |
| Estado del tenant | Aceptar habilita una membresía (consumo facturable): la empresa debe admitir `USERS_ADD` **en ese momento** (matriz o excepción vigente de YEBO), leída sin caché | multitenancy §5.2 |
| Membresía existente | `SUSPENDED` o `REVOKED` → `ACTIVE`; se suman los roles y se incrementa la versión de permisos | — |
| Correo ya registrado al crear la cuenta | `409` («inicia sesión para aceptar»), también en la carrera de dos registros simultáneos (restricción única) | Riesgo residual aceptado |
| `yebo_identity` | Pasa a crear cuentas y membresías, siempre con el contexto del tenant. Sigue sin poder borrar ni cambiar cuentas existentes, ni la persona o la empresa de una membresía | ADR-034: permisos mínimos y por columna |
| Pantalla `/invitacion` | En el hub, con los componentes y tokens de la 3.2b. Muestra la empresa y el correo invitado. Ofrece aceptar (con sesión), crear la cuenta o entrar con la contraseña, sin revelar de entrada si el correo tiene cuenta. Al terminar, enlace a la empresa | — |

### Base de datos

- **Migración `20261110210000_fase4_3b_membership_invitations`:**
  - crea `membership_invitations` (de tenant, con RLS forzado);
  - FK compuestas a la membresía que invita y a la que acepta;
  - `CHECK`: correo normalizado, de 1 a 20 roles, hash de 32 bytes, caducidad de 7 días como máximo, un único origen (membresía o staff), aceptación coherente, y no aceptada y revocada a la vez;
  - permiso `members.invite`.

  La reversión está en su cabecera.
- **Privilegios:**
  - `yebo_app`: SELECT e INSERT en `membership_invitations`, y UPDATE de `revoked_at`.
  - `yebo_backoffice`: SELECT e INSERT en `membership_invitations`.
  - `yebo_identity`:
    - SELECT en `membership_invitations` y UPDATE de `accepted_at` y `accepted_membership_id`;
    - INSERT en `users` y en `tenant_memberships`, y UPDATE de su estado y su versión de permisos;
    - SELECT e INSERT en `membership_roles`;
    - SELECT en `roles` y en `tenant_operation_overrides`.
- **Lista de contraseñas filtradas:** `identity/data/common-passwords.txt.gz` (680 KB). Origen y procedimiento en su `README.md`. Se copia a `dist` con `assets` de `nest-cli.json`.

### Pruebas

| Suite | Contenido | Resultado |
|---|---|---|
| Unitarias: `password-policy.spec` (3) e `invitation-token.spec` (4) | Longitud, lista de filtradas, correo, nombre sin tildes y «yebo». Ida y vuelta del token, unicidad, formatos inválidos y enlace con fragmento | ✅ |
| `invitations.int-spec` (17) | **Primer administrador:** enlace devuelto una vez y solo el hash en la base, auditoría sin el correo; vista previa y tokens inválidos con un único mensaje (incluido el secreto real con otro tenant); política de contraseñas; cuenta sin verificar, membresía `ACTIVE` con Administrador y sesión del hub que ya ve la empresa; un solo uso. **Panel:** invitar a una empresa con roles elegidos (rol de otra empresa → 400, empresa inexistente → 404) y al staff con rol de plataforma, sin cruzar los realms; permiso por destino; destino desconocido o datos incompletos → 400. **Empresa:** respuesta idéntica exista o no la cuenta; rol de otra empresa; con cuenta, solo el titular; aceptaciones simultáneas; bloqueo con una aceptación concurrente; reactivación con versión; revocar (y revocar otra vez), listado con estados y aislamiento; caducidad exacta de 72 h; `SUSPENDED` sin invitar ni aceptar y con la excepción de YEBO. Registros simultáneos con el mismo correo | ✅ |
| `access`, `sessions` y `privileges` | Barrido de rutas públicas con las tres del hub; `members.invite` en el catálogo y la plantilla; garantías de `yebo_identity` actualizadas; matriz versionada | ✅ |
| Integración completa | 17 suites y 302 pruebas. **Una prueba de estrés anterior falla de forma intermitente** (ver «Pendiente») | ⚠️ |
| Unitarias, lint, typecheck, formato y build (API y web) | 135 unitarias | ✅ |

**Mutaciones (17):**
- **Detectadas (15):**
  - un solo uso: sin `FOR UPDATE`, sin marcar la invitación como aceptada;
  - validez: caducidad ignorada, revocada válida;
  - aceptación: sin comprobar el correo, sin sesión del hub, sin roles asignados;
  - estado del tenant: sin comprobarlo, excepción ignorada;
  - cuenta y membresía: sin política de contraseñas, reactivar sin incrementar la versión;
  - empresa y staff: roles de otra empresa, revocar dos veces, sin invitación en el alta;
  - panel: sin el permiso por destino, roles sin validar.
- **Equivalente (1):** registrarse con un correo que ya tiene cuenta sin la comprobación previa. La restricción única de la base da el mismo `409`; la comprobación previa solo evita calcular Argon2 en vano.
- **Sobrevivían a la primera versión de la suite (2):** «sin `FOR UPDATE`» y «revocar dos veces». Las dos peticiones simultáneas de la prueba original no llegaban a solaparse de verdad, así que se añadió una prueba determinista: otra transacción bloquea la fila y la acepta mientras la aceptación espera. Ahora las dos se detectan.

### Pendiente

- ✅ **Fallo intermitente en `isolation-e2e` (Fase 3.4): diagnosticado y corregido el 2026-11-10**, con autorización del responsable.
  - **Síntoma:** la prueba de 600 lecturas concurrentes recibió un `500` en `GET /api/v1/roles` en 2 de 6 ejecuciones completas de la integración.
  - **Causa:** el error P2028 de Prisma («Unable to start a transaction in the given time»). Cada petición abre sus transacciones con `yebo_app` (permisos en el guard, la lectura de la ruta y, desde la 4.2, los módulos efectivos en `/auth/session`). Con 600 peticiones sobre un pool de 10 conexiones, alguna esperaba más que la `maxWait` por defecto de Prisma (2 s), y el filtro global la convertía en `500`. Con `PG_POOL_MAX=2` fallaba siempre (396 errores P2028). **No era un fallo de aislamiento:** ninguna respuesta mezcló datos de dos empresas.
  - **Corrección:**
    1. Variable `PG_TX_MAX_WAIT_MS` (por defecto 10 s, entre 100 ms y 60 s): espera para iniciar una transacción en **todos** los clientes de Prisma (`createPrismaClient` la exige).
    2. Si aun así se agota (P2028, o P2024 en una consulta suelta), la API responde **`503 SERVICE_UNAVAILABLE` con `Retry-After: 1`** y lo registra como aviso, no como error interno.
  - **Pruebas:**
    - `db-pool-pressure.int-spec`, con un pool de una conexión y 25 transacciones de 120 ms: sin errores con la espera por defecto (sin la corrección, falla de forma determinista); con 300 ms, P2028 traducido a `503`.
    - Unitarias del filtro: traducción a `503` y cabecera `Retry-After`.
    - `isolation-e2e` pasa con `PG_POOL_MAX=2`.
    - Tres ejecuciones completas seguidas: 18 suites y 304 pruebas.
  - **Mejora posterior (no hecha):** reunir en una sola transacción las consultas de permisos y de módulos de cada petición.
- **Revisión visual de `/invitacion`** en el navegador (accesibilidad AA e Impeccable): con las pantallas de la 4.7. Compila y pasa typecheck y lint, pero no se ha recorrido en un navegador.
- **Fase 12:** enviar el enlace por correo, dejar de mostrarlo a quien invita y verificar el correo. Así se elimina el riesgo residual.
- ✅ **Migración aplicada a `yebo_dev`** el 2026-11-10 con autorización del responsable, tras una copia de la base (`pg_dump`). La API y el worker responden `ready`.

## Etapa 4.4 · Medición de usuarios (implementada y aprobada el 2026-11-10)

### Decisiones del responsable (2026-11-10)

| Pregunta | Decisión |
|---|---|
| ¿Quién escribe `membership_status_history` en la misma transacción que cada cambio? (El repositorio prohíbe `SECURITY DEFINER`) | **Triggers `SECURITY INVOKER`** en `tenant_memberships` y `users`: se ejecutan con el rol y el contexto de quien hace el cambio. Ningún servicio puede olvidarlo |
| Rol `yebo_metering`: ¿política de lectura entre tenants (F4-Q2) o contexto por tenant? | **Contexto por tenant:** el job recorre las empresas y fija el contexto de cada una. Sin políticas entre tenants (menos privilegio que lo aprobado en F4-Q2) |
| Crear el rol en el clúster de desarrollo | Autorizado: copia de `yebo_dev`, `init-env.sh` y `harden-roles.sh --test-role` |

### Decisiones de implementación

| Tema | Decisión | Motivo |
|---|---|---|
| Historial | Una fila por intervalo con `status`, `billable`, `user_active` y `effective_billable`. Un `CHECK` impone que `effective_billable` = `ACTIVE` ∧ `billable` ∧ usuario activo, en lugar de una columna generada (Prisma no las representa) | billing §1 |
| Trigger de membresías | `AFTER INSERT OR UPDATE OF status, billable`. Cierra la fila vigente (`valid_to = now()`) y abre otra (`valid_from = now()`). En un cambio, el estado del usuario se **arrastra** de la fila vigente, porque `yebo_app` no lee `users`; en un alta lo lee de `users`, porque solo dan de alta `yebo_identity` y el rol de pruebas. Un UPDATE que no cambia nada no escribe | Misma transacción, sin servicios que lo olviden |
| Trigger de usuarios | `AFTER UPDATE OF status`. Recorre **todas** las membresías del usuario fijando el contexto de cada empresa, y al final restaura el contexto anterior. Leer las membresías de todas las empresas exige la política de `yebo_identity`: solo ese rol debe cambiar `users.status` | billing §2.1 |
| Dos cambios en una transacción | La fila intermedia dura 0 (rango vacío): no solapa ni cuenta | `CHECK valid_to >= valid_from` |
| Guarda | `INSERT` solo vigente y con `valid_from` del servidor (±1 min); `UPDATE` solo para cerrar la vigente, ahora y sin tocar nada más; `DELETE` prohibido. `EXCLUDE` impide solapes por membresía | billing §2.1 |
| Arranque | La migración abre la fila vigente de cada membresía existente: la medición empieza en ese momento | No hay historia anterior fiable |
| Valor diario | La consulta de billing §3 (barrido de eventos con las salidas antes que las entradas en el mismo instante), en `metering/usage-calculation.ts`. `min_active_seconds` del plan ignora las filas cerradas más cortas | billing §3 y §7 |
| Snapshots | Solo `FINAL`, inmutables por trigger, con la zona horaria, el rango del día, `algorithm_version = 1` y el detalle (intervalos recortados al día y el `min_active_seconds` aplicado). El día en curso se calcula al vuelo como `PROVISIONAL` sin guardarlo | billing §4 |
| Job | Horario en el worker (BullMQ, planificador único). Por empresa, con su contexto: calcula los días entre el primer día con historial y el último terminado hace 15 min en su zona horaria que no tienen snapshot (`ON CONFLICT DO NOTHING`). Un job caído o dos ejecuciones simultáneas dan el mismo resultado | billing §4 |
| Zona horaria | La de la empresa. Desde la 4.5, la del período (fija mientras dura) | billing §2.2 |
| Panel | `GET /platform/tenants/:id/usage?from&to` (`platform.billing.read`, como mucho 93 días): días `FINAL` y el día en curso `PROVISIONAL` | Pantalla de consumo de la 4.7 |
| `yebo_metering` | Rol nuevo, sin `BYPASSRLS`. SELECT en `tenants`, `membership_status_history`, `subscriptions` y `plan_versions`; SELECT e INSERT en `usage_daily_snapshots`. Lo usan solo el worker y la frontera 5 de ESLint (`MeteringPrismaService`, solo en `modules/metering`). La API arranca sin su contraseña | F4-Q2 |

### Autor de cada cambio (decisión del responsable, 2026-11-10)

`changed_by_kind` (`MEMBERSHIP`, `USER`, `PLATFORM_USER` o `SYSTEM`), `changed_by_id` y `reason`, en la migración `20261111000000_fase4_4_history_actor`.

- **Cómo se declara:** cada servicio declara el autor en la transacción del cambio (`declareChangeActor`: variables `app.actor_kind`, `app.actor_id` y `app.change_reason`), y los triggers lo copian a cada fila.
- **Quién lo declara hoy:**
  - suspender o reactivar desde la empresa: `MEMBERSHIP`, con la membresía que actúa;
  - aceptar una invitación: `USER`, con la persona que acepta.
- **Nunca sin autor:** si un rol de ejecución cambia una membresía o un usuario sin declararlo (o sin su id), la base lo rechaza. Solo el propietario (migraciones) y un rol con `BYPASSRLS` (pruebas; nunca en producción) quedan como `SYSTEM`, igual que las filas del arranque de la medición.
- **Coherencia:** un `CHECK` impone que solo `SYSTEM` va sin id.
- **Pruebas:**
  - cambio sin autor y sin su id rechazados;
  - autor registrado al suspender por la API y al aceptar una invitación;
  - 3 mutaciones detectadas (no exigir el autor, no exigir su id, no copiarlo).

### Base de datos

- **Migración `20261110230000_fase4_4_usage_metering`:**
  - crea `membership_status_history` y `usage_daily_snapshots` (de tenant, con RLS forzado);
  - `EXCLUDE`, `CHECK`, la guarda del historial, los dos triggers de escritura y la inmutabilidad de los snapshots, todo `SECURITY INVOKER`;
  - abre la fila vigente de las membresías existentes.

  La reversión está en su cabecera.
- **Privilegios:**
  - `yebo_app` y `yebo_identity`: SELECT e INSERT en el historial y UPDATE de `valid_to` (los usan los triggers).
  - `yebo_app`: SELECT en `usage_daily_snapshots` (su consumo, para la 4.5).
  - `yebo_backoffice`: SELECT en el historial y los snapshots.
  - `yebo_metering`: el de la tabla anterior.
- **Clúster de desarrollo:** ✅ rol `yebo_metering` creado el 2026-11-10 con autorización, tras una copia de `yebo_dev`. Reversión: `DROP OWNED BY yebo_metering` en cada base y `DROP ROLE yebo_metering`. **La migración no está aplicada a `yebo_dev`**; hasta aplicarla, el job de medición del worker registra un error en cada ciclo.

### Pruebas

| Suite | Contenido | Resultado |
|---|---|---|
| `metering.int-spec` (20) | **Valor diario:** el ejemplo de §3.1 da 3 y 4; reemplazo en el mismo instante sin doble conteo; días de 23 y 25 horas (Madrid), con la hora repetida contada; dos tramos de una misma membresía cuentan una vez; no cuentan suspendidos, no facturables, usuarios deshabilitados ni el staff; `min_active_seconds`; RLS de `yebo_metering`. **Snapshots:** job caído 3 días igual que a tiempo, margen de 15 min, repetir no crea nada, ejecuciones simultáneas, inmutables, planificador único en el worker. **Triggers:** alta, cambio con `yebo_app` sin leer `users`, deshacer, dos cambios en una transacción, UPDATE sin cambios, deshabilitar al usuario en todas sus empresas restaurando el contexto, alta de un usuario deshabilitado, historial inmodificable y `CHECK` de coherencia. **Panel:** días `FINAL` y `PROVISIONAL` | ✅ |
| `privileges`, `boundaries`, `tenancy` y `migration-paths` | Rol nuevo en la foto de roles, bases y privilegios; frontera 5; las dos tablas en la cobertura de RLS | ✅ |
| Integración completa | 19 suites y 329 pruebas | ✅ |
| Unitarias, lint, typecheck, formato y build | 137 unitarias | ✅ |

**Mutaciones (18):** 10 en el código y 8 en las funciones de los triggers, estas sustituidas temporalmente en `yebo_test` y restauradas después.
- **Detectadas (16):**
  - en el cálculo: entradas antes que salidas, sin recortar al día, sin filtro de facturable, sin `min_active_seconds`, zona UTC, `COUNT` sin `DISTINCT`;
  - en el job: sin margen de 15 min, cerrar el día en curso;
  - en la guarda: `DELETE` permitido, cualquier UPDATE, fechas retroactivas;
  - en los triggers: alta sin leer el estado del usuario, sin arrastrar `user_active`, sin restaurar el contexto, escribir sin cambios;
  - en los snapshots: modificables.
- **Equivalentes (2):**
  - contar la salida que coincide con el fin del día: es posterior a todo lo demás y no cambia el máximo;
  - quitar el filtro de tenant explícito del cálculo: el RLS ya lo aplica (defensa en profundidad).
- **Sobrevivían a la primera versión de la suite y ahora se detectan (5):** sin recortar al día, `COUNT` sin `DISTINCT`, alta sin leer el usuario, sin restaurar el contexto (la prueba fijaba un contexto que podía coincidir por azar) y escribir sin cambios.

### Pendiente

- ✅ Migraciones aplicadas a `yebo_dev` (con copia previa).
- 4.5: la zona horaria del período sustituye a la de la empresa.

## Etapa 4.5 · Períodos, importe y cobro (implementada y aprobada el 2026-11-10)

### Decisiones del responsable (2026-11-10)

| Pregunta | Decisión |
|---|---|
| ¿Cuándo vence una factura? | **Días por plan:** `plan_versions.payment_terms_days` (por defecto 7); vencimiento = emisión + N días |
| Impuestos mientras S5 no esté validado | **Tasa 0 configurable:** `plan_versions.tax_rate` (por defecto 0); los precios del plan son la base imponible. Cuando el contador valide S5 se fija la tasa sin migrar datos (**pendiente explícito**) |
| Períodos en prueba | **Sin factura:** se cierran y se calculan, pero no se emite factura |
| Reactivación al pagar | **Sin saldo vencido:** cuando no queda ninguna factura vencida con saldo, la empresa en `PAST_DUE`, `SUSPENDED` o `EXPIRED` vuelve a `ACTIVE` en la misma transacción que el pago. Pagos parciales sí; pagar más que el saldo, no |

### Decisiones de implementación

| Tema | Decisión | Motivo |
|---|---|---|
| Precio (F4-Q1) | **Punto único** `billing/pricing.ts` (`resolvePricing`): la versión de plan con la excepción comercial de la suscripción (`price_override`: `basePrice`, `extraUserPrice`, `includedUsers` y un motivo obligatorio; cualquier otro campo detiene el cierre). El cálculo guarda el precio aplicado (`pricing`) y la copia de la versión de plan | ADR-031 podrá sustituir solo esa función, sin migrar datos |
| Valor e importe | `periodValue` (`PEAK_DAILY` = máximo, `AVERAGE_DAILY` = techo de la media, `END_OF_PERIOD` = último día) y `periodAmounts` (adicionales, base, impuesto redondeado a 2 decimales), con `Decimal`, nunca `float` | billing §5 |
| Períodos | `[period_start, period_end)` en fechas locales, con la zona horaria **fija** desde que se abre. El job abre el período de la suscripción vigente si falta (salvo empresas `CANCELLED` o `EXPIRED`) | billing §2.2 |
| Cierre | Job horario del worker (el mismo de la medición, rol `yebo_metering`), 15 min después del fin del período. Por empresa, con su contexto y un cerrojo consultivo, en una transacción: `OPEN` → `CLOSING`; completa los snapshots que falten (nunca factura con días faltantes); calcula; si no es de prueba, emite la factura (`ISSUED`, o `PAID` si el total es 0) con sus líneas `BASE` y `EXTRA_USERS`; `CLOSED`; avanza la suscripción y abre el período siguiente. Un job caído varios períodos los cierra en orden | billing §6 |
| Código de factura | `YB-AAAAMM-` más 8 caracteres hexadecimales del id: único, sin secuencia. La numeración fiscal correlativa llegará con el comprobante (`fiscal_document_ref`, puerto de facturación de la Fase 11) | Una secuencia suelta rompería la prueba de deriva |
| Inmutabilidad | Triggers: período cerrado inmutable (y transiciones solo hacia adelante); cálculos y líneas append-only; factura con importes, fechas y período inmutables (solo cambian estado y saldo); facturas, períodos y pagos nunca se borran. `CHECK` de coherencia de importes, y de estado y saldo | billing §6 |
| Vencimiento | El job de estados (4.3a) marca `OVERDUE` las facturas con saldo cuya fecha de vencimiento ya pasó en la zona de la empresa, y pasa la empresa `ACTIVE` a `PAST_DUE`. La gracia hasta `SUSPENDED` ya existía | multitenancy §5.2 |
| Pagos | `POST /platform/tenants/:id/invoices/:invoiceId/payments` (`platform.billing.manage`: BILLING y SUPERADMIN). Bloquea la factura; rechaza pagar más que el saldo (`400`) o una factura pagada o anulada (`409`); guarda el pago; actualiza saldo y estado (`PAID`, `PARTIALLY_PAID` u `OVERDUE`); audita; reactiva si procede. La transición de estado se separó de su transacción (`TenantLifecycleService.applyIn`) para hacerlo todo en una | Decisión del 2026-11-10 |
| Panel | `GET /platform/tenants/:id/billing` (`platform.billing.read`): períodos con su cálculo, y facturas con líneas y pagos | Pantallas de la 4.7 |
| Empresa | `GET /api/v1/billing/obligations` (permiso nuevo `billing.read`, categoría `BILLING_SELF`, disponible también suspendida): saldo pendiente por moneda, período en curso y facturas con líneas y pagos | «Obligaciones con YEBO» |

### Base de datos

- **Migración `20261111020000_fase4_5_billing`:**
  - columnas `payment_terms_days` y `tax_rate` en `plan_versions`;
  - tablas `billing_periods`, `usage_period_calculations`, `platform_invoices`, `platform_invoice_lines` y `subscription_payments`, de tenant, con RLS forzado y claves foráneas compuestas;
  - `CHECK` e inmutabilidad;
  - permiso `billing.read`, añadido a la plantilla y a los roles Administrador existentes.

  La reversión está en su cabecera.
- **Privilegios:**
  - `yebo_metering`:
    - SELECT e INSERT en períodos, cálculos, facturas y líneas;
    - UPDATE del estado y del cierre del período, y del período vigente de la suscripción.
  - `yebo_backoffice`:
    - SELECT de todo;
    - INSERT de pagos;
    - UPDATE del estado y del saldo de las facturas.
  - `yebo_app`: SELECT de sus períodos, cálculos, facturas, líneas y pagos (RLS).

### Pruebas

| Suite | Contenido | Resultado |
|---|---|---|
| Unitarias: `pricing.spec` (6) | Ejemplo de §5 (204), sin adicionales, las tres métricas y la serie vacía, excepción comercial (y su rechazo si está mal formada), impuesto redondeado | ✅ |
| `billing.int-spec` (15, con el cambio de plan) | **Cierre:** margen de 15 min y los 31 días; fórmula de §5 (12 → 7 adicionales → 204,00) con copia del plan; factura, líneas y vencimiento a 7 días; suscripción avanzada y período siguiente abierto; repetir no crea nada; revocar usuarios después no altera la factura; nada se modifica tras el cierre (período, cálculo, líneas, importes, snapshots); `AVERAGE_DAILY` y `END_OF_PERIOD`; trial sin factura; excepción comercial. **Cobro:** parcial, superar el saldo, VIEWER sin permiso; vencimiento (no el mismo día, sí el siguiente) → `OVERDUE` y `PAST_DUE`; pagar el saldo → `PAID` y `ACTIVE` con historial y auditoría; factura pagada → `409`. **Empresa:** obligaciones propias, y RLS frente a otra empresa | ✅ |
| `access` y `privileges` | `billing.read` en el catálogo y la plantilla; matriz versionada | ✅ |
| Integración completa | 20 suites y 344 pruebas (con el cambio de plan) | ✅ |
| Unitarias, lint, typecheck, formato y build | 144 unitarias | ✅ |

**Mutaciones detectadas (11 de 11):**
- en el cierre: sin margen, sin completar los días, trial facturado, sin avanzar la suscripción, vencimiento sin los días del plan, sin la excepción comercial;
- en los pagos: sin límite de saldo, factura pagada que admite pagos, sin reactivar;
- en los vencimientos: sin marcar vencidas, vencer el mismo día.

### Cambio de plan a mitad de período (decisión del responsable, 2026-11-10)

Sustituye la regla MVP de billing §7 para los upgrades. Migración `20261111030000_fase4_5_plan_change`.

| Caso | Regla e implementación |
|---|---|
| Upgrade (la base mensual equivalente sube, o es igual con más incluidos) | Aplica **hoy** (día local de la empresa), desde la petición siguiente: módulos y límites salen de la suscripción vigente. En una transacción del panel (`POST /platform/tenants/:id/subscription/plan`, `platform.billing.manage`): el período en curso recibe `cut_off` = hoy, la suscripción vigente deja de serlo y se crea otra con el plan nuevo que empieza hoy con su propio ciclo, junto con su período. El job cierra el período cortado con los días hasta ayer: **base prorrateada** (días usados / días del período, redondeo a 2 decimales) más los usuarios adicionales medidos en esos días a su precio; la factura se emite el día del corte. El período nuevo se factura a su cierre |
| Downgrade | Se programa (`subscriptions.next_plan_version_id`) y aplica al cerrar el período en curso, que se cobra completo: el job crea la suscripción nueva desde el fin del período |
| Restricciones | Solo versiones publicadas y distintas de la vigente; empresa en `TRIAL`, `ACTIVE` o `PAST_DUE`. El corte se fija una sola vez y no se mueve (trigger). La excepción comercial del plan anterior no pasa a la suscripción nueva. Un upgrade el mismo día en que empezaba el período cierra ese período sin días ni importe |
| Pruebas | Upgrade el 21/10: el período de octubre se cierra con 20/31 días (63,87 de base + 7 × 15 = 168,87, emitida el 21/10) y el nuevo (21/10–21/11) se factura a su cierre con el plan nuevo (199,00); downgrade aplicado el 1/11 con octubre completo (204,00); validaciones. Unitaria del prorrateo. Mutaciones detectadas (5 de 5): todo es upgrade, sin prorrateo, corte ignorado, downgrade no aplicado, versión no publicada |

### Pendiente

- **S5:** fijar `tax_rate` cuando el contador valide los impuestos.
- **Ajustes y anulaciones** (`ADJUSTMENT`, `CREDIT`, `VOID`) y **reversión de pagos** (`REVERSED`): los tipos existen, pero no hay operación todavía.
- ✅ Migraciones aplicadas a `yebo_dev` el 2026-11-10 (con copia previa).

# Registro de decisiones arquitectónicas (ADR)

Estados: **Propuesto** (pendiente de revisión) → **Aceptado** / **Rechazado** / **Reemplazado por ADR-XXX**.

**Estado del registro: los ADR-001 a 023 fueron ACEPTADOS el 2026-11-05** (cierre de la Fase 1), y los ADR-024 a 026 el mismo día (Fase 2). Las precisiones de la aprobación están en la sección final y en el [registro de decisiones](decision-log.md).

Historial:
- **R1** (2026-11-05): primera propuesta de la Fase 1.
- **R2** (2026-11-05): incorpora las 9 observaciones de la revisión. Los ADR marcados con R2 cambiaron en esta revisión.
- **Aprobación** (2026-11-05): todos los ADR pasan a Aceptado con las precisiones finales.

A partir de la aprobación, cualquier cambio se registra como **un ADR nuevo que reemplaza al anterior** ("Reemplazado por ADR-XXX"). Los ADR aceptados no se editan en su contenido.

| ADR | Título | Estado |
|---|---|---|
| 001 | Monolito modular con procesos `api` y `worker` | **Aceptado** |
| 002 | Monorepo pnpm + Turborepo con `apps/web` y `apps/platform` | **Aceptado** |
| 003 | Multitenancy: BD compartida, FK compuestas, extensión Prisma y RLS | **Aceptado** |
| 004 | Tenant resuelto por host y validado contra el token | **Aceptado** · R2 |
| 005 | Identidad global + membresías por tenant; staff de plataforma separado | **Aceptado** (D3) |
| 006 | Zod como fuente única de contratos | **Aceptado** |
| 007 | Inventario por tramos: exclusión GIST + contadores por segmento | **Aceptado** · R2 |
| 008 | Outbox transaccional + BullMQ | **Aceptado** |
| 009 | Tokens: JWT corto + refresh opaco rotado + verificación de sesión por request | **Aceptado** · R2 |
| 010 | Snapshots inmutables y versionado de configuración | **Aceptado** |
| 011 | QR de boletos firmados con Ed25519 | **Aceptado** |
| 012 | Proveedores externos detrás de puertos | **Aceptado** |
| 013 | UUID v7 + códigos de negocio por secuencia | **Aceptado** |
| 014 | Núcleo comercial-financiero compartido; dominios operativos independientes | **Aceptado** · R2 |
| 015 | Facturación electrónica: contrato interno versionado + adaptador en código + conexión por tenant | **Aceptado** · R2 (D2) |
| 016 | Medición de usuarios: intervalos de historial, día en la zona horaria del período, pico concurrente | **Aceptado** · R2 (D5) |
| 017 | PIN de entrega: HMAC con pepper + Argon2id, intentos, reemplazo autorizado | **Aceptado** · R2 |
| 018 | Configuración tributaria como datos | **Aceptado** (catálogo inicial por validar con contador) |
| 019 | Datos personales: cifrado de campo, índice ciego y registro de accesos | **Aceptado** |
| 020 | Canales de venta, agencias y propietarios como módulos opcionales | **Aceptado** (módulos D6/D7 apagados hasta validación comercial) |
| 021 | Categorías abiertas como catálogos; enums solo para máquinas de estado | **Aceptado** |
| 022 | Hub de cuentas con authorization code + PKCE para login y cambio de empresa | **Aceptado** · nuevo en R2 |
| 023 | Política de estados del tenant: bloquear nuevas obligaciones, nunca el cumplimiento | **Aceptado** · nuevo en R2 |
| 024 | Restricciones de BD: FK en el esquema Prisma, EXCLUDE/CHECK/RLS en SQL y prueba de deriva | **Aceptado** · Fase 2 |
| 025 | Políticas RLS con `NULLIF(current_setting(...), '')` y contexto por transacción | **Aceptado** · Fase 2 |
| 026 | Bloqueo ordenado de recursos antes de la exclusión GIST | **Aceptado** · Fase 2 |

---

### ADR-001 · Monolito modular con procesos `api` y `worker`
**Contexto:** equipo reducido, dominio amplio y necesidad de transacciones entre módulos (venta + inventario + caja). **Decisión:** una aplicación NestJS con módulos por dominio y dos entrypoints: HTTP y worker BullMQ. **Alternativas:** microservicios (descartados porque implican transacciones distribuidas y alto costo operativo); un solo proceso (descartado porque los jobs competirían con la latencia HTTP). **Consecuencias:** despliegue simple; disciplina de límites reforzada con lint de dependencias.

### ADR-002 · Monorepo con `apps/web` y `apps/platform`
**Decisión:** pnpm workspaces + Turborepo. `web` agrupa el portal público, el panel de la empresa, el POS, la PWA y el hub de cuentas (comparten tenant por host, tema y sesión). `platform` es el superadmin en un dominio aislado. Paquetes: `contracts`, `api-client`, `ui` y `config`.

### ADR-003 · Multitenancy compartida con doble barrera
**Decisión:** `tenant_id` en toda tabla de tenant; `UNIQUE (tenant_id, id)` + FK compuestas; extensión Prisma que exige contexto; RLS forzado con `set_config` local a la transacción; roles `yebo_app` (con RLS) y `yebo_platform` (`BYPASSRLS`, acceso restringido). **Consecuencias:** una transacción por operación de tenant (rendimiento a medir en la Fase 3); prueba automática de cobertura de RLS.

### ADR-004 · Tenant desde el host, nunca desde el cliente (R2)
**Decisión:** el host resuelve el tenant; el token contiene `tid` y debe coincidir. El login y el cambio de empresa usan el hub de cuentas (ADR-022) en lugar del "código de handoff" de la versión anterior. Las cookies nunca se comparten entre dominios.

### ADR-005 · Identidad global + membresías
**Contexto:** D3. **Decisión:** `users` global; `tenant_memberships` con roles por tenant; `platform_users` separado; soporte mediante `support_access_grants`. **Consecuencias:** los administradores de tenant gestionan membresías, no credenciales; invitaciones en lugar de "crear usuario"; respuesta uniforme contra la enumeración.

### ADR-006 · Zod como fuente única de contratos
**Decisión:** esquemas en `packages/contracts`, usados por React Hook Form, la API (`nestjs-zod`) y la generación de OpenAPI; `api-client` generado desde OpenAPI. **Riesgo:** madurez de la integración Zod-OpenAPI; se valida con una prueba de concepto en la Fase 2.

### ADR-007 · Inventario por tramos (R2)
**Decisión:**
- **Recursos asignables** (asiento, cama, camarote sin camas, espacio de vehículo): `resource_allocations` con `int4range` y `EXCLUDE USING gist (trip_resource_id WITH =, stop_range WITH &&) WHERE status <> 'RELEASED'`.
- **Capacidades agregadas** (zona libre, hamacas, bodega, cubierta, **aforo total de la unidad**): `trip_pool_segment_usage` materializada al abrir la venta, `SELECT … FOR UPDATE` en orden `(pool_id, segment_seq)` y `CHECK (used <= capacity)`.
- **Camarotes con camas**: el inventario son las camas; el camarote completo se vende asignando todas sus camas en una sola transacción.
- Nivel de aislamiento `READ COMMITTED`; no se usa `SERIALIZABLE`.

**Cambio R2:** se elimina la asignación "parcial" del camarote (`PARENT_PARTIAL`), que habría impedido vender dos camas distintas del mismo camarote a la vez, y se añade el pool de aforo total. **Consecuencias:** la garantía contra la sobreventa la da PostgreSQL. Ejemplos y pruebas en [capacity-and-inventory.md](capacity-and-inventory.md).

### ADR-008 · Outbox + BullMQ
**Decisión:** los eventos con efecto externo se escriben en `outbox_events` dentro de la transacción; un relay (`SKIP LOCKED`) los publica en BullMQ con `jobId = eventId`; los consumidores son idempotentes (`processed_events`). **Consecuencias:** entrega *at-least-once* con deduplicación; los fallos de Mailgun o de la API facturadora no afectan las ventas.

### ADR-009 · Tokens y sesiones (R2)
**Decisión:**
- Sesión de identidad en el hub + sesión por empresa en cada dominio.
- JWT de 10 min en una cookie `__Host-` + refresh opaco hasheado y rotado, con detección de reutilización y una ventana de gracia de 20 s para pestañas concurrentes.
- **Verificación del estado de la sesión en Redis en cada request** (respaldo en PostgreSQL), así que la revocación es inmediata.
- Un cambio de permisos (`ver`) re-emite el token sin cerrar la sesión.
- Cookies `httpOnly` + CSRF *double-submit* en web; *bearer* en la PWA y en integraciones.

**Cambio R2:** la revocación deja de depender del TTL del access token. Detalle en [identity-and-sessions.md](identity-and-sessions.md).

### ADR-010 · Snapshots y versionado
**Decisión:** layouts, tarifas, planes, sitios y plantillas usan versiones inmutables al publicarse. Las operaciones guardan snapshots (tarifa, impuesto, cliente, plan, layout y regla del PIN). **Consecuencias:** cambiar la configuración nunca altera ventas ni facturas cerradas.

### ADR-011 · QR firmados
**Decisión:** el QR va firmado con Ed25519 usando una clave por tenant; la PWA verifica sin conexión. **Limitación aceptada:** el doble escaneo en dispositivos desconectados distintos solo se detecta al sincronizar.

### ADR-012 · Puertos para proveedores externos
**Decisión:** `EmailProvider`, `StorageProvider`, `PaymentProvider`, `EInvoicingProvider` y `MessagingProvider`. Las pruebas usan servidores de contrato locales; nunca se simulan cobros ni envíos en producción.

### ADR-013 · Identificadores
**Decisión:** UUID v7 como PK; códigos visibles por `document_sequences`; los códigos públicos de seguimiento no son secuenciales.

### ADR-014 · Núcleo comercial-financiero compartido, dominios operativos independientes (R2)
**Contexto:** el requerimiento lista pagos por módulo. Se quiere evitar tanto la duplicación como una entidad genérica que concentre la lógica.

**Decisión:**
- **Se comparte** solo el registro financiero: `sales`, `sale_lines`, `payments`, `payment_allocations`, `refunds`, `cash_*`, `fiscal_documents` y `tax_rules`.
- **No se comparte** la operación: `bookings`/`tickets`, `shipments`/`packages`/`transfers` y `cargo_orders`/`items`/`assignments` conservan sus propias entidades, máquinas de estado y reglas (precio, cancelación, política de reembolso, entrega).
- `sale_lines` solo guarda una FK tipada al origen (`CHECK num_nonnulls = 1`).
- El núcleo publica eventos (`SalePaid`, `SaleCancelled`, `RefundPaid`); cada dominio reacciona.
- No existe una entidad "Operación" ni "Servicio" genérica.

**Consecuencias:** la caja, la facturación, las comisiones y los reportes financieros se construyen una vez; los dominios evolucionan por separado. Ver [system-overview.md §5.1](system-overview.md#51-núcleo-compartido-frente-a-dominios-operativos-adr-014).

### ADR-015 · Facturación electrónica externa (R2)
**Contexto:** D2. **Decisión:** tres capas con dueño fijo.
1. **Contrato interno estable y versionado** (`CanonicalFiscalDocument` + puerto `EInvoicingProvider`, `packages/contracts/einvoicing/vN`, semver).
2. **Adaptador en código** (`adapter_ref` = `nombre@versión`), único responsable de la transformación del formato, con pruebas de contrato obligatorias.
3. **Configuración de conexión por tenant** (URL, rutas, autenticación, credenciales cifradas, timeout, ambiente, series), sin capacidad de alterar el formato.

Cada comprobante guarda el `contract_version` y el `adapter_ref` con los que se emitió y los reutiliza en las consultas posteriores. Emisión asíncrona e idempotente; estados independientes de la venta. **Bloqueo:** el adaptador se implementa tras documentar el contrato real. Ver [electronic-invoicing.md](../modules/electronic-invoicing.md).

### ADR-016 · Medición de usuarios (R2)
**Contexto:** D5. **Decisión:**
- Intervalos de `membership_status_history` con `effective_billable`. El historial es *append-only*, con fechas del servidor y sin escritura retroactiva (trigger).
- Día = día calendario en la zona horaria **fijada en el período de facturación**.
- Valor diario = **pico de membresías facturables simultáneas** (barrido +1/−1, salidas antes que entradas). También se guarda `distinct_active`.
- Período = `MAX` de los valores diarios (configurable por plan).
- Snapshots diarios `FINAL` idempotentes; período cerrado inmutable.

**Cambio R2:** antes se contaban las membresías distintas del día; ahora el valor por defecto es el pico simultáneo, que corresponde al ejemplo de D5. Ver [billing.md](../modules/billing.md).

### ADR-017 · PIN de entrega (R2)
**Decisión:**
- El remitente elige el PIN (validado como texto `^[0-9]{4}$`, sin autogeneración).
- Se guarda `Argon2id(HMAC-SHA256(pepper[v], tenant ‖ shipment ‖ pin))`, con el **pepper fuera de la base de datos** y versionado.
- Límite de intentos por encomienda (5 por defecto, de 3 a 10) con bloqueo, y límite de fallos por operador.
- Reemplazo solo por el remitente identificado, aprobado con `shipments.pin.reset` (cuatro ojos opcional) y auditado, con aviso sin la clave.
- Entrega excepcional sin PIN como procedimiento separado, **deshabilitado por defecto**, con supervisor distinto del operador, segunda autorización para valor declarado alto, registro inmutable y aviso al remitente.
- La regla se congela en `require_pin_snapshot`.
- Prohibido en respuestas, logs, notificaciones, tracking e impresos.

**Consecuencia:** la entrega con PIN requiere conexión. Ver [shipments.md §1](../modules/shipments.md#1-pin-de-entrega).

### ADR-018 · Impuestos como datos
**Decisión:** `tax_categories` + `tax_rules` por concepto, modalidad, zona tributaria y vigencia; snapshot en cada línea; ninguna tasa en el código. **Por validar:** catálogo inicial con un contador.

### ADR-019 · Datos personales
**Decisión:** cifrado de campo AES-256-GCM con versión de clave; índice ciego HMAC; visualización enmascarada; permiso `customers.pii.read` + registro de accesos; retención y ARCO como datos. YEBO actúa como encargado del tratamiento.

### ADR-020 · Módulos opcionales de canales, agencias y propietarios
**Decisión:** `sales_channels` siempre activo; `AGENCIES` y `OWNER_SETTLEMENTS` modelados y apagados por defecto; las ventas registran el canal, la agencia y el vendedor desde el día 1.

### ADR-021 · Catálogos frente a enums
**Decisión:** las categorías abiertas (tipos de vehículo, zonas, mercancía, eventos, incidencias) son tablas de catálogo; los `enum` se reservan para máquinas de estado y para valores que cambian reglas de código.

### ADR-022 · Hub de cuentas para login y cambio de empresa (nuevo)
**Contexto:** D3 exige una identidad en varias empresas, y cada empresa tiene su propio dominio, con lo que las cookies no pueden compartirse. **Decisión:**
- Un hub `cuentas.<dominio>` (en `apps/web`, presentado con la marca del tenant de origen) es el único lugar donde se introducen credenciales y MFA.
- Los dominios de empresa obtienen su sesión con OAuth 2.0 *authorization code* + PKCE + `state`, con `redirect_uri` derivado de un dominio verificado.
- Cambiar de empresa = un clic sin contraseña (step-up de MFA solo si la empresa de destino lo exige).

**Alternativas:** código de handoff de un solo uso (versión anterior: vulnerable a *login CSRF* sin un vínculo con el navegador); login directo en el dominio de la empresa sin hub visible (más white label, pero más complejo; se reevaluará con los dominios propios). **Por evaluar en la Fase 3:** `oidc-provider` frente a una implementación propia mínima.

### ADR-023 · Política de estados del tenant (nuevo)
**Decisión:**
- Cada endpoint de negocio se etiqueta con una categoría (`NEW_COMMERCIAL`, `FULFILL`, `AFTER_SALES`, `CASH`, `READ`, `EXPORT`, `CONFIGURE`, `CONFIGURE_COMPLIANCE`, `USERS_REDUCE`, `USERS_ADD`, `BILLING_SELF`) y `TenantStatusGuard` aplica la matriz de `plan_versions.suspension_policy`.
- `SUSPENDED`, `EXPIRED` y `CANCELLED` (periodo de cierre) bloquean **solo** `NEW_COMMERCIAL`, `CONFIGURE` y `USERS_ADD`.
- Embarcar, completar viajes, recibir y entregar encomiendas, cobrar saldos, devolver, emitir y consultar comprobantes siguen permitidos.
- **Defensa en profundidad:** el núcleo comercial rechaza nuevas ventas o líneas con importe positivo en esos estados, aunque un endpoint esté mal etiquetado.

Ver [multitenancy.md §5](multitenancy.md#5-estados-del-tenant-y-operaciones-permitidas).

---

## Precisiones de la aprobación (2026-11-05)

| Tema | Precisión aprobada | ADR afectados |
|---|---|---|
| Identidad | Hub en `cuentas.yebo.pe` con la identidad visual de la empresa de origen. Sesiones independientes por tenant, sin compartir cookies. Cambio de empresa sin contraseña si existe una sesión de identidad válida. La seguridad, la revocación y el aislamiento prevalecen sobre la personalización visual | 004, 009, 022 |
| Medición | Pico diario de cuentas humanas habilitadas simultáneamente, según intervalos de vigencia y la zona horaria fija. **No** se cuentan sesiones. Un reemplazo sin superposición no suma dos usuarios | 016 |
| Gracia y cierre | `PAST_DUE` → `SUSPENDED` a los 7 días; `CANCELLED` con 30 días de cierre; luego se cierra el acceso operativo y los datos se conservan según las obligaciones legales y la retención | 023 |
| Suspensión | Sin nuevas operaciones comerciales (envíos, pasajes, carga); se completan todas las obligaciones existentes | 023 |
| Entrega excepcional | Existe, deshabilitada por defecto, con verificación del destinatario, motivo, supervisor, segunda autorización para valor alto, evidencia, auditoría inmutable y aviso al remitente | 017 |
| PIN offline | La entrega con PIN requiere el backend. **Sin** alternativa offline | 017 |

---

## ADR de la Fase 2 (aceptados el 2026-11-05)

Surgen de las pruebas de concepto. Evidencia en [phase-2-results.md](../development/phase-2-results.md). No reemplazan ADR aceptados: precisan su implementación.

### ADR-024 · Restricciones de base de datos y Prisma Migrate (aceptado)
**Contexto:** en la PoC 2, Prisma Migrate eliminó en la siguiente migración generada las FK compuestas escritas a mano en SQL. **Decisión:**
- Toda FK, incluidas las compuestas `(tenant_id, x_id)`, se declara en el esquema Prisma.
- Lo que Prisma no modela (`EXCLUDE USING gist`, `CHECK`, políticas RLS, triggers) se escribe en migraciones SQL.
- Una prueba de integración ejecuta `prisma migrate diff` y falla si hay deriva entre las migraciones y el esquema, y entre una base real migrada y el esquema.
- **Precisión de la aprobación:** esta prueba es una verificación **obligatoria en CI** (`.github/workflows/ci.yml`, paso de integración).

**Afecta:** ADR-003, ADR-007.

### ADR-025 · Políticas RLS con `NULLIF` y contexto por transacción (aceptado)
**Contexto:** en una conexión del pool que ya usó `set_config('app.tenant_id', …, true)`, `current_setting('app.tenant_id', true)` devuelve `''` y no `NULL`, y `''::uuid` lanza `22P02`. **Decisión:** las políticas usan `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` en `USING` y `WITH CHECK`, de modo que la ausencia de contexto dé siempre 0 filas y nunca un error de conversión.

**Precisión de la aprobación:** cada transacción fija explícitamente su tenant con `set_config('app.tenant_id', …, true)` o `SET LOCAL`. El contexto **nunca** se hereda de una conexión anterior: se prohíben `SET`/`SET SESSION`, `set_config(…, false)` y los valores por defecto de rol o base de datos. Lo verifican una prueba estática (unitaria) y pruebas con una sola conexión reutilizada tras COMMIT, ROLLBACK y error.

**Afecta:** ADR-003, multitenancy §4.

### ADR-026 · Bloqueo ordenado de recursos antes de la exclusión GIST (aceptado)
**Contexto:** con solo `EXCLUDE USING gist`, dos ventas simultáneas de tramos superpuestos del mismo recurso no producen doble venta, pero en 23 de 40 rondas una abortó con `40P01` (deadlock, ~1 s de espera) en lugar de `23P01`. **Decisión:** antes de insertar asignaciones, la transacción bloquea los recursos hoja con `SELECT … ORDER BY id FOR NO KEY UPDATE`. Las ventas en competencia esperan en orden. La restricción de exclusión sigue siendo la garantía, y el bloqueo solo la hace predecible. Las capacidades agregadas mantienen el bloqueo ordenado `(pool_id, segment_seq)` ya aprobado.

**Precisión de la aprobación:** el orden de los bloqueos es determinista (recursos por `id`, luego pools por `(pool_id, segment_seq)`). Los conflictos de disponibilidad se traducen en errores de dominio controlados (`ResourceUnavailableError`, `CapacityExceededError`), nunca en errores internos ni interbloqueos. En la API se expondrán como `409` con el formato de error único (Fase 8).

**Alternativas:** reintentar ante `40P01` (más latencia y más código); `SERIALIZABLE` (descartado en ADR-007).

**Afecta:** ADR-007, capacity-and-inventory §3.

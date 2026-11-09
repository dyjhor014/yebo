# Seguridad y protección de datos personales

## 1. Autenticación

| Elemento | Diseño |
|---|---|
| Contraseñas | Argon2id (parámetros OWASP vigentes; recalibrar en la Fase 3). Política de longitud mínima de 10, verificación contra listas de contraseñas filtradas (k-anonymity opcional). |
| Flujo de login y cambio de empresa | Hub de cuentas con *authorization code* + PKCE. Detalle en [identity-and-sessions.md](identity-and-sessions.md). |
| Access token | JWT firmado (EdDSA o ES256), 10 min, *claims* mínimos (`sub`, `sid`, `tid`, `mid`, `ver`). |
| Refresh token | Opaco, 256 bits, **hasheado** (SHA-256) en `refresh_tokens`, rotado en cada uso, con una ventana de gracia de 20 s para pestañas concurrentes. Durante la gracia, el sucesor se guarda solo **cifrado** (AES-256-GCM con una clave HKDF del token padre, Fase 3.2a). Si se reutiliza un token ya rotado fuera de la ventana, se revoca la sesión de empresa completa (detección de robo). |
| Transporte en web | Cookies `httpOnly`, `Secure`, `SameSite=Lax`, ligadas al host. Protección CSRF con *double submit token* en mutaciones (decisión D10). |
| Transporte en PWA operativa e integraciones | `Authorization: Bearer`. Dispositivos registrados (`devices`) para operación offline. |
| Cuentas de servicio | `service_accounts` por tenant con API keys hasheadas, alcances explícitos y sin facturación (D5). |
| MFA | TOTP opcional por usuario; obligatorio para staff de plataforma y configurable por tenant para roles administrativos. |
| Fuerza bruta | Rate limit por IP + identificador (Redis), bloqueo progresivo, misma respuesta para usuario inexistente o contraseña errónea. |
| Revocación | Surte efecto en toda verificación que empiece tras su COMMIT: el estado de la sesión se verifica **en PostgreSQL** en cada request (precisión de la Fase 3.2a: sin caché positiva en Redis). Matriz de eventos en [identity-and-sessions.md §8](identity-and-sessions.md#8-revocación). |

## 2. Autorización

- **RBAC por membresía.** Los permisos son un catálogo global de códigos (`shipments.deliver`, `customers.pii.read`, `einvoicing.config.manage`...). Los roles son por tenant, creados a partir de **plantillas** de la plataforma (Administrador, Cajero, Almacenero, Embarque, Contador...) que el tenant puede copiar y ajustar.
- **Ámbito de sucursal**: una membresía puede limitarse a ciertas sucursales y almacenes (`membership_branch_scopes`). Los servicios filtran por ese ámbito además del tenant.
- **Superadmin**: permisos de plataforma separados (`platform.tenants.suspend`...), sin acceso a datos operativos de tenants salvo mediante `support_access_grants`.
- Guard por endpoint con `@RequirePermission(...)`. Las reglas de pertenencia (p. ej., "solo el cajero que abrió la caja puede cerrarla") se aplican en los servicios.
- **Fase 3.3 (2026-11-10): denegar por defecto.** Una cadena de guards globales (host → autenticación → permiso → estado del tenant) protege toda ruta sin `@Public(...)`. Las rutas públicas están en una lista blanca versionada y ESLint impide declararlas fuera de los módulos autorizados. Asignar roles exige tener todos los permisos de los roles asignados y retirados (anti-escalada), y nadie puede cambiar sus propios roles ni suspenderse. Detalle en [phase-3-plan](../development/phase-3-plan.md).

## 3. Protecciones de plataforma

Helmet; CORS con lista blanca derivada de `tenant_domains` verificados; límites de tamaño del cuerpo; validación Zod en todas las entradas; Prisma parametrizado (SQL crudo solo con `Prisma.sql`); CSP estricta en las apps web; endpoints públicos (tracking, booking, site) con rate limit propio y CAPTCHA en formularios abusables; validación de archivos (sección 6.3 de la arquitectura); errores sin *stack traces* hacia el cliente.

## 4. Secretos y datos cifrados

| Dato | Tratamiento |
|---|---|
| Contraseñas | Argon2id |
| Refresh tokens, API keys, códigos de un solo uso | SHA-256 (alta entropía, no requieren un KDF lento) |
| **PIN de entrega (4 dígitos)** | **HMAC-SHA256 con *pepper* del servidor + Argon2id.** Con solo 10 000 combinaciones, un hash sin *pepper* se rompería al instante si se filtrara la base de datos. El *pepper* vive fuera de la base de datos (variable de entorno o KMS). Límite de intentos y bloqueo. Nunca se muestra, registra en logs ni notifica. Especificación completa en [shipments.md §1](../modules/shipments.md#1-pin-de-entrega). |
| Credenciales de la API de facturación por tenant | **Cifrado de sobre**: AES-256-GCM con una DEK por registro, envuelta por una KEK de entorno o KMS. Se descifran solo en el worker al emitir. Nunca se devuelven al frontend (solo se muestran los últimos 4 caracteres) ni se registran. |
| DNI, RUC de personas naturales, teléfono, dirección | Cifrado a nivel de campo (AES-256-GCM) + **índice ciego** (HMAC) para búsqueda exacta. Visualización enmascarada por defecto (`****5678`). |
| Secretos de infraestructura | Variables de entorno inyectadas en el despliegue. Nunca en el repositorio. `.env.example` sin valores reales. |

Rotación: las claves llevan `key_version` en el dato cifrado para poder rotarlas sin descifrar todo a la vez.

## 5. Protección de datos personales (Ley N.º 29733 y su reglamento)

> Diseño técnico de soporte al cumplimiento. La adecuación legal (inscripción de bancos de datos ante la ANPD, textos de consentimiento, contratos de encargo de tratamiento entre YEBO y cada empresa) debe validarse con un asesor legal.

**Roles.** Cada empresa (tenant) es **titular del banco de datos** de sus clientes. YEBO actúa como **encargado del tratamiento**. Esto refuerza la decisión D4: no hay directorio global de clientes.

| Obligación | Soporte en YEBO |
|---|---|
| Finalidades y bases legales | `data_processing_purposes` por tenant (a partir del catálogo de plataforma): finalidad, base legal (contrato, obligación legal, consentimiento) y categorías de datos. |
| Información y consentimiento | `consent_records`: titular (cliente), finalidad, versión del texto mostrado, canal, fecha y revocación. Solo se exige cuando la base legal es el consentimiento (p. ej., marketing); la ejecución del contrato de transporte no lo requiere. |
| Minimización | Campos personales **opcionales por defecto**, activados por configuración según la operación. Ejemplo: el documento del destinatario solo se pide si la empresa exige identificación en la entrega. |
| Control de acceso | Permiso `customers.pii.read` para ver el dato completo. Cada revelación queda en `personal_data_access_logs`. |
| Conservación y eliminación | `data_retention_policies` por tenant y categoría (clientes inactivos, documentos de entrega, registros de embarque) con acción `ANONYMIZE` o `DELETE`, ejecutadas por un job. Las obligaciones tributarias y de transporte prevalecen: los datos de comprobantes no se borran antes del plazo legal. |
| Derechos ARCO | `data_subject_requests`: tipo (acceso, rectificación, cancelación, oposición), titular, verificación de identidad, plazos, responsable, resolución y evidencias. |
| Auditoría | `audit_logs` + `personal_data_access_logs`. |
| Seguridad | Cifrado de campo, TLS, cifrado de backups, control de acceso y registro de incidentes de seguridad. |
| Portal público de seguimiento | Proyección pública sin datos personales (solo iniciales del destinatario, si la empresa lo habilita). |

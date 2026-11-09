# Diccionario de datos

**Columnas comunes (no se repiten en las tablas):** `id uuid PK` (v7), `tenant_id uuid NOT NULL` (salvo 🌐), `created_at timestamptz`, `updated_at timestamptz`.

**Notación:**
- `→ tabla` = FK (compuesta con `tenant_id` en tablas de tenant).
- `?` = nullable.
- `enc` = cifrado a nivel de campo.
- `bidx` = índice ciego HMAC.
- `snap` = snapshot JSON validado por un esquema Zod versionado (`schema_version` dentro del JSON).

Los `enum` son cerrados; los `→ catálogo` son tablas extensibles.

---

## 1. Plataforma SaaS

### 🌐 tenants
| Columna | Tipo | Notas |
|---|---|---|
| slug | citext UNIQUE | Subdominio por defecto |
| legal_name | text | Razón social |
| trade_name | text | Nombre comercial |
| tax_id_type, tax_id | text | RUC u otro; UNIQUE (tax_id_type, tax_id) |
| fiscal_address, phones, emails | text / jsonb | Contactos validados por esquema |
| status | enum `TRIAL, ACTIVE, PAST_DUE, SUSPENDED, CANCELLED, EXPIRED` | Solo cambia por máquina de estados + `tenant_status_history` |
| timezone | text | Default `America/Lima` |
| default_currency | char(3) | `PEN` |
| trial_ends_at, activated_at, cancelled_at | timestamptz? | |
| status_changed_at | timestamptz | Inicio del estado vigente; desde él se cuentan los días de gracia de `PAST_DUE` (Fase 4.3a) |

### 🌐 tenant_domains
`tenant_id → tenants`, `host citext UNIQUE`, `kind enum SUBDOMAIN|CUSTOM`, `is_primary bool` (único parcial por tenant), `verification_status enum PENDING|VERIFIED|FAILED`, `verified_at?`.

### tenant_settings (1:1)
`require_delivery_pin bool NOT NULL DEFAULT false` · `delivery_pin_max_attempts int DEFAULT 5` · `booking_hold_minutes int` · `allow_partial_payments bool` · `require_recipient_id_on_delivery bool` · `exceptional_delivery_enabled bool DEFAULT false` · `exceptional_delivery_second_approval_threshold numeric(14,2)?` · `exceptional_delivery_required_evidence text[]` · `public_tracking_show_recipient_initials bool` · `settings jsonb` (resto, validado por esquema). PK `tenant_id`. Valores iniciales del alta en [phase-4-plan](../development/phase-4-plan.md) (4.3a).

### tenant_services
`modality enum LAND|RIVER` · `service enum PASSENGER|PARCEL|CARGO|VEHICLE_TRANSPORT` · `enabled bool`. UNIQUE (tenant_id, modality, service). Nuevas modalidades = nuevo valor del enum vía migración (decisión consciente: la modalidad cambia reglas de negocio). Un módulo de servicio del plan solo es efectivo si la empresa opera ese servicio (multitenancy §6).

### tenant_status_history
`from_status?` (nulo = alta), `to_status`, `reason text`, `actor_platform_user_id?` (nulo = job de estados), `occurred_at`. Append-only (trigger). RLS de tenant.

### tenant_operation_overrides
`category enum USERS_ADD`, `valid_from`, `valid_to` (obligatorio; como mucho 30 días), `reason`, `granted_by_platform_user_id`, `ended_at?`, `ended_by_platform_user_id?`. Excepción temporal de YEBO a la matriz de estados (multitenancy §5.2, nota 2), solo en `SUSPENDED` y `EXPIRED`. Decisión del 2026-11-10 (Fase 4.3a).

### 🌐 modules
`code text UNIQUE` (`PASSENGERS`, `PARCELS`, `CARGO`, `VEHICLE_TRANSPORT`, `EINVOICING`, `AGENCIES`, `OWNER_SETTLEMENTS`, `WHITE_LABEL`, `OFFLINE_OPS`…), `name`, `description`, `is_active`.

### 🌐 plans / plan_versions / plan_version_modules
- **plans:** `code UNIQUE`, `name`, `description`, `status enum DRAFT|ACTIVE|RETIRED`.
- **plan_versions:** `plan_id → plans`, `version int` (UNIQUE plan_id+version), `status enum DRAFT|PUBLISHED|RETIRED`, `currency`, `base_price numeric(14,2)`, `billing_interval enum MONTHLY|QUARTERLY|YEARLY`, `included_users int`, `extra_user_price numeric(14,2)`, `usage_metric enum PEAK_DAILY|AVERAGE_DAILY|END_OF_PERIOD` (default `PEAK_DAILY`, D5), `daily_aggregation enum PEAK_CONCURRENT|DISTINCT_ACTIVE` (default `PEAK_CONCURRENT`), `min_active_seconds int DEFAULT 0`, `trial_days int`, `limits jsonb` (sucursales, vehículos, almacenamiento GB; esquema validado), `suspension_policy jsonb` (por defecto: 7 días de gracia en PAST_DUE, 30 días de cierre en CANCELLED, matriz de operaciones de multitenancy §5), `published_at`, `retired_at`, `created_by_id → platform_users`. **Inmutable al publicarse** (trigger: solo admite `PUBLISHED → RETIRED`; sus módulos tampoco cambian). Implementado en la Fase 4.2.
- **plan_version_modules:** `plan_version_id`, `module_id`, `config jsonb?`. PK compuesta.

### tenant_module_overrides
`module_id → modules`, `effect enum GRANT|REVOKE`, `valid_from`, `valid_to?`, `reason`, `granted_by_platform_user_id`, `ended_at?`, `ended_by_platform_user_id?`. No se borra: se termina y queda en el historial. REVOKE gana sobre GRANT.

### subscriptions
`plan_version_id → plan_versions`, `status enum TRIALING|ACTIVE|PAST_DUE|SUSPENDED|CANCELLED|EXPIRED`, `current_period_start`, `current_period_end`, `cancel_at?`, `grace_until?`, `price_override jsonb?` (acuerdos comerciales especiales, auditado). Una sola suscripción vigente: `is_current` (TRUE o NULL, con CHECK) y `UNIQUE (tenant_id, is_current)`; sustituye al índice único parcial por estado, que Prisma no representa (prueba de deriva, ADR-024).

### billing_periods
`subscription_id`, `period_start date`, `period_end date` (fechas locales), `timezone text` (copiada del tenant al abrir; fija durante el período), `status enum OPEN|CLOSING|CLOSED`. UNIQUE (subscription_id, period_start). Tras `CLOSED`, un trigger bloquea cambios en el período, sus snapshots y su cálculo. Fase 4.5: `period_end` exclusivo, `is_trial`, `closed_at`, `cut_off?` (upgrade a mitad de período: fin real y prorrateo); de tenant (RLS). `subscriptions.next_plan_version_id?`: downgrade programado para el período siguiente.

### usage_daily_snapshots
`usage_date date`, `timezone text`, `day_range tstzrange`, `peak_concurrent int`, `distinct_active int`, `status enum PROVISIONAL|FINAL`, `algorithm_version int`, `detail jsonb` (IDs de membresías contadas e intervalos), `computed_at`. UNIQUE (tenant_id, usage_date). Ver [billing.md](../modules/billing.md). Fase 4.4: solo se guardan los `FINAL` (inmutables por trigger); el día en curso se calcula al vuelo como `PROVISIONAL`. `detail` = intervalos recortados al día y `minActiveSeconds` aplicado.

### usage_period_calculations
`billing_period_id UNIQUE`, `usage_metric`, `daily_aggregation`, `metric_value int` (p. ej. pico), `included_users`, `extra_users`, `base_amount`, `extra_amount`, `total_amount`, `currency`, `plan_version_snapshot snap`, `daily_series jsonb`, `computed_at`. Inmutable.

### platform_invoices / platform_invoice_lines / subscription_payments
- **platform_invoices:** `code UNIQUE`, `billing_period_id?`, `status enum DRAFT|ISSUED|PAID|PARTIALLY_PAID|VOID|OVERDUE`, `issue_date`, `due_date`, `currency`, `subtotal`, `tax`, `total`, `balance`, `fiscal_document_ref jsonb?` (comprobante emitido por YEBO a la empresa, vía el mismo puerto de facturación con la configuración de la plataforma).
- **lines:** `kind enum BASE|EXTRA_USERS|ADDON|ADJUSTMENT|CREDIT`, `description`, `quantity`, `unit_price`, `amount`.
- **subscription_payments:** `platform_invoice_id`, `amount`, `method`, `reference`, `paid_at`, `recorded_by_platform_user_id`, `evidence_asset_id?`, `status enum CONFIRMED|REVERSED`. Registro manual en el MVP (sin pagos simulados). Fase 4.5: las tres tablas son de tenant (RLS); código de factura `YB-AAAAMM-XXXXXXXX`; importes de la factura inmutables (solo cambian estado y saldo); `plan_versions.payment_terms_days` y `tax_rate` (0 hasta validar S5).

### support_incidents / incident_comments / incident_events / incident_attachments
- **support_incidents:** `code UNIQUE`, `reported_by_membership_id?`, `reported_by_platform_user_id?`, `category → incident_categories (catálogo)`, `priority enum LOW|MEDIUM|HIGH|CRITICAL`, `status enum OPEN|IN_PROGRESS|WAITING_CUSTOMER|RESOLVED|CLOSED`, `title`, `description`, `assignee_platform_user_id?`, `resolved_at?`, `closed_at?`.
- **comments:** `author_kind`, `author_id`, `body`, `visibility enum PUBLIC|INTERNAL`.
- **events:** cambios de estado, asignación y prioridad (append-only).
- **attachments:** `file_asset_id`.

### 🌐 platform_users / support_access_grants
- **platform_users:** `email citext UNIQUE`, `password_hash`, `mfa_secret enc`, `status`, `platform_role` (o una tabla de roles de plataforma).
  - *Fase 4.1 (2026-11-10):* `role enum SUPERADMIN|BILLING|SUPPORT|VIEWER` (permisos `platform.*` en código), `status enum ACTIVE|DISABLED`, `password_hash?` (nulo hasta usar el enlace de configuración), `mfa_secret_ciphertext` + `mfa_key_version` (AES-256-GCM), `mfa_enabled_at?`, `mfa_last_step?` (anti-reutilización TOTP), `created_by_id?`. Tablas nuevas: **`platform_sessions`** (hash SHA-256 del token opaco, caducidades, revocación), **`platform_setup_tokens`** (enlace de un solo uso, ≤ 72 h) y **`platform_audit_logs`** (append-only; `tenant_id?` de la empresa afectada). Solo `yebo_backoffice`.
- **support_access_grants:** `tenant_id`, `platform_user_id`, `reason`, `incident_id?`, `scope enum READ_ONLY|FULL`, `starts_at`, `expires_at`, `revoked_at?`, `approved_by_membership_id?` (si la empresa exige aprobación).
  - *Fase 4.6 (2026-11-10):* de tenant (RLS), no global; ventana ≤ 8 h; copia de `staff_name` y `staff_email`; `requires_approval`, `approved_at?`, `revoked_by_kind?` y `revoked_by_id?`. Tablas nuevas: **`support_handoffs`** (código de un solo uso, 60 s), **`support_sessions`** (sesión opaca, 30 min de inactividad) y **`support_access_logs`** (cada petición, append-only). `tenant_settings.support_requires_approval`. `incident_id` queda fuera (F4-Q5).

## 2. Identidad y acceso

### 🌐 users
`email citext UNIQUE`, `email_verified_at?`, `password_hash text` (Argon2id), `full_name`, `phone? enc`, `mfa_secret? enc`, `mfa_enabled bool`, `status enum ACTIVE|DISABLED|LOCKED`, `last_login_at?`, `password_changed_at`.

### tenant_memberships
`user_id → users`, `status enum INVITED|ACTIVE|SUSPENDED|REVOKED`, `kind enum HUMAN` (reservado para extensiones), `billable bool DEFAULT true` (solo modificable por la plataforma), `display_name?`, `default_branch_id?`, `permissions_version int`, `agency_id?` (si es usuario de agencia externa). UNIQUE (tenant_id, user_id).

### membership_status_history
`membership_id`, `status`, `billable bool`, `user_active bool`, `effective_billable bool` (ACTIVE ∧ billable ∧ usuario activo), `valid_from timestamptz` (siempre `now()` del servidor), `valid_to timestamptz?`, `user_id`, `changed_by_kind enum MEMBERSHIP|USER|PLATFORM_USER|SYSTEM`, `changed_by_id?` (solo `SYSTEM` sin id), `reason?`. **Fuente de la medición D5.** Implementado en la Fase 4.4: la escriben triggers `SECURITY INVOKER` en `tenant_memberships` y `users`, en la misma transacción que el cambio; `effective_billable` lo garantiza un `CHECK`. El autor lo declara cada servicio en la transacción y lo copian los triggers; sin autor, un rol de ejecución no puede cambiar membresías ni usuarios. `EXCLUDE USING gist (membership_id WITH =, tstzrange(valid_from, valid_to) WITH &&)`; un trigger impide fechas retroactivas, `DELETE` y cualquier `UPDATE` que no sea cerrar `valid_to` de la fila vigente.

### roles / role_permissions / membership_roles / 🌐 role_templates / 🌐 permissions
- **permissions 🌐:** `code text UNIQUE` (`shipments.deliver`), `module_code`, `description`, `is_sensitive bool`.
- **role_templates 🌐:** `code`, `name`, `permission_codes text[]`.
- **roles:** `name`, `template_id?`, `is_system bool`, `archived_at?`. UNIQUE (tenant_id, name).
- **role_permissions:** (`role_id`, `permission_id`) PK.
- **membership_roles:** (`membership_id`, `role_id`) PK.

### membership_branch_scopes
(`membership_id`, `branch_id`) PK. Si no hay filas, la membresía accede a todas las sucursales.

### membership_invitations
`email citext` (normalizado), `role_ids uuid[]` (1–20), `token_hash bytea` (SHA-256 del secreto, UNIQUE), `expires_at` (72 h; máximo 7 días por CHECK), `invited_by_membership_id?` **o** `invited_by_platform_user_id?` (exactamente uno), `accepted_at?`, `accepted_membership_id?`, `revoked_at?`, `created_at`. RLS de tenant: el token del enlace lleva el id del tenant (`<tenant>.<secreto>`) para fijar el contexto antes de buscar el hash. Fase 4.3b.

### 🌐 identity_sessions / tenant_sessions / refresh_tokens / authorization_codes / password_reset_tokens
Ver [identity-and-sessions.md](../architecture/identity-and-sessions.md).
- **identity_sessions:** `user_id`, `ip`, `user_agent`, `mfa_verified_at?`, `auth_methods text[]`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at?`, `revoke_reason?`. Cookie `__Host-yebo_hub` (solo el hub).
- **tenant_sessions:** `identity_session_id`, `user_id`, `tenant_id`, `membership_id`, `host`, `device_id?`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at?`, `revoke_reason?`.
  - FK compuestas `(identity_session_id, user_id)` → `identity_sessions` y `(tenant_id, user_id, membership_id)` → `tenant_memberships`.
  - **Excepción global con `tenant_id`** (sin RLS de tenant).
  - Se verifica en PostgreSQL en cada request (Fase 3.2a: sin réplica en Redis).
- **refresh_tokens:** `tenant_session_id` (= familia), `token_hash bytea UNIQUE` (SHA-256, 32 bytes), `parent_id?` (FK compuesta a la misma sesión; `UNIQUE (tenant_session_id, parent_id)` = un único sucesor), `rotated_at?` (ventana de gracia de 20 s), `successor_ciphertext bytea?` (sucesor cifrado, 61 bytes, solo en tokens rotados), `expires_at`, `revoked_at?`.
  - *Fase 3.2a:* `successor_id` no existe; el sucesor se obtiene por `parent_id`.
- **Privilegios (Fase 3.2a):** las tres tablas, solo con `yebo_identity` (SELECT, INSERT, UPDATE; sin DELETE). `revoke_reason` es el enum `session_revoke_reason`.
- **authorization_codes:** `code_hash bytea UNIQUE` (SHA-256, 32 bytes), `user_id`, `tenant_id`, `identity_session_id` (FK compuesta con `user_id`), `redirect_uri` (CHECK: `https://<redemption_host>/auth/callback`), `redemption_host citext`, `code_challenge` (43 caracteres), `code_challenge_method` (CHECK `S256`), `expires_at` (60 s; CHECK ≤ 65 s), `consumed_at?`, `tenant_session_id?` (sesión emitida; se revoca si el código se reutiliza).
  - *Fase 3.2b:* excepción global con `tenant_id`; solo `yebo_identity` (SELECT, INSERT, UPDATE).
- **password_reset_tokens:** `token_hash`, `user_id`, `expires_at`, `used_at?`.

### service_accounts / api_keys
- **service_accounts:** `name`, `scopes text[]`, `status`.
- **api_keys:** `service_account_id`, `prefix`, `key_hash UNIQUE`, `last_used_at`, `expires_at?`, `revoked_at?`. Nunca facturables.

### devices
`name`, `kind enum POS|BOARDING_PWA|WAREHOUSE_SCANNER`, `public_key`, `registered_by_membership_id`, `branch_id?`, `status enum ACTIVE|REVOKED`, `last_sync_at?`.

## 3. Organización y canales

### locations
`name`, `kind → location_kinds (catálogo: ciudad, puerto, embarcadero, terminal)`, `ubigeo?`, `region?`, `lat?`, `lng?`, `tax_zone_code?` (para reglas tributarias regionales), `archived_at?`.

### branches
`location_id`, `code`, `name`, `address`, `phones jsonb`, `is_pickup_point bool`, `is_reception_point bool`, `archived_at?`. UNIQUE (tenant_id, code).

### warehouses / warehouse_bins
- **warehouses:** `branch_id?`, `code`, `name`, `kind enum AGENCY|SORTING_CENTER|DEPOT`, `archived_at?`.
- **warehouse_bins:** `warehouse_id`, `code`, `description`.

### sales_channels
`code`, `name`, `kind enum COUNTER|ONLINE|EXTERNAL_AGENCY|CALL_CENTER|API`, `branch_id?`, `is_active`.

### agencies (módulo `AGENCIES`, D7 — por validar)
`sales_channel_id`, `legal_name`, `tax_id`, `contact jsonb`, `status enum ACTIVE|SUSPENDED|TERMINATED`, `settlement_frequency?`.

### agency_commission_rules
`agency_id`, `service enum`, `route_id?`, `calc enum PERCENT|FIXED_PER_UNIT`, `value numeric`, `valid_from`, `valid_to?`, `priority int`.

### agency_users
(`agency_id`, `membership_id`). Permite identificar al vendedor de agencia.

### document_sequences
`scope text` (`TICKET`, `SHIPMENT`, `PACKAGE`, `TRANSFER`, `CARGO`, `SALE`, `MANIFEST`), `branch_id?`, `prefix`, `next_value bigint`, `padding int`. UNIQUE (tenant_id, scope, branch_id) con `NULLS NOT DISTINCT`. Incremento con `UPDATE … RETURNING`.

## 4. Flota y layouts

### 🌐 vehicle_type_catalog / vehicle_types
- **vehicle_type_catalog 🌐:** sugerencias (bus, minivan, auto, lancha, motonave…).
- **vehicle_types:** `name`, `modality enum LAND|RIVER`, `catalog_id?`, `attributes_schema jsonb?`. Abierto y extensible por el tenant.

### vehicles
`code`, `name`, `vehicle_type_id`, `registration_id` (placa o matrícula), `modality`, `status enum ACTIVE|MAINTENANCE|OUT_OF_SERVICE|RETIRED`, `ownership enum OWN|THIRD_PARTY`, `nominal_capacity jsonb` (pasajeros, kg, m³), `features jsonb`, `photo_asset_ids uuid[]`. UNIQUE (tenant_id, code) y (tenant_id, registration_id).

### vehicle_documents
`vehicle_id`, `doc_type → catálogo` (SOAT, revisión técnica, certificado de matrícula, certificado de seguridad), `number`, `issued_at?`, `expires_at?`, `file_asset_id?`.

### vehicle_layouts / layout_versions
- **vehicle_layouts:** `name`, `modality`, `vehicle_type_id?`, `archived_at?`.
- **layout_versions:** `layout_id`, `version int`, `status enum DRAFT|PUBLISHED|ARCHIVED`, `decks int`, `canvas jsonb` (ancho, alto, grilla), `background_asset_id?` (PNG/JPG/SVG solo como referencia visual), `published_at?`. **Inmutable al publicarse** (trigger). UNIQUE (layout_id, version).

### layout_zones
`layout_version_id`, `code`, `name`, `kind → zone_kinds (catálogo: SEATING, VIP, FREE_ZONE, HAMMOCK, LUGGAGE, HOLD, CARGO_DECK, VEHICLE_DECK)`, `service enum`, `allocation_mode enum ASSIGNED|POOLED`, `deck int`, `geometry jsonb`, `price_class_code?`, `constraints jsonb` (largo/ancho/alto máximos, kg por unidad, kg/m², rampa).

### layout_elements
`layout_version_id`, `zone_id?`, `parent_element_id?` (camarote → camas), `kind enum SEAT|BED|CABIN|VEHICLE_SLOT|AISLE|STAIRS|DOOR|WC|LABEL|OTHER`, `code` (p. ej. `12A`, `C3-B1`), `is_assignable bool` (un camarote con camas hijas no es asignable: se vende asignando todas sus camas, ver capacity-and-inventory §3 ej. D), `sellable_as_unit bool` (permite vender el camarote completo), `x`, `y`, `w`, `h`, `rotation numeric`, `deck int`, `capacity int` (cama compartida = 2), `price_class_code?`, `attributes jsonb`. UNIQUE (layout_version_id, code).

### capacity_rules
`zone_id`, `dimension enum PERSONS|UNITS|WEIGHT_KG|VOLUME_M3|LINEAR_M`, `capacity numeric(14,3)`.

### vehicle_layout_assignments
`vehicle_id`, `layout_version_id` (PUBLISHED), `valid_from`, `valid_to?`. Exclusión de solapamiento por vehículo.

### vehicle_owners / settlement_schemes / vehicle_ownership_agreements (módulo `OWNER_SETTLEMENTS`, D6 — por validar)
- **vehicle_owners:** `party_kind enum PERSON|COMPANY`, `name`, `doc_type`, `doc_number enc` + `bidx`, `contact jsonb enc`, `bank_info jsonb enc?`.
- **settlement_schemes:** `code` (`PERCENT_OF_REVENUE`, `FIXED_PER_TRIP`, `HYBRID`…), `params_schema jsonb`, `is_active`. Nuevos esquemas = datos + validador de código.
- **vehicle_ownership_agreements:** `vehicle_id`, `owner_id`, `scheme_id`, `params jsonb` (validado contra `params_schema`), `valid_from`, `valid_to?`, `status`.

## 5. Rutas, programación y viajes

### routes / route_stops
- **routes:** `code`, `name`, `modality`, `status enum ACTIVE|ARCHIVED`.
- **route_stops:** `route_id`, `seq int`, `location_id`, `offset_minutes int` (desde el origen), `dwell_minutes int`, `distance_km?`, `allows_boarding bool`, `allows_alighting bool`. UNIQUE (route_id, seq).

### fares
`route_id`, `origin_location_id`, `destination_location_id`, `service enum`, `price_class_code` (GENERAL, VIP, CAMA, CAMAROTE, HAMACA…), `channel_kind?`, `currency`, `amount`, `valid_from`, `valid_to?`, `status`. Índice (tenant_id, route_id, origin, destination, price_class_code, valid_from).

### schedules
`route_id`, `recurrence text` (RRULE validada), `departure_local_time time`, `timezone`, `default_vehicle_id?`, `default_layout_version_id?`, `service_mode enum SHARED|PRIVATE`, `valid_from`, `valid_to?`, `status`.

### trips
`code`, `route_id`, `schedule_id?`, `departure_kind enum SCHEDULED|ON_DEMAND`, `service_mode enum SHARED|PRIVATE`, `vehicle_id?`, `layout_version_id?` (obligatorio antes de vender), `status enum PLANNED|OPEN_FOR_SALE|CONFIRMED|BOARDING|DEPARTED|ARRIVED|CLOSED|CANCELLED`, `min_passengers?`, `confirmation_deadline?`, `planned_departure_at`, `actual_departure_at?`, `planned_arrival_at?`, `actual_arrival_at?`, `cancel_reason?`.

### trip_stops
`trip_id`, `seq int`, `location_id`, `planned_arrival_at?`, `planned_departure_at?`, `actual_arrival_at?`, `actual_departure_at?`, `allows_boarding`, `allows_alighting`. UNIQUE (trip_id, seq). Copiadas de la ruta al crear el viaje.

### trip_resources
`trip_id`, `layout_element_id`, `parent_trip_resource_id?`, `code`, `kind`, `zone_code`, `price_class_code?`, `capacity int`, `is_sellable bool`. UNIQUE (trip_id, code).

### trip_capacity_pools / trip_pool_segment_usage / pool_allocations
- **trip_capacity_pools:** `trip_id`, `scope enum ZONE|VEHICLE`, `zone_code?` (NULL cuando `scope = VEHICLE`: aforo total de la unidad, que consume toda venta de pasajero), `dimension`, `capacity numeric(14,3)`. UNIQUE (trip_id, scope, zone_code, dimension) con `NULLS NOT DISTINCT`. Filas de `trip_pool_segment_usage` materializadas al abrir la venta.
- **trip_pool_segment_usage:** PK (`pool_id`, `segment_seq`), `capacity`, `used`, `CHECK (used BETWEEN 0 AND capacity)`.
- **pool_allocations:** `pool_id`, `stop_range int4range`, `quantity numeric(14,3)`, `status enum HELD|CONFIRMED|RELEASED`, `hold_expires_at?`, `holder_type enum BOOKING_ITEM|TRANSFER|CARGO_ASSIGNMENT|BLOCK`, `holder_id`.

### resource_allocations
`trip_id`, `trip_resource_id`, `stop_range int4range`, `status enum HELD|CONFIRMED|RELEASED`, `hold_expires_at?`, `holder_type enum BOOKING_ITEM|CARGO_ASSIGNMENT|BLOCK`, `holder_id`. **`EXCLUDE USING gist (trip_resource_id WITH =, stop_range WITH &&) WHERE (status <> 'RELEASED')`** (SQL de migración, requiere `btree_gist`).

### trip_vehicle_changes / trip_incidents
- **trip_vehicle_changes:** `from_vehicle_id?`, `to_vehicle_id`, `from_layout_version_id?`, `to_layout_version_id`, `mapping jsonb`, `conflicts jsonb`, `reason`, `approved_by_membership_id`.
- **trip_incidents:** `type → catálogo`, `description`, `occurred_at`, `stop_seq?`, `reported_by`, `offline_client_id?`.

## 6. Clientes y datos personales

### customers
`party_kind enum PERSON|COMPANY`, `full_name`, `doc_type?` (catálogo SUNAT 06 de tipos de documento), `doc_number? enc`, `doc_number_bidx?`, `email? enc`, `email_bidx?`, `phone? enc`, `phone_bidx?`, `address? enc`, `birth_date?` (solo si una norma lo exige), `nationality?`, `anonymized_at?`. UNIQUE parcial (tenant_id, doc_type, doc_number_bidx) WHERE doc_number_bidx IS NOT NULL.

### 🌐 data_processing_purpose_catalog / data_processing_purposes / consent_records / data_retention_policies / data_subject_requests / personal_data_access_logs
- **purposes:** `code`, `description`, `legal_basis enum CONTRACT|LEGAL_OBLIGATION|CONSENT|LEGITIMATE_INTEREST`, `data_categories text[]`, `active`.
- **consent_records:** `customer_id`, `purpose_id`, `granted bool`, `text_version`, `channel`, `captured_by_membership_id?`, `granted_at`, `revoked_at?`.
- **retention_policies:** `data_category`, `retention_days`, `action enum ANONYMIZE|DELETE`, `legal_hold_reason?`.
- **subject_requests:** `customer_id?`, `requester_name`, `type enum ACCESS|RECTIFICATION|CANCELLATION|OPPOSITION`, `status`, `received_at`, `due_at`, `resolution`, `evidence_asset_ids uuid[]`.
- **access_logs:** `membership_id`, `customer_id`, `field`, `purpose`, `accessed_at`. Append-only, particionada.

## 7. Ventas, pagos, caja e impuestos

### tax_categories / tax_rules (por validar con contador, S5)
- **tax_categories:** `code`, `name`, `sunat_affectation_code` (catálogo 07), `rate numeric(6,4)`, `is_active`. Datos del tenant; ninguna tasa en código.
- **tax_rules:** `concept enum PASSENGER_FARE|PARCEL|CARGO|VEHICLE_TRANSPORT|LUGGAGE_EXCESS|OTHER`, `modality?`, `origin_tax_zone?`, `destination_tax_zone?`, `tax_category_id`, `price_includes_tax bool`, `valid_from`, `valid_to?`, `priority int`, `legal_reference text?`.

### sales
`code`, `channel_id`, `agency_id?`, `branch_id?`, `seller_membership_id?`, `customer_id?`, `buyer_snapshot snap` (doc, nombre y dirección para comprobante), `currency`, `subtotal`, `tax_total`, `total`, `paid_total`, `refunded_total`, `balance` (columnas mantenidas transaccionalmente + verificación en tests), `status enum OPEN|CONFIRMED|CANCELLED`, `idempotency_key?`. UNIQUE (tenant_id, idempotency_key).

### sale_lines
`sale_id`, `concept`, `description`, `quantity`, `unit_price`, `discount`, `tax_rule_snapshot snap`, `tax_amount`, `line_total`, origen: `booking_item_id? | luggage_charge_id? | shipment_id? | cargo_order_id? | manual_concept_id?` con `CHECK (num_nonnulls(...) = 1)`, `status enum ACTIVE|CANCELLED`.

### payments / payment_allocations / refunds
- **payments:** `method enum CASH|CARD|BANK_TRANSFER|WALLET|GATEWAY|CREDIT`, `wallet_brand?` (Yape, Plin), `amount`, `currency`, `status enum PENDING|CONFIRMED|FAILED|REVERSED`, `provider?`, `provider_ref?`, `received_by_membership_id?`, `cash_session_id?`, `idempotency_key`, `received_at`. UNIQUE (tenant_id, idempotency_key) y (tenant_id, provider, provider_ref).
- **payment_allocations:** `payment_id`, `sale_id`, `amount`.
- **refunds:** `sale_id`, `payment_id?`, `amount`, `method`, `reason`, `status enum REQUESTED|APPROVED|PAID|REJECTED`, `policy_snapshot snap`, `approved_by_membership_id?`.

### cash_registers / cash_sessions / cash_movements
- **cash_registers:** `branch_id`, `code`, `name`, `status`.
- **cash_sessions:** `register_id`, `opened_by`, `opened_at`, `opening_amount`, `closed_by?`, `closed_at?`, `expected_amount?`, `counted_amount?`, `difference?`, `count_detail jsonb?`, `status enum OPEN|CLOSED|RECONCILED`. Única sesión abierta por caja (índice parcial).
- **cash_movements:** `session_id`, `direction enum IN|OUT`, `kind enum SALE_PAYMENT|REFUND|EXPENSE|DEPOSIT|ADJUSTMENT|FLOAT`, `method`, `amount`, `payment_id?`, `refund_id?`, `description`, `membership_id`. Append-only.

### commission_accruals / settlements / settlement_lines
- **commission_accruals:** `sale_line_id`, `agency_id`, `rule_snapshot snap`, `amount`, `status enum ACCRUED|SETTLED|REVERSED`.
- **settlements:** `beneficiary_kind enum AGENCY|VEHICLE_OWNER`, `beneficiary_id`, `period_start`, `period_end`, `status enum DRAFT|APPROVED|PAID`, `total`.
- **settlement_lines:** `source_type`, `source_id`, `amount`, `detail jsonb`.

### einvoicing_configs (D2)
`enabled bool`, `adapter_ref text` (p. ej. `yebo-http@1`, validado contra el registro de adaptadores), `environment enum TEST|PRODUCTION`, `base_url text` (https obligatorio, validada contra SSRF: sin IPs privadas ni loopback), `auth_method enum API_KEY_HEADER|BEARER|BASIC|OAUTH2_CLIENT_CREDENTIALS|HMAC`, `credentials_ciphertext bytea enc`, `credentials_key_version int`, `extra_headers_ciphertext bytea? enc`, `endpoints jsonb` (`issue`, `status`, `pdf`, `xml`, `cdr`, `void` con placeholders validados), `timeout_ms int`, `max_retries int`, `status enum NOT_CONFIGURED|PENDING_VALIDATION|VALID|INVALID|DISABLED`, `last_validated_at?`, `last_validation_result jsonb?`. UNIQUE (tenant_id).

### fiscal_document_series
`branch_id?`, `document_type text` (01, 03, 07, 08), `series text` (`^[FB][A-Z0-9]{3}$`), `concepts text[]`, `channel_kinds text[]?`, `numbering_mode enum LOCAL|PROVIDER`, `next_number bigint?`, `is_active`. UNIQUE (tenant_id, document_type, series).

### fiscal_documents
`sale_id`, `series_id`, `contract_version text`, `adapter_ref text` (con los que se emitió; las operaciones posteriores usan el mismo adaptador), `document_type`, `series`, `number bigint?`, `related_document_id?` (nota de crédito → original), `status enum PENDING|PROCESSING|ACCEPTED|REJECTED|ERROR|VOIDED`, `acceptance_status?` (código y descripción SUNAT), `observations jsonb?`, `issue_date date`, `currency`, `totals snap`, `customer_snapshot snap`, `external_id?`, `idempotency_key UNIQUE (tenant)`, `issued_at?`, `voided_at?`, `void_reason?`. UNIQUE (tenant_id, document_type, series, number) WHERE number IS NOT NULL. Un comprobante no anulado por venta y tipo (índice parcial).

### fiscal_document_lines
Copia de líneas fiscales (código, descripción, cantidad, valor unitario, afectación, IGV, total).

### fiscal_document_attempts
`fiscal_document_id`, `operation enum ISSUE|STATUS|VOID|FILE`, `attempt int`, `request_redacted jsonb`, `response_redacted jsonb`, `http_status?`, `error_code?`, `duration_ms`, `occurred_at`. Append-only y con tamaño limitado.

### fiscal_document_files
`fiscal_document_id`, `kind enum PDF|XML|CDR`, `file_asset_id`, `checksum`, `fetched_at`, `source enum PROVIDER`. UNIQUE (fiscal_document_id, kind).

## 8. Pasajeros

### bookings
`code`, `sale_id?`, `channel_id`, `agency_id?`, `contact_snapshot snap`, `status enum HOLD|CONFIRMED|CANCELLED|EXPIRED`, `hold_expires_at?`, `idempotency_key?`.

### booking_items
`booking_id`, `trip_id`, `origin_seq int`, `destination_seq int` (`CHECK origin_seq < destination_seq`), `customer_id?`, `passenger_snapshot snap` (nombre, documento, nacionalidad, menor de edad), `price_class_code`, `fare_snapshot snap`, `amount`, `status enum HELD|CONFIRMED|CANCELLED|EXPIRED`.

### tickets
`booking_item_id`, `code`, `status enum ISSUED|CHECKED_IN|BOARDED|COMPLETED|NO_SHOW|CANCELLED|REFUNDED|EXCHANGED`, `qr_payload_version`, `qr_signature`, `issued_at`, `replaced_by_ticket_id?`. Índice único parcial: 1 ticket vigente por `booking_item_id`.

### luggage_charges
`ticket_id`, `pieces`, `weight_kg`, `excess_weight_kg`, `amount`, `label_codes text[]`.

### boarding_records
`ticket_id`, `trip_stop_seq`, `event enum BOARDED|ALIGHTED|NO_SHOW|DENIED`, `device_id?`, `membership_id`, `occurred_at`, `offline_client_id?`, `synced_at?`. UNIQUE (device_id, offline_client_id).

## 9. Encomiendas

### rate_tables / rate_table_versions / rate_rules
- **rate_tables:** `name`, `service enum PARCEL|CARGO|VEHICLE_TRANSPORT`, `modality?`, `status`.
- **rate_table_versions:** `version`, `status DRAFT|PUBLISHED|ARCHIVED`, `currency`, `charge_basis enum WEIGHT|VOLUME|GREATER_OF|PER_PACKAGE|FIXED|FORMULA`, `volumetric_factor numeric?` (cm³/kg, configurable, D14), `formula_ast jsonb?` (DSL validado sin `eval`, Fase 9), `rounding jsonb`, `valid_from`. Inmutable al publicarse.
- **rate_rules:** `origin_location_id?`, `destination_location_id?`, `route_id?`, `goods_category_id?`, `weight_from?`, `weight_to?`, `volume_from?`, `volume_to?`, `price_per_kg?`, `price_per_m3?`, `price_per_package?`, `fixed_price?`, `min_charge?`, `surcharges jsonb`, `priority`.

### shipments
`code` (público de seguimiento, no secuencial adivinable: prefijo + aleatorio con dígito verificador), `origin_branch_id`, `destination_branch_id`, `sale_id?`, `quote_id`, `status enum RECEIVED|IN_WAREHOUSE|IN_TRANSIT|ARRIVED|READY_FOR_PICKUP|OUT_FOR_DELIVERY|DELIVERED|RETURNED|CANCELLED|INCIDENT`, `declared_value?`, `description`, `observations`, `require_pin_snapshot bool NOT NULL`, `estimated_arrival_at?`, `current_warehouse_id?` (caché del último evento).

### shipment_parties
`shipment_id`, `role enum SENDER|RECIPIENT`, `customer_id?`, `snapshot snap enc` (nombre, documento y contacto). UNIQUE (shipment_id, role).

### shipment_packages
`shipment_id`, `code UNIQUE (tenant)`, `seq`, `description`, `weight_kg`, `length_cm`, `width_cm`, `height_cm`, `volume_m3` (calculado), `volumetric_weight_kg` (calculado con el factor del snapshot), `goods_category_id?`, `photo_asset_ids uuid[]`, `status`, `current_warehouse_id?`.

### shipment_quotes
`rate_table_version_id`, `inputs snap`, `breakdown snap`, `total`, `currency`, `computed_at`. Inmutable.

### shipment_delivery_secrets
`shipment_id`, `pin_hash text` (Argon2id sobre HMAC con pepper), `pepper_version int`, `status enum ACTIVE|LOCKED|REPLACED|CONSUMED`, `failed_attempts int`, `locked_at?`, `set_by_membership_id`. Índice único parcial: 1 `ACTIVE|LOCKED` por envío.

### delivery_pin_attempts
`shipment_id`, `secret_id`, `membership_id`, `device_id?`, `ip?`, `success bool`, `occurred_at`. Append-only.

### delivery_pin_resets
`shipment_id`, `old_secret_id`, `new_secret_id`, `requested_reason`, `identity_evidence_asset_ids uuid[]`, `approved_by_membership_id`, `occurred_at`.

### exceptional_delivery_authorizations
`shipment_id`, `requested_by_membership_id`, `reason_code`, `reason_detail`, `recipient_verification snap enc`, `approval_level int` (1 o 2), `approver_membership_id`, `approver_user_id`, `approved_at`, `expires_at` (15 min), `consumed_at?`, `device_id?`. Append-only. CHECK: aprobador ≠ solicitante; único (`shipment_id`, `approval_level`) por solicitud.

### delivery_confirmations
`shipment_id UNIQUE`, `method enum PIN|STANDARD|EXCEPTIONAL`, `receiver_snapshot snap enc`, `relationship?`, `evidence_asset_ids uuid[]`, `signature_asset_id?`, `membership_id`, `branch_id`, `delivered_at`.

### shipment_transfers / shipment_transfer_items
- **transfers:** `code`, `origin_warehouse_id`, `destination_warehouse_id`, `trip_id?`, `vehicle_id?`, `status enum DRAFT|READY|DISPATCHED|IN_TRANSIT|RECEIVED|PARTIALLY_RECEIVED|INCIDENT|CANCELLED`, `dispatched_by?`, `dispatched_at?`, `received_by?`, `received_at?`, `observations`.
- **items:** `transfer_id`, `package_id`, `dispatch_scan_at?`, `receipt_status enum PENDING|RECEIVED|MISSING|DAMAGED|EXTRA`, `receipt_scan_at?`, `notes`. Índice único parcial: un paquete en un solo traslado abierto.

### tracking_events
`subject_type enum SHIPMENT|PACKAGE|CARGO_ORDER|CARGO_ITEM`, `shipment_id?`, `package_id?`, `cargo_order_id?`, `cargo_item_id?` (CHECK coherente con `subject_type`), `type → catálogo`, `warehouse_id?`, `location_id?`, `transfer_id?`, `trip_id?`, `visibility enum PUBLIC|INTERNAL`, `public_code?` (mapeo a un texto público controlado), `internal_note?`, `membership_id?`, `occurred_at`, `recorded_at`, `offline_client_id?`. Append-only.

## 10. Carga

### cargo_orders / cargo_items / cargo_quotes / cargo_quote_lines
- **cargo_orders:** `code`, `customer_id`, `sender_snapshot snap`, `recipient_snapshot snap`, `origin_location_id`, `destination_location_id`, `status` (ver F6), `special_conditions`, `declared_value?`, `sale_id?`, `approved_quote_id?`.
- **cargo_items:** `order_id`, `kind enum GENERAL|MOTORCYCLE|CAR|PICKUP|TRUCK|TRACTOR|HEAVY_MACHINERY|OVERSIZED`, `category_id?`, `description`, `quantity`, `weight_kg`, `length_cm`, `width_cm`, `height_cm`, `volume_m3`, `vehicle_snapshot snap?` (placa, marca, modelo, VIN), `document_asset_ids`, `photo_asset_ids`.
- **cargo_quotes:** `order_id`, `version`, `status enum DRAFT|SENT|ACCEPTED|EXPIRED|SUPERSEDED|REJECTED`, `valid_until`, `rate_table_version_id?`, `total`, `currency`, `terms`, `accepted_at?`, `accepted_by_snapshot?`.
- **cargo_quote_lines:** detalle con su base de cálculo.

### cargo_assignments
`cargo_item_id`, `trip_id`, `origin_seq`, `destination_seq`, `zone_code`, `compatibility_check snap`, `manual_approval_membership_id?`, `status enum PLANNED|CONFIRMED|LOADED|UNLOADED|CANCELLED`.

### loading_operations / loading_operation_items
- **loading_operations:** `trip_id`, `stop_seq`, `kind enum LOAD|UNLOAD|BOARD|DISEMBARK`, `membership_id`, `started_at`, `completed_at?`, `notes`.
- **items:** `operation_id`, `cargo_item_id? | package_id?`, `quantity`, `condition_notes`, `photo_asset_ids`.

## 11. Manifiestos, white label, archivos, notificaciones, offline y auditoría

### manifests
`type enum PASSENGER|PARCEL|CARGO|VEHICLE`, `trip_id? | transfer_id?` (exactamente uno), `version int`, `status enum DRAFT|ISSUED|SUPERSEDED`, `content snap`, `template_id?`, `pdf_asset_id?`, `issued_by`, `issued_at`. UNIQUE (tenant_id, type, trip_id, version).

### site_versions
`version`, `status enum DRAFT|PUBLISHED|ARCHIVED`, `schema_version`, `config jsonb` (tema, fuentes de lista blanca, header, footer, secciones y su orden, contactos, políticas, FAQ, redes; validado con Zod), `published_at?`, `published_by?`. Índice único parcial: 1 `PUBLISHED` y 1 `DRAFT` por tenant.

### document_templates
`kind enum TICKET|SHIPMENT_LABEL|SHIPMENT_RECEIPT|MANIFEST|CARGO_QUOTE`, `version`, `status`, `config jsonb` (bloques predefinidos y campos visibles; sin HTML libre).

### file_assets
`storage_key UNIQUE`, `bucket`, `original_name`, `mime`, `size_bytes`, `checksum_sha256`, `kind`, `visibility enum PRIVATE|PUBLIC`, `uploaded_by?`, `status enum PENDING|READY|REJECTED|DELETED`.

### notification_templates (🌐 si `tenant_id IS NULL`)
`event_code`, `channel enum EMAIL|IN_APP|WHATSAPP|SMS`, `locale`, `version`, `subject`, `body_html`, `body_text`, `status`. UNIQUE (tenant_id, event_code, channel, locale, version) con `NULLS NOT DISTINCT`.

### notification_preferences
`membership_id? | customer_id?`, `event_code`, `channel`, `enabled`.

### notifications (bandeja in-app)
`membership_id`, `category`, `priority`, `title`, `body`, `link_path`, `read_at?`, `source_event_id?`.

### notification_deliveries (NotificationLog)
`outbox_event_id?`, `template_id`, `channel`, `recipient_hash` + `recipient enc`, `status enum QUEUED|SENDING|SENT|DELIVERED|FAILED|BOUNCED|SUPPRESSED`, `provider`, `provider_message_id?`, `attempts`, `last_error?`, `idempotency_key UNIQUE`, `sent_at?`.

### outbox_events (con `tenant_id` nullable para eventos de plataforma)
`aggregate_type`, `aggregate_id`, `event_type`, `schema_version`, `payload jsonb` (IDs, sin datos personales), `occurred_at`, `published_at?`, `attempts`, `last_error?`. Índice parcial `WHERE published_at IS NULL`.

### processed_events
PK (`consumer`, `event_id`). Idempotencia de consumidores.

### idempotency_keys
`scope`, `key`, `request_hash`, `response_status?`, `response_body jsonb?`, `locked_until?`, `expires_at`. UNIQUE (tenant_id, scope, key).

### sync_operations
`device_id`, `client_op_id`, `type`, `payload jsonb`, `client_occurred_at`, `status enum RECEIVED|APPLIED|CONFLICT|REJECTED`, `conflict_detail?`, `applied_at?`. UNIQUE (device_id, client_op_id).

### audit_logs (particionada por mes)
`tenant_id?`, `actor_kind enum USER|PLATFORM_USER|SERVICE_ACCOUNT|SYSTEM`, `actor_id?`, `membership_id?`, `action`, `entity_type`, `entity_id?`, `changes jsonb` (redactado), `ip?`, `user_agent?`, `trace_id`, `occurred_at`. Sin `UPDATE` ni `DELETE` para `yebo_app`.

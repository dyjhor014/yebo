# Fase 6 · Ubicaciones, agencias, flota y capacidades (plan)

- **Estado:** ✅ Decisiones F6-Q1 a F6-Q7 **aprobadas** por el responsable el 2026-11-10, tal como se recomendaron. Etapa 6.1 en curso.
- **Rama:** `fase-6/plan`, desde el cierre de la Fase 5 (`8b580c0`).
- **Criterio de aceptación** ([roadmap](roadmap.md)): «Embarcación con camarotes, zona libre, bodega y cubierta; bus con asientos y bodega».

## Lo que ya está decidido en la arquitectura

| Fuente | Decisión |
|---|---|
| data-dictionary §3 | `locations` (con tipos de un catálogo: ciudad, puerto, embarcadero, terminal; `ubigeo?`), `branches` (con punto de recojo y de recepción), `warehouses`/`warehouse_bins`, `sales_channels` (mostrador, online, agencia externa, central telefónica, API), `agencies` y sus comisiones, `agency_users`, `document_sequences` y `membership_branch_scopes` (§2) |
| data-dictionary §4 | Tipos de vehículo (catálogo global de sugerencias y tipos propios), `vehicles` (placa o matrícula, estado, propia o de terceros, capacidad nominal), `vehicle_documents` con vencimiento, `vehicle_layouts` con **versiones inmutables al publicarse**, `layout_zones` (tipo, servicio, modo `ASSIGNED`/`POOLED`, restricciones físicas), `layout_elements` (asiento, cama, camarote con camas hijas, espacio de vehículo…), `capacity_rules` (personas, unidades, kg, m³, m lineales) y `vehicle_layout_assignments` sin solapamiento |
| capacity-and-inventory §2–4 | Lo **asignable** (asiento, cama, camarote sin camas, espacio de vehículo) se venderá con exclusión GIST; lo **agregado** (zona libre, hamacas, bodega, cubierta, aforo total) con contadores por tramo. Camarote con camas: el inventario son las camas, y el camarote completo se vende asignando todas (ej. D). Aforo total de la nave: un pool `PERSONS` de toda la unidad (ej. H) |
| system-overview §4 | `locations / branches / warehouses` y `fleet (vehicles + layouts)` son módulos de la capa **L1**. `sales-channels + agencies` y `vehicle-owners` están en **L2** |
| ADR-020 | `sales_channels` siempre activo. `AGENCIES` (D7) y `OWNER_SETTLEMENTS` (D6) modelados pero **apagados** hasta su validación comercial |
| ADR-010 (snapshots y versionado) | Una versión de layout publicada no cambia. Los viajes (Fase 7) la referencian y materializan su inventario |
| Auditoría T4 | Editor de layouts acotado: **grilla con elementos posicionados, sin dibujo libre** |
| multitenancy §5 | Configurar ubicaciones, flota y layouts es `CONFIGURE`: bloqueado en `SUSPENDED`, `EXPIRED` y `CANCELLED` |

**Fuera de esta fase por la arquitectura:** los viajes, la venta y el inventario por tramo (fases 7 y 8). En esta fase se define **qué capacidad tiene cada unidad**. Venderla y medirla por tramos llega después.

## Etapas propuestas

| Etapa | Contenido | Verificación |
|---|---|---|
| **6.1 · Ubicaciones, sucursales y canales** | `locations` y su catálogo de tipos, `branches` y `sales_channels` (un mostrador por sucursal y el canal online, creados por defecto). Ámbito de sucursal de cada membresía (F6-Q4). API de la empresa con permisos nuevos y categoría CONFIGURE | Integración: RLS y aislamiento, códigos únicos, archivado en vez de borrado, permisos y estados del tenant |
| **6.2 · Flota** | Tipos de vehículo (catálogo global y propios), `vehicles` y `vehicle_documents` con su archivo (F6-Q5) y su vencimiento | Integración: placa o matrícula única, estados, documentos vencidos o por vencer, archivos privados de cada empresa |
| **6.3 · Layouts: modelo y reglas** | Layouts con versiones (borrador → publicada → archivada; inmutable al publicarse, por trigger), zonas, elementos y reglas de capacidad. Un esquema Zod en contratos y **validación en el servidor**: códigos únicos, sin elementos superpuestos en la grilla, camarote con camas hijas, zona `ASSIGNED` con elementos asignables, zona `POOLED` con su regla de capacidad, aforo total. **`deriveInventory(version)`** en contratos: los recursos asignables y los pools que tendrá un viaje con esa versión. La Fase 7 lo usará para materializar `trip_resources` y `trip_capacity_pools`. Asignación de versiones publicadas a vehículos, sin solapamiento (exclusión) | Unitarias del esquema y de `deriveInventory`. Integración: inmutabilidad, publicación atómica, solapamiento de asignaciones, RLS, permisos y mutaciones |
| **6.4 · Editor de layouts** | En el panel de la empresa (`apps/web`): grilla por cubierta, generadores (filas de asientos con pasillo, camarote con N camas, zona de capacidad) y plantillas de inicio (F6-Q1). Panel de propiedades, resumen de capacidad derivada, publicar y asignar a un vehículo. **Maqueta primero y revisión con Impeccable** antes del código, como en la 4.7 y la 5.4 | E2E del editor con axe; uso con teclado (F6-Q1) |
| **6.5 · Agencias** (según F6-Q2) | Registro de agencias externas con su canal, detrás del módulo `AGENCIES` | Integración: módulo apagado → 403; aislamiento |
| **6.6 · Cierre** | Prueba del criterio: una **lancha** con camarotes (con camas), zona libre, bodega y cubierta, y un **bus** con asientos y bodega. Se construyen por la API de la empresa, se publican, se asignan a sus vehículos y su capacidad derivada es la esperada. Resultados en `phase-6-results.md` | Criterio en la CI (integración) y en el E2E (construidos con el editor) |

## Decisiones (todas aprobadas el 2026-11-10 según la recomendación)

| Id | Pregunta | Recomendación | Alternativas |
|---|---|---|---|
| **F6-Q1** | Alcance del editor de layouts | **Grilla con elementos posicionados** (auditoría T4), con **generadores**: filas de asientos con pasillo (p. ej., 2+2 × 10), camarote con N camas y zona de capacidad. Además, **2 plantillas de inicio** (bus 2+2 de 40 asientos con bodega; lancha con camarotes, zona libre, bodega y cubierta) que la empresa copia y ajusta. Cada elemento se puede mover con el teclado y editar en un panel de propiedades accesible | Solo formularios y tablas, con una vista del plano de solo lectura (más simple, peor para buses grandes); o dibujo libre (descartado en la auditoría) |
| **F6-Q2** | Agencias externas (D7, sin validar) | **Registrar ahora solo lo mínimo**, detrás del módulo `AGENCIES`, apagado por defecto: nombre, RUC, contacto, estado y su canal de venta `EXTERNAL_AGENCY`. **Sin comisiones**: las reglas de comisión y `agency_users` llegan con la venta (Fase 8) y la liquidación (Fase 11), cuando D7 esté validado | Posponer las agencias por completo a la Fase 8, o implementarlas completas ahora |
| **F6-Q3** | Unidades de terceros y liquidaciones (D6, sin validar) | **Solo el campo `ownership` (propia o de terceros)** en el vehículo. `vehicle_owners` y las liquidaciones se posponen hasta validar D6 (módulo `OWNER_SETTLEMENTS`) | Modelar ya los propietarios (sin liquidación) |
| **F6-Q4** | Ámbito de sucursal de las membresías (`membership_branch_scopes`) | **Datos y gestión ahora**: asignar sucursales a una persona desde la gestión de accesos; sin filas = todas. **Se aplica** en los recursos que dependen de la sucursal, a partir de la venta (Fase 8). En esta fase solo se muestra y se guarda | Posponerlo entero a la Fase 8 |
| **F6-Q5** | Documentos del vehículo (SOAT, revisión técnica, certificado de matrícula y de seguridad) | **Incluirlos**, con vencimiento y estado calculado (vigente, por vencer en 30 días, vencido) en la lista de la flota. El archivo (PDF, JPEG o PNG, ≤ 10 MB) va al almacenamiento de la 5.2, se comprueba por su contenido y es **privado**: se descarga solo con sesión y permiso, nunca por una URL pública. Los avisos por correo llegan en la Fase 12 | Solo número y fecha de vencimiento, sin archivo |
| **F6-Q6** | Ubicaciones: ¿de cada empresa o compartidas? | **De cada empresa**, con el **`ubigeo`** del INEI opcional, para poder relacionarlas entre empresas más adelante (buscador de yebo.pe, ADR-029). El catálogo de tipos (ciudad, puerto, embarcadero, terminal) es global | Un catálogo global de ubicaciones compartido por todas las empresas (más trabajo de curación desde el inicio) |
| **F6-Q7** | Almacenes y secuencias de documentos | **Posponerlos**: `warehouses`/`warehouse_bins` a la Fase 9 (encomiendas) y `document_sequences` a la Fase 8 (boletos), que es donde se usan | Incluirlos ya |

**Permisos nuevos** (en la plantilla Administrador y en los roles Administrador existentes, como `site.manage` en la 5.1):
- `locations.manage`: ubicaciones, sucursales y canales;
- `fleet.manage`: vehículos y documentos;
- `layouts.manage`: layouts y su asignación;
- `agencies.manage`: si se aprueba F6-Q2.

**Módulos:** la flota y los layouts no dependen de ningún módulo del plan, porque toda empresa los necesita. Los tipos de zona que ofrece el editor dependen de los **servicios que opera la empresa** (`tenant_services`):
- asientos, camas y zona libre si opera pasajeros;
- bodega si opera encomiendas o carga;
- cubierta de vehículos si opera transporte de vehículos.

## Privilegios y seguridad (ADR-034)

- **Tablas nuevas de tenant con RLS forzado:**
  - `yebo_app` puede leer y escribir lo de su empresa, con UPDATE por columnas;
  - no hay DELETE: lo que se retira se archiva (`archived_at`), porque los viajes y las ventas lo referenciarán;
  - `yebo_backoffice` solo puede leer, para la ficha de la empresa en el panel de YEBO.
- **Versiones de layout:**
  - el trigger impide modificar una versión publicada (salvo archivarla) y borrar versiones;
  - una versión publicada asignada a un vehículo no se archiva mientras la asignación esté vigente.
- **Archivos de documentos:** `file_assets` con visibilidad `PRIVATE` y descarga autenticada. La CSP y las cabeceras son las mismas que en la 5.2.
- **Auditoría:**
  - publicar un layout y asignarlo quedan con su autor, como el historial del sitio de la 5.1;
  - el registro de auditoría general de las acciones de la empresa sigue pendiente.

## Fuera del alcance de la Fase 6

- Viajes, inventario por tramo y venta: fases 7 y 8.
- Comisiones de agencias y liquidación a propietarios: D6 y D7, fases 8 y 11.
- Almacenes y secuencias de documentos (F6-Q7).
- Avisos de vencimiento por correo (Fase 12).
- Mapa interactivo de ubicaciones.

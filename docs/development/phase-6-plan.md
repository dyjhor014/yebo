# Fase 6 · Ubicaciones, agencias, flota y capacidades (plan)

- **Estado:** ✅ Decisiones F6-Q1 a F6-Q7 **aprobadas** por el responsable el 2026-11-10, tal como se recomendaron. Etapas 6.1 a 6.3 aprobadas. Etapa 6.4 aprobada completa (6.4a a 6.4d, al 2026-11-17). La 6.5a (agencias: modelo y API) está aprobada (2026-11-17); la 6.5b, pendiente de autorización.
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

## Etapa 6.1 · Ubicaciones, sucursales y canales (implementada el 2026-11-10; aprobada, `025c8b1`)

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Módulo | `locations` (capa L1): `LocationsService` y controladores de ubicaciones, sucursales, canales y el ámbito de sucursal de cada persona. Contrato en `@yebo/contracts` (`locations.ts`) |
| Ubicaciones (F6-Q6) | De cada empresa. Nombre único dentro de la empresa. Tipo del catálogo global `location_kinds`; `ubigeo` del INEI opcional (6 dígitos); región y coordenadas opcionales (latitud y longitud, juntas). `tax_zone_code` existe en la tabla para la Fase 11, pero la API no lo expone todavía |
| Archivar, no borrar | Ubicaciones y sucursales se archivan y se restauran; `yebo_app` no tiene DELETE. Una ubicación no se archiva mientras tenga sucursales activas (409 con cuántas). Una sucursal nueva, movida o restaurada exige una ubicación activa. La ubicación se bloquea (`FOR UPDATE` al archivar, `FOR SHARE` al usarla), así que archivar y crear una sucursal a la vez no deja una sucursal activa en una ubicación archivada |
| Sucursales | Código en mayúsculas (`^[A-Z0-9][A-Z0-9-]{0,11}$`), único y **que no cambia**: `yebo_app` no tiene UPDATE sobre la columna. Hasta 4 teléfonos. Punto de recojo y punto de recepción de encomiendas |
| Canales (ADR-020) | En el alta, cada empresa recibe el canal `ONLINE`; la migración lo crea para las que ya existen. Cada sucursal nace con su mostrador (`MOSTRADOR-<código>`) en la misma transacción. Al archivar la sucursal, su mostrador se desactiva, y vuelve a activarse al restaurarla. Un mostrador de una sucursal archivada no se reactiva (409). Los canales se renombran y se activan o desactivan; la clase, el código y la sucursal no cambian (privilegio por columna). Las agencias externas, en la 6.5 |
| Ámbito de sucursal (F6-Q4) | `PUT /members/{id}/branches` con `roles.assign` (CONFIGURE). Solo sucursales activas de la empresa; vacío = todas. Sube la versión de permisos de la membresía, como un cambio de roles. La lista de miembros incluye `branchIds`. Se aplica a partir de la venta (Fase 8) |
| Pantallas | Esta etapa es solo la API. Las pantallas de ubicaciones, sucursales y flota irán en el panel de la empresa con el editor de la 6.4, con maqueta previa |

### API de la empresa

| Ruta | Permiso y categoría |
|---|---|
| `GET /api/v1/locations` (con los tipos), `POST`, `PUT /{id}`, `POST /{id}/archive`, `POST /{id}/restore` | `locations.manage`, READ / CONFIGURE |
| `GET /api/v1/branches`, `POST`, `PUT /{id}` (sin código), `POST /{id}/archive`, `POST /{id}/restore` | `locations.manage`, READ / CONFIGURE |
| `GET /api/v1/sales-channels`, `PUT /{id}` (nombre y activo) | `locations.manage`, READ / CONFIGURE |
| `PUT /api/v1/members/{id}/branches` | `roles.assign`, CONFIGURE |

### Base de datos (migración `20261113010000_fase6_1_locations_branches`, reversión en su cabecera)

- **Tablas:**
  - `location_kinds` 🌐, sembrada;
  - `locations`, `branches`, `sales_channels` y `membership_branch_scopes`, de tenant y con RLS forzado.
- **CHECK:**
  - nombre recortado de 2 a 80 caracteres;
  - formato del ubigeo y del código;
  - coordenadas juntas y en rango;
  - teléfonos como lista de 4 como mucho;
  - mostrador ⇔ con sucursal;
  - `ONLINE` ⇔ código `ONLINE`.
- **UNIQUE:**
  - (empresa, nombre) de la ubicación;
  - (empresa, código) de la sucursal y del canal;
  - (empresa, sucursal, clase) del canal: un mostrador por sucursal.
- **Privilegios:**
  - `yebo_app`: SELECT e INSERT, y UPDATE por columnas, sin DELETE, salvo en el ámbito de sucursal, que es una relación;
  - `yebo_backoffice`: SELECT, más INSERT en `sales_channels` para el alta.
- **Permiso `locations.manage`:** módulo `LOCATIONS`, en la plantilla Administrador y en los roles Administrador existentes (sube su `permissions_version`).

### Pruebas

- **`locations.int-spec` (8):**
  - el alta crea el canal `ONLINE`, y el catálogo de tipos es global;
  - ubicaciones: validaciones (ubigeo, coordenadas, tipo, campos extra), nombre único por empresa y edición;
  - sucursales:
    - nacen con su mostrador, y el código se normaliza, es único y no se edita;
    - archivar: la ubicación no se archiva con sucursales activas, y el mostrador sigue a su sucursal;
    - sin sucursales nuevas ni restauradas en una ubicación archivada;
  - aislamiento: 404 y 400 entre empresas, y RLS sin contexto y con el de otra empresa;
  - reglas de la base: no se puede cambiar el código ni la clase o la sucursal de un canal, ni borrar (42501); un segundo `ONLINE` o un segundo mostrador por sucursal → 23505; un mostrador sin sucursal → 23514;
  - ámbito de sucursal: asignar, listar, subir la versión de permisos; sucursales archivadas, de otra empresa o repetidas → 400;
  - sin permiso → 403 y sin sesión → 401;
  - empresa suspendida: consulta, pero no configura.
- **Inventario actualizado:**
  - matriz de privilegios: +10 de tabla y +19 de columna, exactamente las concedidas;
  - catálogo de permisos (`access.int-spec` reconoce la siembra de esta migración);
  - registro de modelos de tenant;
  - reinicio de datos de las pruebas.
- **Mutaciones (7), todas detectadas:**
  - sucursal sin mostrador;
  - archivar una ubicación con sucursales;
  - un mostrador que no sigue a su sucursal;
  - ámbito con sucursales archivadas;
  - reactivar el mostrador de una sucursal archivada;
  - no subir la versión de permisos;
  - una sucursal en una ubicación archivada.
- **Totales:**
  - integración: 26 suites y 393 pruebas ✅;
  - E2E: 25 + 3 opcionales ✅ (el alta de empresas cambió);
  - tipos, lint, formato y unitarias ✅.

### Pendiente

- ✅ Migración aplicada a `yebo_dev` el 2026-11-10, con copia previa (`~/yebo-backups/yebo_dev-antes-6.1-20261110203203.dump`).

## Etapa 6.2 · Flota (implementada el 2026-11-11; aprobada, `3158036`)

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Módulo | `fleet` (capa L1): `FleetService` (tipos y vehículos), `VehicleDocumentsService` (documentos y archivos) y `FleetContext` (empresa, autor, reloj y «hoy» de la empresa). Contrato en `@yebo/contracts` (`fleet.ts`) |
| Tipos de vehículo | De cada empresa, con una sugerencia opcional del catálogo global `vehicle_type_catalog` (bus, minibús, minivan, auto, camión, lancha, motonave, deslizador, chata y bote). Un tipo solo puede ser de una modalidad que la empresa opera (`tenant_services`), y la sugerencia debe ser de la misma modalidad. Nombre único; la modalidad no cambia. No se archiva mientras tenga vehículos sin retirar (409) |
| Vehículos | Código en mayúsculas, único y **que no cambia**. Placa o matrícula en mayúsculas y única en la empresa (409 que dice cuál de las dos choca). La modalidad se **hereda del tipo** con una FK compuesta (tenant, tipo, modalidad): cambiar de tipo solo es posible dentro de la misma modalidad, y la base lo impide aunque falle la aplicación. Estado (activo, mantenimiento, fuera de servicio, retirado), propiedad (F6-Q3: propia o de terceros), capacidad nominal (pasajeros, kg y m³) y hasta 20 características. Se retira; no se borra |
| Documentos (F6-Q5) | Tipos del catálogo global `vehicle_document_types`: SOAT, revisión técnica y tarjeta de propiedad (terrestre); certificado de matrícula y de seguridad (fluvial); póliza de seguro y otro (cualquiera). El tipo debe aplicar a la modalidad del vehículo y no cambia. **Renovar es crear un documento nuevo**: el anterior queda como historia y el resumen del vehículo toma, de cada tipo, el de vencimiento más lejano. Un documento cargado por error se archiva |
| Estado | `documentStatus` y `documentsSummary` en contratos: vencido; por vencer (de 0 a 30 días, incluido el mismo día); vigente; sin vencimiento. El resumen del vehículo es el peor estado, con el próximo vencimiento. «Hoy» es la fecha de calendario en la zona horaria de la empresa: el tenant resuelto por el host ahora incluye `timezone` (clave de caché `tenant:host:v3`) |
| Archivos (F6-Q5) | `POST /vehicle-documents/files` con el archivo en el cuerpo (PDF, JPEG o PNG; hasta 10 MB, si no 413). Se comprueba por el **contenido**: un PDF debe empezar por `%PDF-` y terminar en `%%EOF`; las imágenes se recodifican en su formato, sin metadatos (EXIF y GPS), aplicando la orientación y reducidas a 4000 px como mucho. Se guardan como `file_assets` `VEHICLE_DOCUMENT` y `PRIVATE`. Un archivo es de un solo documento (UNIQUE); al reemplazarlo, el anterior pasa a `DELETED` y su objeto se borra |
| Descarga | `GET /vehicles/{id}/documents/{doc}/file` con `fleet.manage`: siempre como adjunto (`Content-Disposition: attachment`), con `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff` y `Cache-Control: private, no-store`. Un PDF nunca se abre dentro de la aplicación ni se publica por URL; el portal y las rutas del sitio no ven estos archivos |
| Sitio (5.2) | El analizador binario admite ahora hasta 10 MB y PDF, para los documentos; el sitio impone sus 5 MB (413) e ignora los archivos que no son suyos al listar, retirar y servir. Al comprobarlo se encontró que, sin ese filtro, «retirar un archivo del sitio» habría podido retirar el documento de un vehículo |

### API de la empresa (permiso `fleet.manage`)

| Ruta | Categoría |
|---|---|
| `GET /api/v1/vehicle-types` (con el catálogo), `POST`, `PUT /{id}` (sin modalidad), `POST /{id}/archive`, `POST /{id}/restore` | READ / CONFIGURE |
| `GET /api/v1/vehicles`, `POST`, `PUT /{id}` (sin código) | READ / CONFIGURE |
| `GET /api/v1/vehicles/{id}/documents` (con los tipos que aplican), `POST`, `PUT /{doc}`, `POST /{doc}/archive`, `POST /{doc}/restore` | READ / CONFIGURE |
| `GET /api/v1/vehicles/{id}/documents/{doc}/file` | READ |
| `POST /api/v1/vehicle-documents/files` | CONFIGURE |

### Base de datos (migración `20261113020000_fase6_2_fleet`, reversión en su cabecera)

- **Tablas:**
  - `vehicle_type_catalog` 🌐 y `vehicle_document_types` 🌐, sembradas;
  - `vehicle_types`, `vehicles` y `vehicle_documents`, de tenant y con RLS forzado.
- **CHECK:**
  - formato del código y de la placa;
  - longitudes;
  - capacidad nominal como objeto y hasta 20 características;
  - el vencimiento de un documento no es anterior a su emisión.
- **UNIQUE y FK:**
  - (empresa, nombre) del tipo;
  - (empresa, código) y (empresa, placa) del vehículo;
  - (empresa, archivo) del documento;
  - FK compuesta del vehículo a (empresa, tipo, modalidad).
- **`file_assets`:**
  - nuevo tipo `VEHICLE_DOCUMENT`;
  - ancho y alto nulos solo en un PDF;
  - hasta 10 MB;
  - CHECK por tipo: los documentos son `PRIVATE` (PDF, JPEG o PNG) y el sitio, `PUBLIC`, imágenes de hasta 5 MB. El valor nuevo del enum se compara como texto, porque no se puede usar en la misma transacción en que se añade.
- **Privilegios:**
  - `yebo_app`: SELECT e INSERT, y UPDATE por columnas, sin DELETE. Sin UPDATE de la modalidad del tipo, del código ni de la modalidad del vehículo, ni del tipo o el vehículo de un documento;
  - `yebo_backoffice`: SELECT.
- **Permiso `fleet.manage`:** módulo `FLEET`, en la plantilla Administrador y en los roles Administrador existentes.

### Pruebas

- **Contratos (6 nuevas, 17 en total):** `documentStatus` (límites de 0, 30 y 31 días); `documentsSummary` (sin documentos, renovación como historia, peor estado y próximo vencimiento); normalización del código y de la placa; el vencimiento no es anterior a la emisión.
- **`fleet.int-spec` (9), contra PostgreSQL, Redis y Garage reales:**
  - tipos: catálogo, modalidad que la empresa no opera, sugerencia de otra modalidad, nombre repetido y modalidad no editable;
  - vehículos: normalización, código o placa repetidos (409 con el motivo exacto), la misma placa en otra empresa sí, cambio a un tipo de otra modalidad o de otra empresa → 400, el código no se edita;
  - archivar un tipo con vehículos sin retirar → 409; un vehículo en un tipo archivado → 400;
  - archivos:
    - un PDF válido y una foto JPEG con EXIF, que se guarda sin metadatos;
    - se rechazan un HTML presentado como PDF, un PDF sin final, un GIF presentado como PNG y datos que no son imagen (400);
    - más de 10 MB → 413, y un tipo de cuerpo no admitido → 400;
  - documentos:
    - tipos según la modalidad;
    - estado por vencer y vencido, con el resumen del vehículo;
    - el mismo archivo en dos documentos → 409; cambiar el tipo → 400;
    - la renovación deja el anterior como historia;
  - descarga: adjunto con su nombre, CSP `sandbox`, `no-store` y `nosniff`, con los mismos bytes. Otra empresa → 404; sin sesión → 401. El portal y las rutas del sitio no ven el archivo; otra empresa no puede referenciarlo;
  - reemplazar el archivo retira el anterior (`DELETED` y objeto borrado); archivar un documento cambia el resumen;
  - reglas de la base:
    - no se pueden cambiar el código ni la modalidad, ni el tipo de un documento, ni borrar (42501);
    - un vehículo con un tipo de otra modalidad → 23503 (FK compuesta);
    - un documento público o un PDF del sitio → 23514;
    - sin contexto, 0 filas;
  - aislamiento, sin permiso → 403 (también la descarga); empresa suspendida: consulta y descarga, pero no configura ni sube.
- **Inventario actualizado:**
  - matriz de privilegios: +10 de tabla y +18 de columna, exactamente las concedidas;
  - siembra de permisos de `access.int-spec`;
  - registro de modelos de tenant;
  - reinicio de datos de las pruebas.
- **Mutaciones (11), todas detectadas:**
  - modalidad no operada;
  - sugerencia de otra modalidad;
  - archivar un tipo con vehículos;
  - tipo archivado;
  - cambio de modalidad;
  - tipo de documento de otra modalidad;
  - cambiar el tipo de un documento;
  - PDF sin final;
  - imagen guardada sin recodificar;
  - archivo reemplazado que no se retira;
  - descarga en línea en vez de adjunta.
- **Hallazgos por el camino:**
  - `uniqueTarget` daba un 500 en lugar de 409 y confundía placa con código: Prisma no siempre informa `meta.target`, y una cadena vacía se tomaba como «no es duplicado». Ahora busca la columna en todo `meta`;
  - la prueba de reglas tomaba la única conexión de su pool y luego pedía otra: esperaba indefinidamente y Jest no terminaba. Era un error de la prueba, no de la API.
- **Totales:**
  - integración: 27 suites y 402 pruebas ✅;
  - E2E: 25 + 3 opcionales ✅;
  - tipos, lint, formato y unitarias ✅.

### Pendiente

- ✅ Migración aplicada a `yebo_dev` el 2026-11-11, con copia previa (`~/yebo-backups/yebo_dev-antes-6.2-20261111115336.dump`). Los archivos del sitio ya existentes cumplen los CHECK nuevos de `file_assets`.
- Limpieza de archivos subidos que nunca se usaron en un documento (como los del sitio): tarea programada, fuera de la 6.2.

## Etapa 6.3 · Layouts: modelo y reglas (implementada el 2026-11-11; aprobada, `3bd5e6d`)

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Documento del borrador | El borrador de una versión es un documento JSON (`LayoutDocumentSchema`, en `@yebo/contracts`) que el editor de la 6.4 guarda entero, como el sitio de la 5.1. Contiene: cubiertas (hasta 4, con una grilla de hasta 60 × 200 celdas), zonas (hasta 60) con su rectángulo, elementos (hasta 1500) con posición, tamaño, rotación y capacidad, y el aforo total. **Guardar** solo exige la forma (Zod estricto), así que se guarda a medias. **Publicar** exige todas las reglas |
| Reglas (`validateLayout`) | Las mismas en el servidor y, en la 6.4, en el editor: códigos únicos; cubiertas numeradas 0, 1…; zonas dentro de su cubierta y sin solaparse. Cada tipo de zona (`ZONE_RULES`) fija su modo (ASSIGNED o POOLED), los servicios, los elementos que admite y sus dimensiones; las POOLED exigen capacidad. Los elementos de inventario (asiento, cama, camarote, espacio de vehículo) van en una zona ASSIGNED que los admite, dentro de ella. Lo que ocupa espacio no se solapa (una cama, solo con su camarote). Una cama va dentro de su camarote y es para 1 o 2 personas. Un camarote con camas es para la suma de sus camas y es el único que se vende completo. Una zona ASSIGNED tiene algo que vender. Además, al publicar, cada zona debe ser de un servicio que la empresa opera en la modalidad del layout |
| Tipos de zona | Los del catálogo (SEATING, VIP, FREE_ZONE, HAMMOCK, LUGGAGE, HOLD, CARGO_DECK y VEHICLE_DECK) más **CABINS** para los camarotes. La cubierta de vehículos combina espacios asignables con límites de peso y metros lineales (capacity-and-inventory, ej. G) |
| Inventario derivado (`deriveInventory`) | Lo que materializará un viaje en la Fase 7. Recursos: asientos, camas y espacios; los camarotes con camas son padres no vendibles por sí mismos (se venden sus camas, o todas a la vez si `sellableAsUnit`), y un camarote sin camas se vende entero. Pools: cada regla de capacidad de una zona, y el aforo total como pool `PERSONS` de la unidad (ej. H). Clase de precio resuelta: la del elemento, la de su zona o la del tipo (CAMA, CAMAROTE, HAMACA…). El resumen cuenta asientos, camas, camarotes, espacios y personas |
| Publicar | En una transacción, con la fila del layout bloqueada: se comprueban las reglas (400 que resume los tres primeros problemas; la lista completa está en el detalle de la versión), se insertan zonas, reglas y elementos (primero los camarotes, para que sus camas los referencien) y la versión pasa a publicada con su autor. Puede haber **varias versiones publicadas**: los viajes referenciarán la suya; editar después crea la versión siguiente |
| Plantillas y generadores (F6-Q1) | En contratos, para que el editor los reutilice: `seatRows` (filas con pasillo, códigos 1A, 1B…), `cabin` (camarote con N camas: C1, C1-B1…), `busTemplate` (40 asientos 2+2 y bodega de equipaje) y `boatTemplate` (4 camarotes de 2 camas, zona libre de 60, cubierta de carga, bodega en una segunda cubierta y aforo de 70). Las dos plantillas cumplen todas las reglas (prueba unitaria) |
| Asignación a vehículos | Una versión **publicada** de un layout no archivado, a un vehículo no retirado de la misma modalidad (y del mismo tipo si el layout lo fija), en un rango de fechas `[desde, hasta)`. La base impide el solapamiento por vehículo (`EXCLUDE` con `daterange`; 409 «ya tiene un layout asignado en esas fechas»). Se termina o se acorta con `valid_to`, sin borrar. Una versión o un layout no se archivan mientras estén asignados hoy o después |
| Fondo de referencia | `background_asset_id` (una imagen de fondo del plano) se pospone: no hace falta para el criterio y añadiría archivos |

### API de la empresa (permiso `layouts.manage`)

| Ruta | Categoría |
|---|---|
| `GET /api/v1/layouts` (con sus versiones, el resumen de cada una y los vehículos asignados), `POST` (borrador inicial vacío o con un documento), `PUT /{id}`, `POST /{id}/archive`, `POST /{id}/restore` | READ / CONFIGURE |
| `GET /api/v1/layouts/{id}/versions/{n}` (documento, problemas e inventario derivado), `PUT /{id}/draft`, `POST /{id}/publish`, `POST /{id}/versions/{n}/archive` | READ / CONFIGURE |
| `GET /api/v1/vehicles/{id}/layout-assignments`, `POST`, `POST /{asignación}/end` | READ / CONFIGURE |

### Base de datos (migración `20261113030000_fase6_3_layouts`, reversión en su cabecera)

- **Tablas** de tenant con RLS forzado:
  - `vehicle_layouts`, con FK compuesta al tipo con su modalidad;
  - `layout_versions`;
  - `layout_zones`, `layout_elements` (camarote padre por FK compuesta) y `capacity_rules`;
  - `vehicle_layout_assignments`.
- **Triggers:**
  - `layout_versions_guard`: nace como borrador; el borrador se edita; una versión publicada solo se archiva; una archivada no cambia; la identidad no cambia; no se borra;
  - `layout_children_guard`: zonas, elementos y reglas solo se insertan mientras su versión es borrador, es decir, al publicarla, y nunca se modifican ni se borran;
  - `vehicle_layout_assignments_guard`: solo de una versión publicada; solo cambia el fin; no se borra.
- **CHECK:**
  - `draft_slot` coherente con el estado;
  - publicada ⇔ con fecha y autor;
  - tamaño del documento ≤ 1 MB;
  - formato de los códigos, cubierta, posición, rotación y capacidad;
  - lo asignable es de inventario y está en una zona;
  - solo las camas tienen padre, y solo un camarote no asignable se vende completo;
  - capacidad positiva;
  - fin posterior al inicio.
- **Exclusión:** `(tenant, vehículo, daterange(desde, hasta))` sin solaparse (`btree_gist`, que ya existía desde la Fase 2).
- **Privilegios:**
  - `yebo_app`: SELECT e INSERT; UPDATE por columnas en layouts (no la modalidad), versiones y el fin de las asignaciones; **ningún UPDATE ni DELETE** en zonas, elementos y reglas;
  - `yebo_backoffice`: SELECT.
- **Permiso `layouts.manage`:** módulo `LAYOUTS`, en la plantilla Administrador y en los roles Administrador existentes.

### Pruebas

- **Contratos (9 nuevas, 26 en total):**
  - las dos plantillas cumplen el esquema y las reglas;
  - filas 2+2, con códigos 1A a 10D y pasillo;
  - camarote de 3 camas;
  - documento vacío; códigos repetidos, elementos solapados o fuera de su zona o cubierta;
  - zonas solapadas, con un servicio o una dimensión que su tipo no admite, sin capacidad o sin nada que vender;
  - camarotes: capacidad igual a la suma de sus camas, camas dentro y de 1 o 2, vender completo solo con camas;
  - inventario derivado de la lancha (camas, camarotes padre, 6 pools con el aforo) y del bus (40 asientos), y un camarote sin camas que se vende entero.
- **`layouts.int-spec` (8):**
  - crear vacío o desde una plantilla, con sus problemas y su inventario; nombre repetido → 409; modalidad no operada, tipo de otra modalidad o campo desconocido → 400;
  - un borrador a medias se guarda, y publicarlo → 400 con el motivo exacto;
  - publicar materializa 4 zonas, 13 elementos, 5 reglas y el aforo; se comprueban el padre, la asignabilidad y la clase de precio de un camarote, una cama y un rótulo; sin borrador → 409;
  - la empresa que no opera carga ni encomiendas no publica esas zonas (dos motivos);
  - versión 2 sin tocar la 1, y las dos publicadas;
  - asignar con solapamiento → 409; terminar; fin no posterior al inicio → 400; encadenar; otra modalidad, un borrador u otro tipo → 400 con su motivo;
  - no se archiva una versión ni un layout en uso; sí una versión sin uso, que ya no se puede asignar;
  - reglas de la base:
    - una versión publicada no cambia ni vuelve a borrador (P0001);
    - no se añade contenido a una publicada (P0001);
    - sin UPDATE ni DELETE de elementos, reglas y versiones, ni de la modalidad (42501);
    - dos borradores → 23505;
    - solapamiento → 23P01;
    - sin contexto, 0 filas;
  - aislamiento, sin permiso → 403, y empresa suspendida (consulta, pero no guarda).
- **Inventario actualizado:**
  - matriz de privilegios: +12 de tabla y +17 de columna, exactamente las concedidas;
  - siembra de permisos de `access.int-spec`;
  - registro de modelos de tenant;
  - reinicio de datos de las pruebas.
- **Mutaciones (11), todas detectadas:**
  - publicar sin reglas;
  - sin comprobar los servicios;
  - camarote padre asignable;
  - asignar de otra modalidad;
  - asignar de otro tipo;
  - archivar una versión en uso;
  - archivar un layout en uso;
  - «en uso» que ignora el fin;
  - solapamiento sin 409;
  - versión archivada asignable;
  - fin no posterior al inicio.
- **Totales:**
  - integración: 28 suites y 410 pruebas ✅;
  - E2E: 25 + 3 opcionales ✅;
  - tipos, lint, formato y unitarias ✅.

### Pendiente

- ✅ Migración aplicada a `yebo_dev` el 2026-11-11, con copia previa (`~/yebo-backups/yebo_dev-antes-6.3-20261111122227.dump`).
- La 6.4 (editor y pantallas del panel) usará `validateLayout`, `deriveInventory`, los generadores y las plantillas.

## Etapa 6.4 · Pantallas del panel y editor de planos

### Maqueta (aprobada el 2026-11-11)

[Flota y layouts · maqueta 6.4](https://claude.ai/artifact/GnxN1hT53uQQyYCrmWHvmg) (privada), con cuatro pantallas: editor del plano, Planos, Flota y Ubicaciones. Se aprobó la versión 5, tras la crítica de Impeccable y cuatro rondas de cambios pedidas por el responsable.

**Crítica de Impeccable (`critique`):**
- **Ejecución degradada:** dos evaluaciones aisladas sobre el código de las pantallas, porque la maqueta no se pudo renderizar en local.
- **Resultado:** 26/40.
- **Detector:** 9 avisos, todos falsos positivos (fuente de la marca y relleno en contenedores).
- **Contraste:** todos los textos cumplen AA; fallaba el indicador de la pestaña activa (turquesa, 2,13:1).
- **El responsable eligió corregir los P1 y P2:**
  - teclado del plano: un solo punto de Tab; flechas para navegar; Enter toma, flechas mueven, Enter deja y Esc devuelve; selección y foco distintos;
  - deshacer y autoguardado;
  - zonas y aforo editables;
  - versión 2 coherente entre pantallas y fechas sin ambigüedad;
  - diálogo «Nuevo plano» por modalidad.
- **Decisiones del responsable:**
  - editor = plano con zonas editables, no una pestaña aparte de capacidades;
  - un documento vencido **solo avisa**: YEBO nunca bloquea un vehículo por documentos.

**Rondas de cambios del responsable (2026-11-11):**
1. **Medidas reales.** Cada piso tiene largo y ancho en metros. La grilla sale de ellas con la escala que la empresa elige al crear el plano (25 o 50 cm por celda), y la escala no cambia después.
2. **Pisos.** Lanchas de 2, 3 y hasta 4 pisos de pasajeros: se añaden y se quitan pisos, hasta 6 con la bodega incluida.
3. **Asientos y camas.**
   - En cualquier piso, filas de asientos de 2 o 3 por lado, combinables (2+2, 3+3, 2+3, 3+2) y mezcladas en el mismo piso.
   - Camarotes de 1 a 4 camas y camas sueltas, siempre que el piso tenga la zona de ese tipo.
   - «Crear zona» de cualquier tipo en el piso elegido.
4. **Zonas mixtas y edición de zonas.**
   - Las zonas de pasajeros con elementos (asientos, VIP y camarotes) admiten asientos, camarotes y camas mezclados. Cada elemento lleva su propia clase de precio.
   - Asiento individual además de las filas.
   - Las zonas se mueven y cambian de tamaño en metros, siempre dentro del piso.
5. **Editor a la altura de la ventana.** En escritorio, solo se desplazan las columnas laterales y el plano queda siempre a la vista. En móvil, la pantalla se apila.

**«Planos» en la interfaz.** El nombre técnico (`layouts`) se mantiene en la API y en la base.

### Cambios al modelo de la 6.3 (aprobados con la maqueta)

| Cambio | Detalle |
|---|---|
| Hasta 6 pisos | `LAYOUT_LIMITS.decks` pasa de 4 a 6, bodega incluida. Una migración nueva cambia los CHECK de la 6.3: versiones de 1 a 6 cubiertas; zonas y elementos en las cubiertas 0 a 5 |
| Medidas reales y escala | Documento `schemaVersion` 2: `cellCm` (25 o 50) y, en cada piso, `lengthM` y `widthM`. La grilla se calcula (`deckGrid`). Límites: 30 m de ancho y 100 m de largo; con 25 cm, la grilla llega a 120 × 400 celdas. En `yebo_dev` no hay ningún layout guardado, así que no hay datos que convertir |
| Zonas mixtas | En `ZONE_RULES`, SEATING, VIP y CABINS admiten asientos, camarotes y camas. La clase de precio por defecto depende del elemento: asiento → la de la zona (GENERAL o VIP); cama → CAMA; camarote → CAMAROTE |
| Generadores a escala | `seatRows` con 2 o 3 asientos por lado y un pasillo de 1 m; el asiento mide 0,5 m y la fila 1 m. `cabin` de 1 a 4 camas de 1 × 2 m. Camas sueltas. Las celdas se calculan con la escala del plano. Las plantillas pasan a ser la «Lancha de 3 pisos», la «Lancha rápida» y el «Bus 2+2» |

### División

| Parte | Contenido | Estado |
|---|---|---|
| **6.4a · Modelo ajustado** | Lo de la tabla anterior en contratos, migración y API, con sus pruebas (unitarias, integración y mutaciones) | ✅ Aprobada el 2026-11-11 (`ad4d6e6`). Migración `20261114010000_fase6_4a_layouts_v2` aplicada a `yebo_dev` el 2026-11-11, con copia previa (`~/yebo-backups/yebo_dev-antes-6.4a-20261111140645.dump`) |
| **6.4b · Pantallas de Ubicaciones, Flota y Planos** | En el panel de la empresa (`apps/web`), según la maqueta | ✅ Aprobada el 2026-11-11 (`6bb0ae8`) |
| **6.4c · Editor del plano** | Según la maqueta, con `validateLayout`, `deriveInventory`, generadores y plantillas de contratos | ✅ Aprobada el 2026-11-16 (`c0d3e19`). Tipos, lint, formato, pruebas de `apps/web` (25) y compilación ✅ |
| **6.4d · E2E y revisión** | Recorrido con Playwright y axe, y `critique` de Impeccable sobre las pantallas renderizadas | ✅ Aprobada el 2026-11-17 (`1314e11`; ver abajo) |

Cada parte se aprueba por separado, como en la 4.7.

### 6.4d · E2E y revisión (implementada el 2026-11-16; aprobada el 2026-11-17, `1314e11`)

**E2E `08-flota-planos.spec.ts`** (proyecto `flota`, 11 pruebas). La empresa de prueba es fluvial, con pasajeros y encomiendas, y su administradora se registra desde la invitación. axe (WCAG 2.1 AA) en cada pantalla y diálogo:
- **Ubicaciones:** puerto con departamento, provincia y distrito (ubigeo 250101); sucursal con su mostrador `MOSTRADOR-PUC`.
- **Nuevo plano:** con una sola modalidad no se pide elegirla y el bus no se ofrece. «En blanco» pide medidas y escala; la plantilla «Lancha rápida» abre el editor.
- **Editor a la altura de la ventana (ronda 5 de la maqueta):** a 1440 × 900 la página no se desplaza. Al bajar en la columna izquierda, la cabecera y el plano siguen a la vista.
- **Teclado del plano:**
  - un solo punto de Tab (los otros 40 elementos con `tabindex=-1`);
  - las flechas recorren los elementos;
  - Enter toma, las flechas mueven y Esc devuelve a su sitio;
  - Enter deja el elemento, y «Deshacer» lo devuelve;
  - Supr quita, con un aviso que permite deshacer.
- **«Antes de publicar»:**
  - una fila 2 + 3 que no cabe: el mensaje lo avisa, el botón pasa a «Corregir N datos para publicar» y cada problema lleva al elemento;
  - «Deshacer» deja el plano publicable.
- **Pisos y zonas:**
  - piso nuevo renombrado;
  - zona libre creada en el primer tramo libre, acortada, movida y sin salir del piso;
  - aforo de 12 personas.
- **Autoguardado:** al recargar, el piso y la zona siguen ahí.
- **Publicar y versión nueva:**
  - el diálogo resume pisos, asientos y personas, y la ficha publicada queda de solo lectura;
  - «Editar en una versión nueva» crea el borrador de la versión 2 a partir de la publicada.
- **Flota:**
  - tipo y vehículo (código y matrícula en mayúsculas);
  - asignación de la versión 1, «Vigente»;
  - Planos muestra «asignado a 1 vehículo» y ya no ofrece archivar el plano.
- **Modo oscuro y 390 px:** Ubicaciones, Flota, Planos y el editor. axe en todas, y a 390 px nada se desplaza en horizontal.

**Defectos encontrados y corregidos:**
- **El editor no ocupaba la altura de la ventana** (6.4c). A 1440 × 900 la página entera se desplazaba 1353 px y el plano salía de la vista. La causa: con `flex-1` (base 0 %) dentro de `main`, el alto lo ponía el contenido y no `h-dvh`. Ahora la raíz del editor usa `flex-none` desde 1100 px. El E2E fallaba antes del cambio y pasa después.
- **«Terminar hoy» en la ficha del vehículo** (6.4b). Su nombre accesible («Terminar … hoy») no contenía el texto visible: axe `label-content-name-mismatch`, WCAG 2.5.3. Ahora es «Terminar hoy la asignación de …».

**Crítica de Impeccable:**
- **Detector** sobre 10 capturas: 141 avisos, todos falsos positivos.
  - `cramped-padding` (109), `overused-font` (10) y `marquee` (10): los mismos de las fases 4 y 5.
  - `codex-grid-background` (6): es la cuadrícula del plano, una superficie de medida.
  - `nested-cards` (6): es el lienzo del plano dentro de su tarjeta.
  - Telemetría desactivada (`~/.impeccable/config.json`).
- **Revisión de las capturas** (claro, oscuro y 390 px): sin más defectos de funcionamiento.

**Mejoras menores aplicadas** (aprobadas por el responsable el 2026-11-17):
- **Rótulo de orientación:** el editor ya no pone «Proa» fijo encima de todo plano. Dice «Proa» en los fluviales y «Frente» en los terrestres, y no aparece si el piso ya trae su propio rótulo (las plantillas fluviales traen «Proa», que salía dos veces).
- **Avisos con el nombre de la zona:** los mensajes de `validateLayout` y el de servicio no operado de la API dicen «se sale de su zona «Asientos»» en vez del código interno (`ASIENTOS`). El código repetido sigue mostrando el código, que es el dato a corregir.
- **Texto de los elementos ajustado a su ancho:** con filas de dos cifras («10A») el texto se salía del asiento en «Mediana». Ahora el tamaño de letra se ajusta al ancho, entre 8 y 12 px. El E2E lo comprueba en 1A, 10A y 10D: fallaba antes del cambio (−4 px) y pasa después.
- **Lista de zonas:** el borde de los botones usa `border-control` (3:1), como la lista de plantillas, y ya se ve en modo oscuro.
- **Comentario de `meters()`:** decía «coma decimal». es-PE usa punto, como el resto del panel.
- **`.prettierignore`:** excluye `ubigeo-inei.json`, minificado a propósito.
- **No aplicada:** las tildes del catálogo de ubigeo. Viene de su fuente sin tildes en sus ~1 900 nombres («Calleria», «Huanuco», «Junin»…). Corregirlo pide otra fuente o una tabla de corrección: queda como tarea aparte.

**Totales:**
- E2E: 36 + 3 opcionales; con capturas, 38 + 1 ✅;
- `apps/web`: 25 unitarias; contratos: 29; integración de planos en la API: 9 ✅;
- tipos, lint y formato ✅.

## Etapa 6.5 · Agencias (según F6-Q2)

### División

| Parte | Contenido | Estado |
|---|---|---|
| **6.5a · Modelo y API** | Tabla `agencies` con su canal `EXTERNAL_AGENCY`, permiso `agencies.manage` y rutas detrás del módulo `AGENCIES`, con sus pruebas (unitarias, integración y mutaciones) | ✅ Aprobada el 2026-11-17. Migración sin aplicar a `yebo_dev` |
| **6.5b · Pantalla en el panel** | «Agencias» en el panel de la empresa, visible solo con el módulo encendido; lista, alta, edición y archivar, con E2E y axe | Pendiente de autorización |

### 6.5a · Decisiones de implementación

| Tema | Decisión |
|---|---|
| Datos (F6-Q2) | Nombre, RUC y contacto (persona, teléfono y correo, opcionales). Sin comisiones ni usuarios de agencia: llegan con la venta (Fase 8) y la liquidación (Fase 11), cuando D7 esté validado |
| RUC | 11 dígitos con prefijo de contribuyente (10, 15, 17 o 20) y dígito verificador (módulo 11 de SUNAT), comprobado en contratos (`isValidRuc`); la base comprueba el formato. Único por empresa, también entre las archivadas (se restaura en vez de repetirla). No cambia después del alta (privilegio por columna) |
| Canal de venta | Cada agencia nace con su canal `EXTERNAL_AGENCY` en la misma transacción: código `AGENCIA-<RUC>` y nombre «Agencia <nombre>» (recortado a 80 caracteres). El enlace va del canal a la agencia (`sales_channels.agency_id`), como el mostrador con su sucursal: canal de agencia ⇔ con agencia (CHECK) y uno por agencia (UNIQUE) |
| Estado | Como en el resto de la fase: nada se borra, se archiva. Al archivar la agencia su canal se desactiva, y al restaurarla vuelve a estar activo; el canal de una agencia archivada no se reactiva (409). Una agencia activa puede pausar su canal sin archivarse |
| Módulo `AGENCIES` | Apagado por defecto (no está en ningún plan). Todas las rutas llevan `@RequiresModule('AGENCIES')`: sin él, 403 `MODULE_NOT_ENABLED` aunque la persona tenga el permiso. YEBO lo enciende con una excepción de módulo; al terminarla, las rutas vuelven a responder 403 y los datos se conservan |
| Diccionario de datos | Se actualizó `agencies` y `sales_channels` a lo implementado. El borrador anterior traía `sales_channel_id`, `legal_name`, `contact jsonb`, `status ACTIVE|SUSPENDED|TERMINATED` y `settlement_frequency`; lo que pida la liquidación se añadirá con D7 |

### API de la empresa (permiso `agencies.manage`, módulo `AGENCIES`)

| Método y ruta | Categoría | Qué hace |
|---|---|---|
| `GET /agencies` | READ | Agencias, activas primero y por nombre, con su canal |
| `POST /agencies` | CONFIGURE | Alta con su canal; RUC repetido → 409 |
| `PUT /agencies/:id` | CONFIGURE | Nombre y contacto (el RUC no se acepta) |
| `POST /agencies/:id/archive` y `/restore` | CONFIGURE | Archiva o restaura la agencia y su canal |

`GET /sales-channels` incluye ahora `agencyId` en cada canal (null en las demás clases).

### Base de datos (migración `20261117010000_fase6_5_agencies`, reversión en su cabecera)

- `agencies` de tenant con RLS forzado. `yebo_app`: SELECT, INSERT y UPDATE de nombre, contacto, `archived_at` y `updated_at` (sin RUC ni DELETE). `yebo_backoffice`: SELECT.
- `sales_channels.agency_id` con FK compuesta a `agencies` (tenant, id), CHECK `EXTERNAL_AGENCY` ⇔ con agencia y UNIQUE (tenant, agency_id). Su UPDATE no se concede.
- CHECK de nombre (2 a 80, sin espacios a los lados), RUC (formato) y contacto (largos y correo con @).
- Permiso `agencies.manage` (módulo `AGENCIES`) en la plantilla Administrador y en los roles Administrador existentes, que suben su versión de permisos.

### Pruebas

- **`agencies.spec` (5, contratos):** `isValidRuc` con RUC reales y con dígito, prefijo o largo equivocados; normalización (texto, correo en minúsculas, contacto vacío = null); campos de más; el RUC no se acepta al editar.
- **`agencies.int-spec` (9):**
  - módulo apagado: 403 `MODULE_NOT_ENABLED` en todas las rutas, aun con el permiso;
  - con el módulo encendido por YEBO: alta con su canal, datos normalizados, contacto opcional y nombre de 80 caracteres sin romper el del canal;
  - validación: RUC con dígito verificador, único por empresa (409) e inmutable; correo, teléfono y campos de más → 400;
  - archivar: el canal sigue a su agencia y no se reactiva mientras está archivada; restaurar; pausar el canal de una agencia activa;
  - aislamiento: 404 entre empresas, el mismo RUC en otra empresa no choca, y RLS sin contexto y con el de otra empresa;
  - reglas de la base: RUC y agencia del canal sin cambios y sin borrados (42501); canal de agencia sin agencia u otra clase con agencia → 23514; dos canales para una agencia → 23505; RUC mal formado → 23514;
  - sin permiso → 403 y sin sesión → 401;
  - empresa suspendida: consulta, pero no configura;
  - al terminar la excepción de YEBO, 403 de nuevo y los datos se conservan.
- **Inventario actualizado:** matriz de privilegios (+2 de tabla y +6 de columna), catálogo de permisos (`access.int-spec` reconoce la siembra), registro de modelos y tablas de tenant, y reinicio de datos de las pruebas.
- **Mutaciones (6), todas detectadas:** rutas sin el módulo; archivar sin desactivar el canal; reactivar el canal de una agencia archivada; RUC sin dígito verificador; nombre del canal sin recortar; alta sin canal.
- **Defecto de la 6.1 corregido:** el mostrador se llama «Mostrador <nombre>» y el canal admite 80 caracteres, como la sucursal; con un nombre de sucursal de más de 70, el alta fallaba con 500 (CHECK `sales_channels_text`). Ahora el nombre del mostrador se recorta a 80. `locations.int-spec` crea una sucursal de 80 caracteres: fallaba antes del cambio y pasa después.
- **Totales:**
  - integración: 29 suites y 420 pruebas ✅;
  - unitarias de la API: 146; contratos: 34 ✅;
  - E2E: 36 + 3 opcionales ✅ (sin cambios: el panel aún no muestra agencias);
  - tipos, lint y formato ✅.

### Pendiente

- Aplicar la migración a `yebo_dev`, con copia previa, cuando el responsable lo autorice.
- 6.5b · pantalla en el panel, con su propia autorización.

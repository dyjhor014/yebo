# Equipamiento de unidades e inspecciones preoperacionales (plan)

- **Estado:** ✅ Propuesto y **aprobado** por el responsable el 2026-11-19, con EQ-Q1 a EQ-Q10 tal como se recomendaron. La etapa 7.E1 (modelo y API) está aprobada; la 7.E2 (pantallas) va junto con la 7.5.
- **Rama prevista:** `fase-7/plan`, después del commit de la 7.4 (hoy en revisión), para no mezclar diffs.
- **Principio rector:** es una **herramienta opcional de control interno**. Ninguna regla de viajes, venta, asignación ni salida depende de ella. No sustituye ni equivale a una certificación o autorización del MTC ni de la DICAPI.

## Lo que ya existe y se reutiliza

| Pieza | Dónde | Uso aquí |
|---|---|---|
| Unidades (`vehicles`) con modalidad `LAND` o `RIVER`, tipo, estado y documentos | Fase 6.2 (`fleet`) | El equipamiento cuelga de la unidad; la modalidad orienta el catálogo |
| `vehicles.features` | Fase 6.2 | Son **comodidades para el pasajero** (wifi, aire): no se mezclan con el equipamiento de seguridad (EQ-Q7) |
| Archivos privados (`file_assets`, subida con límites, URL firmada) | Fase 6.2 (documentos de vehículos) | Fotos de evidencia: un tipo nuevo `INSPECTION_EVIDENCE`, siempre privado (EQ-Q5) |
| Viajes (`trips`) | Fase 7.3a | Relación **opcional** inspección → viaje |
| Autor de una acción (`*_by_kind` / `*_by_id`) | Fases 6.3 y 7.3a | Quién inspecciona, completa o rectifica |
| RLS forzado, FK compuestas `(tenant_id, …)`, privilegios por columna, triggers de inmutabilidad | ADR-003, ADR-025 y ADR-034 | Igual en todas las tablas nuevas |
| Pantalla de Flota | `apps/web/app/panel/flota` | Sección «Equipamiento de la unidad» e historial de inspecciones |
| Ficha del viaje en el panel | **No existe todavía** (llega con la 7.5) | «Control preoperacional» se agrega con esa pantalla (EQ-Q1) |

## Modelo propuesto

| Tabla | Contenido | Reglas |
|---|---|---|
| `equipment_catalog_items` (global, de YEBO) | Sugerencias sembradas: código, nombre, modalidad `LAND`, `RIVER` o `GENERAL`, categoría (seguridad, emergencia, operación), si suele tener vencimiento o número de serie y una **referencia normativa orientativa** (texto) | Solo lectura para las empresas. No es una lista de obligatorios |
| `tenant_equipment_items` | Elementos personalizados de la empresa, con los mismos campos | De tenant, RLS. Se archivan, no se borran |
| `vehicle_equipment` | Lo que **declara cada unidad**: nombre propio (copiado del catálogo y editable), cantidad, descripción, estado (`OPERATIVE`, `DETERIORATED`, `INOPERATIVE`, `UNVERIFIED`), vencimiento, número de serie y, opcionalmente, de qué elemento del catálogo vino | De tenant. Cada unidad tiene sus propios datos. «Eliminar» = archivar (EQ-Q6) |
| `vehicle_inspections` | Unidad, viaje opcional, estado (`DRAFT`, `COMPLETED`, `COMPLETED_WITH_OBSERVATIONS`), inicio y fin, responsable, observaciones generales, **conteos** al completar (conformes, observados, no operativos, no disponibles), la inspección que rectifica (si es una rectificación) y una **copia de la unidad** (código, nombre, matrícula) | Completada = inmutable (trigger). El viaje, si lo hay, es de la misma unidad |
| `vehicle_inspection_items` | **Copia histórica** de cada elemento verificado (nombre, cantidad declarada, número de serie, vencimiento) y su resultado (`CONFORMING`, `OBSERVED`, `NOT_OPERATIONAL`, `NOT_AVAILABLE`), la cantidad encontrada (opcional) y la observación | La copia no cambia aunque cambie el equipamiento de la unidad |
| `vehicle_inspection_evidence` | Foto (archivo privado) de un elemento o de la inspección | Solo mientras es borrador; después, inmutable |

Los elementos se guardan como **filas**, no como JSON: se consultan, se cuentan y se relacionan con la historia.

## Flujo

1. **Declarar** (opcional): en la ficha de la unidad, al crearla o después, se agregan elementos desde el catálogo de YEBO, desde el de la empresa o escritos a mano. Una unidad sin equipamiento es válida.
2. **Inspeccionar** (opcional): se crea una inspección en borrador para una unidad (con o sin viaje). Se cargan los elementos declarados en ese momento, con su copia histórica. Se marca el resultado de cada uno con controles grandes y rápidos (pensados para el celular), con observaciones y fotos.
3. **Completar:** con todos los elementos marcados. Si todos están conformes, queda `COMPLETED`; si alguno no, `COMPLETED_WITH_OBSERVATIONS`. Desde ese momento no cambia.
4. **Rectificar** (EQ-Q4): una inspección completada no se edita. Se crea una **rectificación**, que es una inspección nueva que apunta a la original, con su autor y su motivo. La original queda visible y marcada como rectificada.
5. **Historial:** por unidad y por viaje (fecha, responsable, viaje, resultado y conteos), con el detalle completo de cada inspección.

## Decisiones por aprobar

| Id | Pregunta | Recomendación | Alternativas |
|---|---|---|---|
| **EQ-Q1** | ¿Dónde va en el roadmap? | Una etapa nueva de la Fase 7 en dos partes: **7.E1 · modelo y API**, después del commit de la 7.4, y **7.E2 · pantallas**, junto con la 7.5. Ahí se incluyen la sección de la unidad en Flota, la inspección en el celular, el historial y el «Control preoperacional» de la ficha del viaje, **con maqueta y revisión con Impeccable antes del código**, como en toda pantalla | Todo después de cerrar la Fase 7; o una fase propia |
| **EQ-Q2** | ¿Cómo se hace opcional? | **Sin módulo contratable:** está disponible para todas las empresas y no usarla no cambia nada. Ningún flujo la exige ni la menciona como pendiente. Los permisos deciden quién la ve | Un módulo `INSPECTIONS` que YEBO enciende por empresa (más control comercial, un paso más para usarla) |
| **EQ-Q3** | Catálogo | **Global de YEBO** (terrestre, fluvial y general, con la referencia normativa como **orientación**, sin exigir nada) **más uno propio de cada empresa**. El elemento de la unidad copia el nombre y se puede editar | Solo el catálogo propio de cada empresa (vacío al inicio) |
| **EQ-Q4** | Corregir una inspección completada | **Rectificación:** una inspección nueva enlazada a la original, que conserva su contenido y queda marcada como rectificada | Solo una inspección nueva sin enlace |
| **EQ-Q5** | Fotos | Reutilizar `file_assets` (tipo `INSPECTION_EVIDENCE`, privado; JPEG, PNG o WebP; hasta 5 MB y hasta 5 fotos por elemento), como los documentos de vehículos | Sin fotos en esta etapa |
| **EQ-Q6** | Eliminar equipamiento de una unidad | **Archivar** (desaparece de la unidad y de las inspecciones nuevas; las anteriores lo conservan por su copia) | Borrar la fila (las inspecciones solo tendrían la copia) |
| **EQ-Q7** | `vehicles.features` | **Separado:** sigue siendo comodidades para el pasajero (wifi, aire, baño) | Unificar con el equipamiento |
| **EQ-Q8** | Efecto en la unidad y en los viajes | **Ninguno automático.** Un elemento «no operativo» no cambia el estado de la unidad ni bloquea viajes. La ficha del viaje solo **informa** la última inspección (o que no hay ninguna, sin tono de falta) | Un aviso visible en el viaje si la última inspección tiene observaciones |
| **EQ-Q9** | Permisos | `equipment.manage` (declarar equipamiento y gestionar el catálogo propio; CONFIGURE), `inspections.perform` (crear, completar y rectificar; **FULFILL**, para que siga con la empresa suspendida) y `inspections.read`. En las plantillas Administrador (todos) y, cuando existan, Embarque y Tripulación (inspeccionar) | Un solo permiso `fleet.manage` para todo |
| **EQ-Q10** | Cantidad encontrada | Opcional por elemento (p. ej., «38 de 40 chalecos»). Si es menor que la declarada, el resultado sugerido es «Observado», pero el usuario decide | Sin cantidad encontrada |

## Normativa (orientación, no reglas)

- **Terrestre:** DS 017-2009-MTC (Reglamento Nacional de Administración de Transporte) y RD 367-2010-MTC/15 (botiquín).
- **Fluvial:** DS 014-2006-MTC (Reglamento de Transporte Fluvial) y RD 970-2022-MGP/DICAPI (RESEP-FLUVIAL).
- El catálogo **cita** estas normas como referencia de cada elemento sugerido. **No** codifica obligaciones: lo exigible depende del servicio, la categoría del vehículo, el arqueo, la capacidad y la norma vigente. La pantalla lo dice en una línea: «Herramienta de control interno; no reemplaza las inspecciones ni certificaciones de la autoridad».
- **Los textos del catálogo semilla se validan contigo antes de sembrarlos.** Propondré una lista corta por modalidad, sin afirmar cantidades legales.

## Pruebas previstas

- **Integración:**
  - RLS y aislamiento en todas las tablas;
  - una unidad sin equipamiento se guarda;
  - catálogo global de solo lectura y catálogo propio aislado entre empresas;
  - la inspección copia el equipamiento del momento y **no cambia** al editar la unidad (prueba explícita);
  - una inspección completada es inmutable (por la API y en la base);
  - rectificación enlazada;
  - un viaje de otra unidad no se enlaza;
  - conteos y resultado general;
  - fotos privadas con límites;
  - permisos y estados del tenant.
- **Prueba de opcionalidad:** el criterio de la Fase 7 (crear, abrir, bloquear) corre igual en una empresa que **nunca** declaró equipamiento ni inspeccionó.
- **E2E (7.E2):** declarar en Flota, inspeccionar en el celular (con axe y teclado), historial y ficha del viaje.

## Fuera del alcance

- Alertas de vencimiento por correo o notificaciones (podrían reutilizar las de documentos más adelante).
- Firmas digitales, inspecciones sin conexión (Fase 14) e informes para la autoridad.
- Mantenimiento y órdenes de trabajo.

## Etapa 7.E1 · Modelo y API (aprobada el 2026-11-19)

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Módulo | `equipment` (capa L1): `EquipmentService` (catálogo y equipamiento de la unidad), `InspectionsService` y sus controladores. Contrato `equipment.ts` (con `INSPECTION_DISCLAIMER` y `suggestedResult`). Ningún otro módulo depende de este |
| Catálogo semilla | 16 sugerencias (tabla abajo), validadas por el responsable. Las referencias dicen «Referencia orientativa» y no afirman cantidades ni obligaciones |
| Declarar | En lote (1 a 100 por envío, todos o ninguno), hasta 200 activos por unidad; el origen (catálogo de YEBO o de la empresa) es opcional y no se edita después. Vencimiento: vigente, por vencer (30 días) o vencido, según el calendario de la empresa. «Eliminar» archiva |
| Inspeccionar | Exige equipamiento declarado (400 con el motivo); la unidad no retirada; el viaje, si se indica, de la empresa, de esa unidad y no cancelado. Se copian la unidad y los elementos activos en ese momento, en orden de categoría y nombre |
| Rectificar | Copia los **elementos de la original** (lo verificado en aquel momento, no el equipamiento actual) y hereda su viaje. La original figura como rectificada cuando la rectificación se completa |
| Completar | Con todos los elementos marcados; resultado general `COMPLETED` si todos están conformes y `COMPLETED_WITH_OBSERVATIONS` si no; conteos fijos |
| Fotos | En el cuerpo (JPEG, PNG o WebP, hasta 5 MB). Se **recodifican a JPEG sin metadatos** (EXIF y ubicación), con el lado mayor ≤ 2000 px. Hasta 5 por elemento y 10 generales. Se ven solo con sesión y permiso (`private, no-store`, CSP `sandbox`). Al quitar una foto o descartar el borrador se borran del almacenamiento |
| Autor | Quién inicia y quién completa, con su nombre (membresías de la empresa) o «Soporte de YEBO» |
| Opcional | Viajes, apertura, venta y bloqueos no consultan estas tablas; la prueba lo comprueba con una empresa que nunca las usó. El control preoperacional del viaje solo informa |

### Catálogo semilla (validado por el responsable el 2026-11-19)

| Código | Nombre | Modalidad | Categoría | Vence | Serie | Referencia orientativa |
|---|---|---|---|---|---|---|
| BOTIQUIN | Botiquín de primeros auxilios | General | Emergencia | Sí | No | Terrestre: RD 367-2010-MTC/15. Fluvial: RESEP-FLUVIAL |
| EXTINTOR | Extintor | General | Seguridad | Sí | Sí | Terrestre: DS 017-2009-MTC. Fluvial: RESEP-FLUVIAL |
| GPS | GPS o sistema de localización | General | Operación | No | Sí | — |
| LINTERNA | Linterna | General | Emergencia | No | No | — |
| NEUMATICO_REPUESTO | Neumático de repuesto | Terrestre | Operación | No | No | — |
| TRIANGULOS | Conos o triángulos de seguridad | Terrestre | Seguridad | No | No | DS 017-2009-MTC |
| CINTURONES | Cinturones de seguridad | Terrestre | Seguridad | No | No | DS 017-2009-MTC |
| HERRAMIENTAS | Herramientas de emergencia | Terrestre | Emergencia | No | No | — |
| MARTILLO | Martillo rompevidrios | Terrestre | Emergencia | No | No | — |
| CHALECO_SALVAVIDAS | Chalecos salvavidas | Fluvial | Seguridad | Sí | No | RESEP-FLUVIAL y DS 014-2006-MTC |
| CHALECO_INFANTIL | Chalecos salvavidas infantiles | Fluvial | Seguridad | Sí | No | RESEP-FLUVIAL |
| ARO_SALVAVIDAS | Aros salvavidas | Fluvial | Seguridad | No | No | RESEP-FLUVIAL |
| RADIO | Equipo de comunicación (radio) | Fluvial | Operación | No | Sí | — |
| ACHIQUE | Equipo de achique | Fluvial | Emergencia | No | No | — |
| LUCES_NAVEGACION | Luces de navegación | Fluvial | Operación | No | No | RESEP-FLUVIAL |
| BENGALAS | Señales pirotécnicas (bengalas) | Fluvial | Emergencia | Sí | No | — |

### API de la empresa

| Ruta | Permiso y categoría |
|---|---|
| `GET /api/v1/equipment-catalog` | `equipment.manage`, READ |
| `POST /api/v1/equipment-catalog`, `PUT /{id}`, `POST /{id}/archive`, `POST /{id}/restore` | `equipment.manage`, CONFIGURE |
| `GET /api/v1/vehicles/{vehicleId}/equipment?archived=true` | `inspections.read`, READ |
| `POST /api/v1/vehicles/{vehicleId}/equipment` (lote), `PUT /{id}`, `POST /{id}/remove` | `equipment.manage`, CONFIGURE |
| `GET /api/v1/vehicles/{vehicleId}/inspections` (historial), `GET /api/v1/trips/{tripId}/inspections` (control preoperacional), `GET /api/v1/inspections/{id}`, `GET /api/v1/inspections/{id}/photos/{photoId}` | `inspections.read`, READ |
| `POST /api/v1/inspections` (o rectificación), `PUT /{id}` (observaciones), `PUT /{id}/items/{itemId}`, `POST /{id}/complete`, `DELETE /{id}` (descartar borrador), `POST /{id}/photos?itemId=`, `DELETE /{id}/photos/{photoId}` | `inspections.perform`, FULFILL |

### Base de datos (migración `20261123010000_fase7_e1_equipment_inspections`, reversión en su cabecera)

- **Tablas:** `equipment_catalog` (global, de solo lectura), `tenant_equipment_items`, `vehicle_equipment`, `vehicle_inspections`, `vehicle_inspection_items` y `vehicle_inspection_evidence`, las de empresa con RLS forzado y FK compuestas.
- **CHECK:** textos, cantidades, origen único, rectificación con motivo, completada con fecha, autor y conteos, y elementos.
- **Triggers:**
  - `inspections_guard`: nace en borrador; el viaje es de la misma unidad; se rectifica una completada de la misma unidad; completar exige todos los resultados y conteos exactos; completada no cambia ni se borra;
  - `inspection_children_guard`: elementos y fotos solo con la inspección en borrador; la foto de un elemento, de esa inspección.
- **`file_assets`:** el tipo `INSPECTION_EVIDENCE` (privado, JPEG, hasta 5 MB); el valor del enum se agrega con `IF NOT EXISTS` (no se puede quitar al revertir).
- **Privilegios:**
  - `yebo_app`: SELECT del catálogo; INSERT y UPDATE por columnas del catálogo propio y del equipamiento (sin DELETE); inspecciones, elementos y fotos con INSERT, DELETE (solo borradores, por trigger) y UPDATE solo del resultado, la observación, las notas y la finalización;
  - `yebo_backoffice`: SELECT.
- **Permisos:** `equipment.manage`, `inspections.perform` e `inspections.read` (módulo `FLEET`), en la plantilla Administrador y en los roles Administrador existentes.
- **`yebo_dev`:** migración aplicada el 2026-11-19, con copia previa.

### Pruebas

- **`equipment.int-spec` (10):**
  - **opcional**: sin equipamiento, el viaje se crea, se abre y se bloquea igual, y el control preoperacional queda vacío sin nada pendiente;
  - catálogo: las 16 sugerencias por modalidad con su referencia orientativa; catálogo propio con nombre único y aislado;
  - equipamiento: lote con vencimientos (por vencer, vigente y vencido), validación todo o nada, origen no editable, eliminar archiva;
  - inspección: copia, falta marcar, resultados con cantidad encontrada y observación, conteos y resultado general, inmutable (por la API), **la copia no cambia al editar o eliminar el equipamiento**, historial de la unidad y control preoperacional del viaje (sus inspecciones y la última de la unidad);
  - rectificación: copia los elementos de la original, hereda el viaje y marca la original al completarse; solo de completadas; descartar un borrador;
  - fotos: sin metadatos tras la recodificación, cabeceras privadas, general y de elemento, tipo no válido, elemento ajeno, quitar borra el archivo, completada no recibe fotos, descartar borra las fotos;
  - viaje de otra unidad, ajeno o cancelado, y unidad retirada;
  - reglas de la base: inmutable, no se borra, completar sin resultados o con conteos que no cuadran, viaje de otra unidad, CHECK, privilegios y regla del tipo de archivo;
  - aislamiento (404 y 400) y RLS en las cinco tablas de empresa;
  - permisos: 403 sin los permisos, 401 sin sesión; suspendida inspecciona y completa (FULFILL) pero no declara (CONFIGURE).
- **Unitarias:** `equipment.spec` en contratos (3).
- **Mutaciones detectadas (12):** en el servicio, rectificación que copia lo actual, completar con pendientes, borrador sin estado, viaje de otra unidad, foto con metadatos, unidad retirada, copia con elementos eliminados, código de catálogo sin validar y resultado general siempre completo; en la base, completada editable, conteos sin comprobar y elementos sin guardia.
- **Resultado (2026-11-19):** integración completa 488/488 (incluida la prueba de deriva de migraciones); unitarias: API 157, contratos 63, web 25 y panel de plataforma 18; lint, tipos y formato sin errores.

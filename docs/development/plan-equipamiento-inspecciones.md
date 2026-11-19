# Equipamiento de unidades e inspecciones preoperacionales (plan)

- **Estado:** ✅ Propuesto y **aprobado** por el responsable el 2026-11-19, con EQ-Q1 a EQ-Q10 tal como se recomendaron. La etapa 7.E1 (modelo y API) está autorizada; la 7.E2 (pantallas) va junto con la 7.5.
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

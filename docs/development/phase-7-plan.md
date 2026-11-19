# Fase 7 · Rutas, programación y viajes (plan)

- **Estado:** ✅ Decisiones F7-Q1 a F7-Q8 **aprobadas** por el responsable el 2026-11-18, tal como se recomendaron; F7-Q9 (trazas y mapa con **teselas propias**) decidida por el responsable el mismo día. Etapa 7.1 autorizada el 2026-11-18 y aprobada el 2026-11-19 (migración aplicada a `yebo_dev`); 7.2 autorizada y aprobada el 2026-11-19 (migración aplicada a `yebo_dev`); 7.3 autorizada el 2026-11-19 y dividida en 7.3a (viajes) y 7.3b (programaciones); 7.3a aprobada el mismo día (migración aplicada a `yebo_dev`); 7.3b aprobada el mismo día (migración aplicada a `yebo_dev`); 7.4 autorizada.
- **Rama:** `fase-7/plan`, desde el cierre de la Fase 6 (`3fce518`).
- **Criterio de aceptación** ([roadmap](roadmap.md)): «Ruta multiparada con capacidad correcta por tramo».

## Lo que ya está decidido en la arquitectura

| Fuente | Decisión |
|---|---|
| data-dictionary §5 | `routes` y `route_stops` (orden `seq`, minutos desde el origen, tiempo de parada, si se puede subir o bajar), `fares` (origen × destino × servicio × clase de precio, con vigencia), `schedules` (recurrencia RRULE, hora local, zona horaria, unidad y plano por defecto), `trips` (con sus estados), `trip_stops` (copiadas de la ruta), `trip_resources`, `trip_capacity_pools`, `trip_pool_segment_usage`, `pool_allocations`, `resource_allocations`, `trip_vehicle_changes` y `trip_incidents` |
| capacity-and-inventory §1–4 | Un viaje de la parada `a` a la `b` ocupa el rango `[a, b)`. **Asignables** (asiento, cama, camarote sin camas, espacio): `resource_allocations` con exclusión GIST. **Agregados** (zona libre, bodega, cubierta, aforo total): un contador por pool y tramo, con bloqueo en orden `(pool_id, segment_seq)` y `CHECK (used <= capacity)`. Las filas por tramo se materializan **al abrir la venta**, nunca de forma perezosa |
| ADR-007 y ADR-026 | Exclusión GIST + contadores por tramo; antes de insertar, bloqueo de los recursos hoja `ORDER BY id`. Los conflictos son errores de dominio (`ResourceUnavailableError`, `CapacityExceededError`), nunca interbloqueos |
| capacity-and-inventory §6 | Suite obligatoria contra PostgreSQL real (8 pruebas: 50 ventas por un asiento, tramos contiguos y superpuestos, camarote frente a camas, pool con 25 ventas concurrentes, multi-pool en orden inverso, expiración y reventa, reconciliación). Prueba de concepto en la Fase 2 (`test/poc/inventory`); **suite completa en las fases 7 y 8** |
| ADR-010 | La versión de plano publicada no cambia; el viaje la referencia y materializa su inventario. Las tarifas también se versionan: una venta guarda un snapshot de la tarifa |
| Fase 6.3 | `deriveInventory(version)` (contratos) da los recursos y los pools que materializa un viaje. `vehicle_layout_assignments` dice qué plano tiene cada vehículo en una fecha |
| multitenancy §5 | Rutas y tarifas: `CONFIGURE`. **Crear viajes o programaciones y abrir viajes a la venta: `NEW_COMMERCIAL`**. Confirmar, iniciar, llegar y cerrar viajes con ventas: `FULFILL` |
| system-overview §4 | `routes`, `schedules + trips` son módulos de la capa **L1**; el módulo `inventory` se construye en la Fase 7 a partir de la prueba de concepto |

**Fuera de esta fase por la arquitectura:** la venta (reservas, boletos, retenciones de clientes y precios aplicados), el embarque y el manifiesto (Fase 8); las encomiendas en viaje (Fase 9) y la carga (Fase 10).

## Etapas propuestas

| Etapa | Contenido | Verificación |
|---|---|---|
| **7.1 · Rutas** | `routes` y `route_stops`: paradas en orden sobre las ubicaciones de la 6.1, con minutos desde el origen (viajes de varios días en río), tiempo de parada y si se puede subir o bajar. Modalidad de la ruta (terrestre o fluvial). Editar las paradas de una ruta no cambia los viajes ya creados (se copian a `trip_stops`). Archivado en vez de borrado. **Traza de cada tramo** (F7-Q9): una línea GeoJSON hacia la parada siguiente, cargada por la API o importada de un GPX o KML, con sus kilómetros calculados | Integración: RLS y aislamiento, paradas consecutivas sin repetir `seq`, al menos 2 paradas, origen con subida y destino con bajada, minutos crecientes, permisos y estados del tenant. Trazas: límites de puntos y de tamaño, coordenadas dentro del Perú, extremos cerca de sus paradas, GPX y KML válidos e inválidos (incluidos archivos hostiles: XML con entidades externas) |
| **7.2 · Tarifas** (según F7-Q1) | `fares` por par origen–destino de la ruta, servicio y clase de precio (GENERAL, VIP, CAMA, CAMAROTE, CABINA, TOLVA…), con vigencia (`valid_from`, `valid_to`). Una tarifa vigente no se edita: se crea otra con nueva vigencia (ADR-010). Consulta «precio de A a B en la clase X en la fecha F» y lista de pares y clases sin precio | Integración: sin vigencias solapadas para la misma clave, pares que respetan el sentido de la ruta, montos positivos en PEN, consulta por fecha |
| **7.3 · Viajes y programaciones** | Viaje puntual (`ON_DEMAND`) y programaciones (según F7-Q2) que generan viajes hasta un horizonte. Cada viaje copia sus paradas con horas planificadas en la zona horaria de la empresa. Unidad y plano: el vehículo de la modalidad de la ruta y el plano que tiene asignado en esa fecha (o uno elegido). **Materialización** (según F7-Q3): `trip_resources` y `trip_capacity_pools` desde `deriveInventory`; al abrir la venta, las filas por tramo. Estados según F7-Q4 | Integración: generación idempotente (sin viajes duplicados por fecha), paradas y horas copiadas, inventario materializado igual a `deriveInventory`, no se abre a la venta sin plano, transiciones válidas e inválidas, `NEW_COMMERCIAL` en los estados del tenant |
| **7.4 · Inventario por tramo** (según F7-Q5) | Módulo `inventory` de producción, a partir de la prueba de concepto: asignar y liberar recursos y cupos en `[a, b)` con exclusión GIST y contadores, retenciones con vencimiento, **bloqueos operativos** (`holder_type = BLOCK`: tripulación, mantenimiento, cortesía) y la **disponibilidad por tramo** de un viaje (por recurso y por pool) | La suite §6 completa contra PostgreSQL, ahora sobre las tablas reales con RLS. Invariante de reconciliación tras cada prueba. Mutaciones del motor |
| **7.5 · Pantallas** | En el panel de la empresa: rutas (paradas en orden, con teclado), tarifas (matriz origen × destino por clase), programaciones, viajes (lista por fecha) y la ficha del viaje con su **disponibilidad por tramo** y los bloqueos. **Maqueta primero y revisión con Impeccable** antes del código, como en la 4.7, la 5.4 y la 6.4 | E2E con axe, modo oscuro y móvil, uso con teclado |
| **7.6 · Mapa** (F7-Q9) | **Teselas propias**: un extracto del Perú de OpenStreetMap en un archivo PMTiles, con sus fuentes y sus íconos, servido por el mismo origen (Nginx, con peticiones por rangos), sin ningún servicio externo. MapLibre cargado solo en las pantallas con mapa. En **Ubicaciones**: elegir la posición en el mapa. En **Rutas**: ver las paradas y las trazas, dibujar o corregir una traza con clics e importar un GPX o KML; sin traza, línea recta. Script reproducible para generar o descargar el archivo con versión fija; el archivo no va en git. Atribución de OpenStreetMap (ODbL) | Unitarias del cálculo de distancia y de la importación. E2E con un extracto pequeño de prueba: el mapa carga sin peticiones a otros dominios, axe, y la lista de paradas sigue siendo usable con teclado sin el mapa |
| **7.7 · Cierre** | Prueba del criterio: la lancha de la 6.6 en la ruta **Pucallpa → Contamana → Yurimaguas → Iquitos** y el bus de dos pisos en una ruta terrestre de 3 paradas. Se abren a la venta y se ocupan con bloqueos en tramos superpuestos y contiguos: la disponibilidad de cada recurso y cada pool, tramo por tramo, es la esperada (escrita a mano). Resultados en `phase-7-results.md` | Criterio en la CI (integración) y en el E2E (con las pantallas) |

## Decisiones (aprobadas el 2026-11-18)

| Id | Pregunta | Recomendación | Alternativas |
|---|---|---|---|
| **F7-Q1** | ¿Tarifas en esta fase? | **Sí: modelo, API y pantalla** (7.2). La venta de la Fase 8 las necesita listas y probadas, y la matriz origen × destino × clase depende de la ruta. Sin descuentos, promociones ni precio por canal (`channel_kind` queda nulo): llegan con la venta | Posponerlas a la Fase 8, junto con la venta |
| **F7-Q2** | Alcance de la recurrencia | **Un subconjunto de RRULE**: diaria o semanal por días (`FREQ=DAILY` / `FREQ=WEEKLY;BYDAY=MO,WE,FR`), una hora de salida, vigencia y **fechas excluidas** (feriados, mantenimiento). Los viajes se generan hasta un horizonte (recomendado: **60 días**), con un botón «Generar» y un job diario del worker. Generar es idempotente: UNIQUE (programación, fecha de salida) | RRULE completa (mensual, cada N semanas…), más difícil de validar y explicar; o solo viajes sueltos, sin programaciones |
| **F7-Q3** | ¿Cuándo se materializa el inventario? | **Recursos y pools al fijar la unidad y el plano** del viaje (aún editable mientras está `PLANNED` y sin bloqueos); **filas por tramo al abrir la venta**, como dice la arquitectura. Desde `OPEN_FOR_SALE` el plano queda fijo: cambiar de unidad con ocupación es el flujo `trip_vehicle_changes` (Fase 8, porque necesita el mapeo de ventas) | Materializarlo todo al abrir la venta (no se puede revisar el inventario antes) |
| **F7-Q4** | Estados del viaje en esta fase | **`PLANNED`, `OPEN_FOR_SALE` (y volver a `PLANNED` si no hay ocupación) y `CANCELLED`** (sin ventas, con motivo). Las transiciones operativas (`CONFIRMED`, `BOARDING`, `DEPARTED`, `ARRIVED`, `CLOSED`) y las horas reales por parada llegan con el embarque (Fase 8), que es donde tienen sentido | Toda la máquina de estados ahora, sin pasajeros que embarcar |
| **F7-Q5** | ¿Motor de inventario en esta fase? | **Sí** (7.4): el criterio («capacidad correcta por tramo») se prueba ocupando el viaje. En esta fase solo ocupa con **bloqueos operativos** (`BLOCK`); las reservas (`BOOKING_ITEM`) lo usan en la Fase 8 sin cambiar el motor. La suite §6 completa se ejecuta aquí | Solo materializar y mostrar la capacidad; el motor y su suite en la Fase 8 (el criterio quedaría probado solo en papel) |
| **F7-Q6** | Viajes privados, mínimo de pasajeros y salida bajo demanda | **Modelar los campos** (`service_mode`, `min_passengers`, `confirmation_deadline`, `departure_kind`) y crear viajes `ON_DEMAND` sueltos. La lógica de mínimo y vencimiento (confirmar o cancelar) y los viajes privados (`PRIVATE`, fletamento) se posponen a la Fase 8 | Implementarlos ahora |
| **F7-Q7** | Paradas y ubicaciones | Las paradas usan las **ubicaciones de la empresa** (6.1). Una ruta fluvial avisa (sin impedir) si una parada no es puerto ni embarcadero. Una ruta solo admite vehículos de su modalidad | Exigir el tipo de ubicación según la modalidad |
| **F7-Q8** | Incidencias del viaje (`trip_incidents`) | **Posponerlas** a la operación del viaje (Fase 8, con el embarque) o a la Fase 14 (registro sin conexión) | Incluirlas ahora |
| **F7-Q9** | Trazas de las rutas en un mapa | **Decidida por el responsable (2026-11-18):** traza por tramo en GeoJSON (`jsonb`, sin PostGIS), dibujada a mano o importada de GPX o KML, con línea recta si falta; mapa con MapLibre y **teselas propias** (PMTiles del Perú en el mismo origen). El cálculo automático por carretera (OSRM u otro) queda para después. La lista de paradas sigue siendo el control principal; el mapa la acompaña | Servicio de teselas con cuenta (MapTiler, Stadia): más simple, con costo por uso y peticiones a un tercero |

**Permisos nuevos** (en la plantilla Administrador y en los roles Administrador existentes, como en la 6.1):
- `routes.manage`: rutas y paradas (`CONFIGURE`);
- `fares.manage`: tarifas (`CONFIGURE`);
- `trips.manage`: programaciones y viajes (crear, generar y abrir a la venta son `NEW_COMMERCIAL`; cancelar sin ventas también);
- `trips.block`: bloqueos operativos de recursos y cupos.

**Mapa y teselas (F7-Q9):**
- El archivo PMTiles del Perú pesa unos cientos de MB. Se guarda fuera de git, en un volumen o en el almacenamiento de archivos, y se actualiza con el script (p. ej., cada pocos meses).
- La CSP solo cambia para lo que MapLibre necesita del mismo origen (`worker-src blob:` y las teselas); no se agrega ningún dominio externo.
- Las fuentes y los íconos del estilo del mapa también son propios: un estilo por defecto que los pida a otro dominio rompería la regla.
- PostGIS no está en la imagen de PostgreSQL. Se agregaría solo cuando haga falta buscar por cercanía o seguir un viaje sobre su traza (fases 9 y 13).

**Zona horaria:** las horas se guardan como `timestamptz`; la hora local de la programación y de las paradas usa la zona horaria de la empresa (`America/Lima` por defecto). Los minutos desde el origen admiten viajes de varios días.

## Privilegios y seguridad (ADR-034)

- **Tablas nuevas de tenant con RLS forzado** y FK compuestas `(tenant_id, id)`, como en la Fase 6. `yebo_app` lee y escribe lo de su empresa con UPDATE por columnas; `yebo_backoffice` solo lee.
- **Sin DELETE** en rutas, tarifas, programaciones y viajes: se archivan o se cancelan, porque las ventas los referenciarán.
- **Inventario:** `trip_resources`, `trip_capacity_pools` y `trip_pool_segment_usage` no se modifican por la API salvo por el motor (`used`). `resource_allocations` y `pool_allocations` no se borran: se liberan (`RELEASED`). El CHECK y la exclusión son la garantía final.
- **Paradas de un viaje** congeladas al abrir la venta (trigger), igual que una versión de plano publicada.
- **Auditoría:** abrir a la venta, cancelar y bloquear guardan su autor. El registro de auditoría general sigue pendiente.

## Fuera del alcance de la Fase 7

- Venta, reservas de clientes, boletos, embarque y manifiestos (Fase 8). **Requisito del responsable (2026-11-19):** cada venta registra la información del pasajero (como mínimo nombre, tipo y número de documento, nacionalidad y si es menor de edad, según `booking_items.passenger_snapshot` y `customers` del diccionario de datos, con los datos personales cifrados), que alimenta el manifiesto de pasajeros.
- Cambio de unidad con ocupación (`trip_vehicle_changes`, Fase 8).
- Lógica de mínimo de pasajeros y viajes privados (F7-Q6, Fase 8).
- Incidencias del viaje (F7-Q8).
- Descuentos, promociones y precios por canal (Fase 8).
- Encomiendas y carga en viaje (fases 9 y 10), con su tarifario: por peso, por volumen o por ambos, según decida cada empresa.
- Publicación de horarios en el portal público (Fase 13); el mapa público de rutas llega con ella.
- Cálculo automático de trazas por carretera y búsquedas geográficas con PostGIS (F7-Q9).

## Pendientes heredados de la Fase 6

No bloquean esta fase: tildes del ubigeo, limpieza de archivos subidos sin usar, registro de auditoría general, tolva con cupo compartido (decisión de la Fase 8) y E2E en la CI.

## Etapa 7.1 · Rutas, paradas y trazas (aprobada el 2026-11-19)

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Módulo | `routes` (capa L1): `RoutesService`, `RoutesController` y el importador de trazas (`trace-import.ts`). Contrato en `@yebo/contracts` (`routes.ts`): esquemas y la geometría de las trazas, que la pantalla con mapa (7.6) reutilizará |
| Ruta | Código en mayúsculas (`^[A-Z0-9][A-Z0-9-]{1,15}$`), único por empresa y **que no cambia**, igual que la modalidad (privilegio por columna). La empresa debe operar esa modalidad (algún servicio activo). Se archiva y se restaura; no se borra |
| Paradas | De 2 a 50, en orden (`seq` desde 0), sobre ubicaciones **activas de la empresa**. Minutos desde la salida del origen (hasta 30 días) y minutos de parada (hasta 2 días). El origen tiene 0 minutos y permite subir; el destino permite bajar y no tiene traza. Cada parada llega después de salir de la anterior; dos paradas seguidas no son la misma ubicación (una ida y vuelta sí vale); una intermedia permite subir, bajar o ambas. Al editar, se **reemplazan enteras** en una transacción: nada referencia a una parada, y los viajes las copiarán (7.3) |
| Reglas en dos capas | El esquema Zod da los mensajes por campo (400). La base comprueba la **ruta completa al confirmar** con un trigger de restricción diferido (`route_stops_check`): aunque la API fallara, no se guarda una ruta con huecos, minutos que retroceden, origen o destino mal marcados o una sola parada |
| Ubicaciones | Se bloquean `FOR SHARE` al guardar la ruta. **Una ubicación no se archiva mientras sea parada de una ruta activa** (409 con los códigos de las rutas). Una ruta no se crea ni se restaura con una ubicación archivada (400) |
| Avisos (F7-Q7) | En una ruta fluvial, cada parada que no es puerto ni embarcadero da un aviso en `warnings` (no impide guardar) |
| Traza (F7-Q9) | `path_to_next`: GeoJSON `[[lng, lat], …]` de 2 a 2000 puntos hasta la parada siguiente, redondeado a 6 decimales y dentro del Perú. Solo entre paradas **ubicadas en el mapa**, y sus extremos a **≤ 5 km** de sus paradas (400 con el tramo y la distancia). Sin traza, el mapa dibujará una línea recta |
| Kilómetros | No se guardan: se calculan al leer (haversine). Por tramo: el largo de la traza o, sin ella, la línea recta entre las paradas; `null` si alguna no está ubicada. Desde el origen y total: `null` si algún tramo anterior no se puede medir. Así, ubicar una parada en el mapa actualiza los km sin migrar nada |
| Importar GPX o KML | `POST /routes/traces/import` con el archivo en el cuerpo (`application/gpx+xml`, `application/vnd.google-earth.kml+xml`, `application/xml` o `text/xml`; hasta 5 MB). Devuelve la traza para revisarla; **no guarda nada** (se guarda con la ruta). GPX: los puntos de las pistas en orden (o los de la ruta si no hay pista); KML: líneas y pistas `gx:Track`, sin los puntos sueltos. KMZ no se admite |
| Seguridad del importador | Sin analizador XML: un **recorrido lineal** de las etiquetas que solo extrae coordenadas. Rechaza `<!DOCTYPE` y `<!ENTITY` (XXE y expansión de entidades), etiquetas, comentarios e instrucciones sin cerrar, texto que no es UTF-8, números no válidos y puntos fuera del Perú. Ninguna expresión regular puede retroceder sobre el archivo entero: uno hostil de 5 MB se resuelve en milisegundos (prueba unitaria) |
| Simplificación | Una traza de GPS de cientos de miles de puntos se reduce a 2000 con **Visvalingam–Whyatt con montículo** (O(n log n) en cualquier traza), después de quitar los puntos a menos de ~5 m del anterior (ruido con el vehículo detenido). Douglas–Peucker se descartó: con una traza en zigzag se vuelve cuadrático (medido: no terminó en 2 minutos con 200 000 puntos) |
| Pantallas | Esta etapa es solo la API. Las rutas y el mapa tendrán pantalla en la 7.5 y la 7.6, con maqueta previa |

### API de la empresa

| Ruta | Permiso y categoría |
|---|---|
| `GET /api/v1/routes`, `GET /{id}` | `routes.manage`, READ |
| `POST /api/v1/routes`, `PUT /{id}` (nombre y paradas), `POST /{id}/archive`, `POST /{id}/restore` | `routes.manage`, CONFIGURE |
| `POST /api/v1/routes/traces/import` (cuerpo GPX o KML) | `routes.manage`, CONFIGURE |

### Base de datos (migración `20261118010000_fase7_1_routes`, reversión en su cabecera)

- **Tablas:** `routes` y `route_stops`, de tenant, con RLS forzado y FK compuestas `(tenant_id, …)` a la ruta y a la ubicación.
- **CHECK:** código y nombre de la ruta; `seq` de 0 a 49; minutos y minutos de parada en rango; traza nula o un arreglo de 2 a 2000 puntos.
- **UNIQUE:** (empresa, código) de la ruta; (ruta, `seq`) de la parada.
- **Trigger diferido** `route_stops_check`: las reglas de la ruta entera, al confirmar (`P0001` con el motivo).
- **Privilegios:**
  - `yebo_app`: `routes` SELECT, INSERT y UPDATE de nombre, archivado y fecha (sin DELETE); `route_stops` SELECT, INSERT y DELETE (se reemplazan; sin UPDATE);
  - `yebo_backoffice`: SELECT de ambas.
- **Permiso `routes.manage`:** módulo `ROUTES`, en la plantilla Administrador y en los roles Administrador existentes (sube su `permissions_version`).
- **`yebo_dev`:** migración aplicada el 2026-11-19, con copia previa.

### Pruebas

- **`routes.int-spec` (9):**
  - crear: paradas en orden, km por la traza o en línea recta (valores calculados a mano), aviso de Iquitos (ciudad) en una ruta fluvial;
  - validación: reglas de las paradas (400), código repetido (409), modalidad que la empresa no opera (400), ida y vuelta válida;
  - trazas: extremo a 6,6 km o a 9,5 km (400 con el mensaje exacto), parada sin ubicar en el mapa, puntos fuera del Perú; sin traza, km `null`;
  - editar: reemplaza las paradas; el código y la modalidad no se aceptan; una ruta archivada no se edita (409);
  - archivar: una ubicación no se archiva siendo parada de una ruta activa (409); ruta nueva o restaurada con una ubicación archivada (400);
  - importar: GPX y KML con los cuatro tipos de contenido, DOCTYPE → 400, JSON o PDF → 400, y no guarda nada;
  - reglas de la base: el trigger diferido rechaza al confirmar una sola parada, huecos en `seq`, minutos que retroceden, destino con traza, paradas seguidas repetidas y borrar todas las paradas; código y modalidad fijos, sin borrar rutas ni editar paradas (42501); CHECK (23514);
  - aislamiento: 404 y 400 entre empresas, y RLS con el contexto de otra empresa y sin contexto;
  - permisos (403 sin `routes.manage`, 401 sin sesión) y empresa suspendida (consulta, pero no configura ni importa).
- **Unitarias:** `routes.spec` en contratos (11: distancia, largo, límites del Perú, simplificación densa y hostil, reglas del esquema) y `trace-import.spec` en la API (8: GPX, KML con BOM, simplificación, DOCTYPE y entidades, archivos no válidos, etiquetas sin cerrar y archivos hostiles de 5 MB).
- **Mutaciones detectadas:** tolerancia de los extremos (1 falla), archivar una ubicación con rutas activas (1), km sin la traza (1), editar una ruta archivada (1), paradas en ubicaciones archivadas (2), aviso fluvial (1) y, en la base, quitar la regla de paradas seguidas repetidas del trigger (1).
- **Inventario actualizado:** matriz de privilegios (+4 de tabla y +3 de columna), registro de modelos y de tablas de tenant (`Route`, `RouteStop`; lo exigen las pruebas de RLS de la 3.1 y de rutas de migración), siembra de permisos de `access.int-spec` y limpieza de datos de las pruebas.
- **Resultado (2026-11-18):** integración completa 439/439; unitarias: API 154, contratos 45, web 25 y panel de plataforma 18; lint, tipos y formato sin errores.

## Etapa 7.2 · Tarifas (aprobada el 2026-11-19)

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Módulo | `fares` (capa L1): `FaresService` y `FaresController`. Contrato en `@yebo/contracts` (`fares.ts`): esquemas y reglas puras (`routePairs`, `layoutPriceClasses`, `farePhase`) que la pantalla de tarifas (7.5) reutilizará |
| Clave | Ruta + par **de ubicaciones** (origen → destino) + servicio + clase de precio. El par es de la ruta si se sube en el origen y se baja **después** en el destino; en una ida y vuelta (A → B → A) no hay A → A |
| Servicios | `PASSENGER` y `VEHICLE_TRANSPORT`, con tarifa por unidad, si la empresa los opera en la modalidad de la ruta. Encomiendas y carga tienen su propio tarifario en las fases 9 y 10: **por peso, por volumen o por ambos, según decida cada empresa** (indicación del responsable, 2026-11-19): 400 por el esquema y CHECK en la base |
| Clase de precio | Texto en mayúsculas, como en los planos (`GENERAL`, `VIP`, `CAMA`, `CAMAROTE`, `HAMACA`, `CABINA`, `TOLVA`, `VEHICULO`…); se normaliza a mayúsculas |
| Monto | Soles (`PEN`), mayor que 0, hasta S/ 99 999,99, con hasta 2 decimales (`numeric(7,2)`). Viaja como texto (`"45.50"`), sin coma flotante |
| Vigencia | Fechas del calendario de la empresa, `[desde, hasta)`: el día `validTo` ya no vale, como las asignaciones de planos de la 6.3. Sin `validTo`, sin fin. **Nada empieza ni termina antes de hoy**: el pasado no cambia |
| No se edita (ADR-010) | El monto, la clave y el inicio no cambian (privilegios por columna). **Cambio de precio:** al crear una tarifa, la activa de la misma clave que empezó antes y sigue vigente ese día **termina ese día** (la respuesta la devuelve en `ended`). Cualquier otro solapamiento (una tarifa que empieza ese día o después) es un 409 que nombra la tarifa, y no cambia nada. Una tarifa con fin (promoción) cabe antes de una programada; al terminar, no se restaura la anterior: se crea la siguiente |
| Terminar y anular | `end` mueve el fin (no antes de hoy ni del inicio; una tarifa terminada no se reabre). `cancel` anula una tarifa que **aún no empieza** (una que ya empezó se termina). Anulada es definitiva (trigger) |
| Creación por lotes | Hasta 500 tarifas por envío, todas o ninguna, con un servicio y una vigencia comunes: lo que llenará la matriz de la pantalla |
| Paradas editadas | Las tarifas de pares que dejan de existir se conservan con `onRoute: false`; la consulta de precio y la matriz no las usan. Si el par vuelve, valen otra vez |
| Matriz | Pares × clases en una fecha, con lo que falta. Clases: las de los **planos asignados** hoy o más adelante a vehículos no retirados de la modalidad de la ruta (recursos vendibles y zonas por cantidad de personas; el equipaje y la bodega no) y las que tienen tarifa vigente en la fecha |
| Concurrencia | Se crea con la ruta bloqueada `FOR SHARE` (sus paradas no cambian a mitad). Terminar o anular bloquea la tarifa. La exclusión de la base es la garantía final (409) |
| Sin `channel_kind` | El precio por canal llega con la venta (Fase 8; F7-Q1). Se agregará entonces a la clave y a la exclusión, en vez de tener ahora una columna siempre nula |

### API de la empresa

| Ruta | Permiso y categoría |
|---|---|
| `GET /api/v1/routes/{routeId}/fares` (historia), `GET …/fares/matrix?service&date`, `GET …/fares/quote?origin&destination&priceClass&service&date` | `fares.manage`, READ |
| `POST /api/v1/routes/{routeId}/fares`, `POST /api/v1/fares/{id}/end`, `POST /api/v1/fares/{id}/cancel` | `fares.manage`, CONFIGURE |

### Base de datos (migración `20261119010000_fase7_2_fares`, reversión en su cabecera)

- **Tabla:** `fares`, de tenant, con RLS forzado y FK compuestas `(tenant_id, …)` a la ruta y a las dos ubicaciones.
- **CHECK:** servicio, clase, moneda `PEN`, monto > 0, origen ≠ destino, fin posterior al inicio, y `cancelled_at` solo si está anulada.
- **EXCLUDE** `fares_no_overlap`: tarifas activas de la misma clave sin días en común (btree_gist y `daterange`).
- **Trigger** `fares_guard`: una tarifa anulada no cambia (`P0001`).
- **Privilegios:**
  - `yebo_app`: SELECT, INSERT y UPDATE solo de `valid_to`, `status`, `cancelled_at` y `updated_at` (sin DELETE);
  - `yebo_backoffice`: SELECT.
- **Permiso `fares.manage`:** módulo `FARES`, en la plantilla Administrador y en los roles Administrador existentes (sube su `permissions_version`).
- **`yebo_dev`:** migración aplicada el 2026-11-19, con copia previa.

### Pruebas

- **`fares.int-spec` (8):**
  - crear y consultar: montos normalizados, precio de A a B en una fecha (sin fecha, hoy), 404 con el mensaje exacto antes de la vigencia, 400 en sentido contrario, lista en el orden de los pares;
  - cambio de precio: la anterior termina el día que empieza la nueva; un solapamiento con una programada es 409 y no cambia nada; una promoción con fin cabe antes de la programada (precios día a día);
  - validación: inicio en el pasado, par en sentido contrario, ubicación que no es parada, servicio que la empresa no opera, CARGO, monto 0, fechas al revés, repetidos, lista vacía, ruta inexistente y ruta archivada (409); nada se guarda;
  - terminar y anular: fin en el pasado o antes del inicio (400), alargar hasta solaparse (409), no anular una que empezó, anulada definitiva, una terminada no se reabre;
  - matriz: la lancha de la 6.6 asignada da CAMA, CAMAROTE y GENERAL; 6 pares × 3 clases con 14 faltantes (contados a mano); una clase con tarifa que no está en los planos (VIP); al quitar Contamana de la ruta sus tarifas quedan fuera y vuelven con ella;
  - reglas de la base: EXCLUDE (23P01; contiguas, de otra clase o anuladas sí), cada CHECK por su nombre (23514), monto fuera de rango (22003), monto, inicio, clase y ruta fijos y sin DELETE (42501), trigger de anulada (P0001);
  - aislamiento: 404 entre empresas y RLS con el contexto de otra empresa y sin contexto;
  - permisos (403 sin `fares.manage`, 401 sin sesión) y empresa suspendida (consulta y cotiza, pero no configura).
- **Unitarias:** `fares.spec` en contratos (12: pares con subir y bajar e ida y vuelta, clases de los planos, normalización y reglas del esquema, estado de una tarifa).
- **Mutaciones detectadas (12):** sin cambio de precio (5 fallas), inicio en el pasado (2), par fuera de la ruta (2), anular una que ya empezó (3), cotizar fuera de la ruta (2), reabrir una terminada (2), ruta archivada (1), servicio no operado (2), clases sin los planos (1) y, en la base, el trigger de anulada (1), la exclusión sin el filtro de activas (3) y sin exclusión (2).
- **Inventario actualizado:** matriz de privilegios (+2 de tabla y +4 de columna), registro de modelos y de tablas de tenant (`Fare`), siembra de permisos de `access.int-spec` y limpieza de datos de las pruebas.
- **Resultado (2026-11-19):** integración completa 447/447; unitarias: API 154, contratos 57, web 25 y panel de plataforma 18; lint y tipos sin errores; formato sin cambios en lo versionado.

## Etapa 7.3a · Viajes, paradas e inventario materializado (aprobada el 2026-11-19)

La 7.3 se divide, como la 4.3 y la 6.5: **7.3a**, viajes puntuales (`ON_DEMAND`) con sus paradas, la unidad y el plano, el inventario y los estados; **7.3b**, programaciones (F7-Q2), generación idempotente hasta el horizonte y el job diario del worker.

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Módulo | `trips` (capa L1): `TripsService`, `TripsController` y la conversión de hora local (`local-time.ts`). Contrato en `@yebo/contracts` (`trips.ts`) |
| Hora local | La API recibe y devuelve horas **locales de la empresa** (`AAAA-MM-DDTHH:mm`, zona del tenant, `America/Lima` por defecto) y guarda instantes (`timestamptz`). La conversión sirve para cualquier zona IANA, con o sin horario de verano |
| Crear | Ruta activa de la empresa (bloqueada `FOR SHARE`), salida en el futuro y a no más de 400 días. Copia las paradas: llegada = salida + minutos desde el origen; salida de la parada = llegada + minutos de parada. El origen no tiene llegada ni el destino salida. Editar la ruta después no cambia el viaje |
| Código | `RUTA-AAMMDD-HHMM` (`PCL-IQT-261201-0800`), único por empresa. Si un viaje cancelado ya lo usa, `-2`, `-3`… Cambia si se mueve la salida de un viaje planificado |
| Unidad y plano (F7-Q3) | Vehículo de la empresa, no retirado, de la **modalidad de la ruta** y **libre en ese horario**. El plano: una versión **publicada** elegida (no archivada, de la modalidad y del tipo de vehículo) o, si no se elige, **la asignada al vehículo el día de la salida** (6.3). Sin plano, el viaje existe pero no se abre a la venta |
| Un vehículo, un viaje a la vez | **Nuevo respecto del plan:** un vehículo no está en dos viajes no cancelados cuyos horarios `[salida, llegada)` se solapan (409 que nombra el otro viaje; EXCLUDE en la base). Una lancha de 3 días y medio no puede salir todos los días: lo verá la generación de la 7.3b |
| Una ruta, una salida por hora | Una ruta no tiene dos viajes no cancelados a la misma hora (409; UNIQUE parcial) |
| Inventario | Al fijar la unidad y el plano: `trip_resources` (con su elemento del plano y la cama con su camarote) y `trip_capacity_pools` desde `deriveInventory`. Cambiar el plano o quitar la unidad lo reemplaza (solo con el viaje planificado) |
| Editar | Solo con el viaje planificado: la salida (las horas de las paradas se corren lo mismo), la unidad, el plano, el mínimo de pasajeros y su plazo |
| Abrir a la venta | Con unidad **activa** (no en mantenimiento ni fuera de servicio), plano, ruta activa y antes de la salida. Crea un contador por pool y tramo (`trip_pool_segment_usage`, con la capacidad del pool). Guarda quién y cuándo |
| Volver a planificar | Sin ocupación (contadores en 0; la 7.4 sumará asignaciones y bloqueos): borra los contadores |
| Cancelar | Planificado o a la venta, sin ocupación, con motivo (3 a 300 caracteres). Definitivo. Guarda quién y cuándo. Libera la hora de la ruta y la unidad |
| F7-Q6 | `service_mode` solo `SHARED` (CHECK); `min_passengers` y `confirmation_deadline` se guardan sin lógica (Fase 8) |
| Fuera de la 7.3a | `departure_date` y `schedule_id` (llegan con las programaciones, 7.3b); horas reales (`actual_*`) y estados operativos (Fase 8) |

### API de la empresa

| Ruta | Permiso y categoría |
|---|---|
| `GET /api/v1/trips?from&to&routeId&status` (hasta 62 días), `GET /{id}`, `GET /{id}/inventory` | `trips.manage`, READ |
| `POST /api/v1/trips`, `PUT /{id}`, `POST /{id}/open`, `POST /{id}/back-to-planned`, `POST /{id}/cancel` | `trips.manage`, NEW_COMMERCIAL (TRIAL, ACTIVE y PAST_DUE) |

### Base de datos (migración `20261120010000_fase7_3a_trips`, reversión en su cabecera)

- **Tablas:** `trips`, `trip_stops`, `trip_resources`, `trip_capacity_pools` y `trip_pool_segment_usage`, de tenant, con RLS forzado y FK compuestas `(tenant_id, …)`.
- **CHECK:** código, llegada posterior a la salida, mínimo de 1 a 1000, plazo anterior a la salida, solo `SHARED`, plano con unidad, autor de abrir y cancelar coherente, motivo; parada con alguna hora y salida ≥ llegada; recurso de un tipo asignable, capacidad y clase; pool con capacidad > 0 y alcance coherente; contador `0 ≤ used ≤ capacity` (`pool_within_capacity`).
- **EXCLUDE** `trips_vehicle_no_overlap`; **UNIQUE parcial** de ruta y hora; unicidad de pools en dos índices parciales.
- **Triggers:**
  - `trips_guard`: nace planificado; transiciones PLANNED ⇄ OPEN_FOR_SALE y → CANCELLED; cancelado no cambia; desde la apertura, unidad, plano, horas, código y mínimo fijos;
  - `trip_children_guard`: paradas, recursos y pools solo cambian con el viaje planificado;
  - `trip_segments_guard`: contadores solo se crean con el viaje a la venta y solo se borran vacíos con el viaje planificado;
  - `trip_consistency_check` (**diferido**): paradas 0..n-1 y al menos dos; a la venta, un contador por pool y tramo con la capacidad del pool; planificado, ninguno. Es una sola función de trigger: `yebo_app` no tiene EXECUTE sobre funciones (ADR-034).
- **Privilegios:**
  - `yebo_app`: `trips` SELECT, INSERT y UPDATE de sus columnas de estado, unidad, plano y horas (sin la ruta, el tipo ni el modo; sin DELETE); `trip_stops` SELECT, INSERT y UPDATE de sus horas; `trip_resources` y `trip_capacity_pools` SELECT, INSERT y DELETE; `trip_pool_segment_usage` SELECT, INSERT y DELETE (el UPDATE de `used` llega con el motor, 7.4);
  - `yebo_backoffice`: SELECT de las cinco.
- **Permiso `trips.manage`:** módulo `TRIPS`, en la plantilla Administrador y en los roles Administrador existentes.
- **`yebo_dev`:** migración aplicada el 2026-11-19, con copia previa.

### Pruebas

- **`trips.int-spec` (7):**
  - crear: paradas y horas locales calculadas a mano (Pucallpa 08:00 → Iquitos a los 3 días y medio), instante UTC, unidad y plano asignado; recursos y pools **iguales a `deriveInventory`**, con su elemento del plano y la cama con su camarote; editar la ruta no cambia el viaje; consulta por fechas, ruta y estado;
  - unidad y plano: salida pasada o lejana, otra modalidad, unidad ocupada en ese horario, ruta a la misma hora, versión en borrador, plano de otra modalidad, plano sin unidad, plazo después de la salida, ruta ajena o archivada, unidad retirada; sin plano, sin inventario; con plano elegido, su inventario; sin unidad;
  - editar: mover la salida corre las cuatro paradas y el código; cambiar el plano reemplaza el inventario; quitar la unidad lo borra;
  - abrir: contadores = pools × 3 tramos con su capacidad; queda fijo; autor; volver a planificar; sin plano (400); unidad en mantenimiento (409); cancelar con motivo, definitivo; un viaje nuevo a la misma hora lleva `-2`;
  - reglas de la base: nace planificado, CHECK, coherencia diferida sin paradas, EXCLUDE de la unidad (23P01), ruta a la misma hora (23505), transición no permitida, lo fijo desde la apertura, paradas, recursos y contadores protegidos, planificado con contadores, contadores en un viaje planificado, cancelado definitivo, privilegios (42501) y el CHECK del contador;
  - aislamiento entre empresas (404 y 400) y RLS en las cinco tablas;
  - permisos: 403 sin `trips.manage`, 401 sin sesión; NEW_COMMERCIAL permitido en PAST_DUE y bloqueado en SUSPENDED (consulta sí).
- **Unitarias:** `local-time.spec` (3: Lima, zona con horario de verano y una hora que no existe, días del calendario).
- **Mutaciones detectadas (17):** en el servicio, sin pools (3 fallas), sin control de modalidad (3), sin horario libre (3), sin plano asignado (4), un tramo menos al abrir (2), unidad en mantenimiento (2), paradas sin correr (2), volver sin borrar contadores (2), salida en el pasado (3), plano no publicado (3), ruta archivada (1) e inventario sin reemplazar (2); en la base, transiciones libres, paradas e inventario sin guardia, sin coherencia diferida y sin EXCLUDE de la unidad (1 cada una).
- **Inventario actualizado:** matriz de privilegios (+10 de tabla y +18 de columna), registro de modelos y tablas de tenant, siembra de permisos de `access.int-spec` y limpieza de datos de las pruebas. La prueba de deriva de migraciones detectó el índice `NULLS NOT DISTINCT` (Prisma no lo representa): se reemplazó por dos índices parciales.
- **Resultado (2026-11-19):** integración completa 454/454; unitarias: API 157, contratos 57, web 25 y panel de plataforma 18; lint, tipos y formato sin errores.

## Etapa 7.3b · Programaciones y generación de viajes (aprobada el 2026-11-19)

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Módulo | `SchedulesService` y `SchedulesController` en el módulo `trips`; `ScheduleRunnerService` (todas las empresas) y el job `TripSchedulesProcessor` del worker. Contrato `schedules.ts` con las reglas puras (`toRRule`, `fromRRule`, `occursOn`) |
| Recurrencia (F7-Q2) | Diaria o semanal por días. La API recibe `{ frequency, weekdays }` y guarda la RRULE normalizada (`FREQ=WEEKLY;BYDAY=MO,TH`, días en orden); la base solo admite ese subconjunto |
| Hora y zona | Hora de salida `HH:mm` local. La zona de la empresa se copia a la programación al crearla y es la que se usa para generar |
| Vigencia | `[desde, hasta)`, desde hoy en adelante (al editar, se puede conservar el inicio ya pasado). Hasta 100 fechas excluidas |
| Unidad y plano por defecto | Se validan como en un viaje (modalidad, versión publicada, tipo de vehículo). Si la unidad está libre en ese horario, cada viaje generado la lleva con su plano (el elegido o el asignado ese día) y su inventario; si no, **el viaje se crea sin unidad** y el resultado dice por qué (p. ej., la lancha de 3 días y medio que no vuelve a tiempo para la salida siguiente) |
| Generar | Fechas de la recurrencia en `[máx(hoy, desde), mín(hoy + 60, hasta))`, sin las excluidas. Se **omite** (con motivo) la fecha cuya hora ya pasó o en la que la ruta ya tiene otro viaje a esa hora. Cada viaje se crea por el mismo camino que un viaje puntual (`TripsService.insertTrip`). Bloquea la programación (`FOR UPDATE`) y la ruta (`FOR SHARE`) |
| Idempotencia | UNIQUE (programación, fecha local): una segunda generación no crea nada. **Un viaje generado y cancelado no se regenera** |
| Editar | Recurrencia, hora, vigencia, excluidas, unidad y plano. **Los viajes ya generados no cambian**: lo nuevo vale para las fechas que se generen después. Archivada: no se edita ni genera |
| Job diario | Todos los días a las 00:30 de Lima (`upsertJobScheduler`, un único planificador). Recorre las empresas **operativas** (TRIAL, ACTIVE y PAST_DUE, las que pueden hacer NEW_COMMERCIAL) y sus programaciones activas de rutas activas; cada empresa corre con su tenant y su zona en el contexto, con `yebo_app` y RLS. Un error en una programación se registra y no detiene las demás |
| Lista de empresas | `TenantDirectoryService` en el módulo `tenancy` (autorizado a usar `yebo_platform`, que solo lee `tenants`): no cambia ninguna frontera de seguridad |
| Sin permiso nuevo | Las programaciones son de `trips.manage`. Crear, editar, archivar, restaurar y generar son NEW_COMMERCIAL |

### API de la empresa

| Ruta | Permiso y categoría |
|---|---|
| `GET /api/v1/schedules`, `GET /{id}` | `trips.manage`, READ |
| `POST /api/v1/schedules`, `PUT /{id}`, `POST /{id}/archive`, `POST /{id}/restore`, `POST /{id}/generate` | `trips.manage`, NEW_COMMERCIAL |

### Base de datos (migración `20261121010000_fase7_3b_schedules`, reversión en su cabecera)

- **Tabla:** `schedules`, de tenant, con RLS forzado y FK compuestas a la ruta, el vehículo y la versión del plano.
- **`trips`:** `schedule_id` y `departure_date`, con CHECK (un viaje SCHEDULED tiene las dos; uno ON_DEMAND, ninguna) y UNIQUE (schedule_id, departure_date). Sin privilegio de UPDATE: no cambian.
- **CHECK de `schedules`:** código, RRULE del subconjunto, hora `HH:MM`, zona, solo `SHARED`, plano con unidad, fechas y hasta 100 excluidas.
- **Privilegios:** `yebo_app` SELECT, INSERT y UPDATE de recurrencia, hora, unidad, plano, vigencia, excluidas, generación y archivado (sin código, ruta, zona ni modo; sin DELETE); `yebo_backoffice` SELECT.
- **Requisito:** no hay viajes SCHEDULED previos (la 7.3a solo crea ON_DEMAND). Prisma no envuelve la migración en una transacción: si el CHECK fallara, quedaría a medias.
- **`yebo_dev`:** migración aplicada el 2026-11-19, con copia previa.

### Pruebas

- **`schedules.int-spec` (7):**
  - generar lunes y jueves a las 07:00 hasta 60 días sin la fecha excluida: lo esperado se calcula aparte (fechas, la de hoy si ya pasó la hora, y la lancha que toma una salida solo si ya volvió de la anterior). Comprueba los viajes SCHEDULED con su código, su hora local, su unidad, su plano y su inventario, y la idempotencia;
  - reglas: vigencia, la ruta ocupada por un viaje puntual a esa hora (omitida con motivo), un generado y cancelado no vuelve, editar la hora no cambia lo generado (lista de viajes día a día), archivar y restaurar;
  - validación: código repetido, vigencia pasada, recurrencias fuera del subconjunto, hora, fechas, unidad de otra modalidad, plano en borrador, ruta ajena, plano elegido, programación fuera del horizonte y la salida de hoy a las 00:00 (ya pasó);
  - job del worker: una empresa suspendida no genera; al reactivarse, sí; una tercera ejecución no crea nada; el worker registra un único planificador `30 0 * * *` en `America/Lima`;
  - reglas de la base: CHECK de viaje SCHEDULED y ON_DEMAND, UNIQUE por fecha (23505), CHECK de la RRULE, la hora y el modo, y privilegios (42501);
  - aislamiento (404 y 400) y RLS;
  - permisos: 403 sin `trips.manage`, 401 sin sesión, suspendida consulta pero no crea ni genera.
- **Unitarias:** `schedules.spec` en contratos (3: RRULE normalizada y de vuelta, día de la semana, reglas del esquema).
- **Mutaciones detectadas (12):** sin idempotencia (3 fallas), sin excluidas (2), sin recurrencia (1), sin choque de ruta (3), la unidad ocupada aborta la generación (2), hora pasada (1, con la salida de las 00:00), sin fin de vigencia (2), empresas no operativas en el job (1), horizonte más largo (2) y, en la base, sin el CHECK de viaje programado (1) y sin el de la RRULE (1).
- **Inventario actualizado:** matriz de privilegios (+2 de tabla y +11 de columna), registro de modelos y de tablas de tenant (`Schedule`) y limpieza de datos de las pruebas.
- **Resultado (2026-11-19):** integración completa 461/461; unitarias: API 157, contratos 60, web 25 y panel de plataforma 18; lint, tipos y formato sin errores. Una vez falló una unitaria de la API, solo al correr todo en paralelo con turbo, y no se repitió en siete corridas más; la sospechosa es la prueba de la 7.1 que exige leer un archivo hostil de 5 MB en menos de 3 s (sin confirmar).

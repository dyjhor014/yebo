# Fase 7 · Rutas, programación y viajes (plan)

- **Estado:** ✅ Decisiones F7-Q1 a F7-Q8 **aprobadas** por el responsable el 2026-11-18, tal como se recomendaron; F7-Q9 (trazas y mapa con **teselas propias**) decidida por el responsable el mismo día. Etapa 7.1 autorizada el 2026-11-18.
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

- Venta, reservas de clientes, boletos, embarque y manifiestos (Fase 8).
- Cambio de unidad con ocupación (`trip_vehicle_changes`, Fase 8).
- Lógica de mínimo de pasajeros y viajes privados (F7-Q6, Fase 8).
- Incidencias del viaje (F7-Q8).
- Descuentos, promociones y precios por canal (Fase 8).
- Encomiendas y carga en viaje (fases 9 y 10).
- Publicación de horarios en el portal público (Fase 13); el mapa público de rutas llega con ella.
- Cálculo automático de trazas por carretera y búsquedas geográficas con PostGIS (F7-Q9).

## Pendientes heredados de la Fase 6

No bloquean esta fase: tildes del ubigeo, limpieza de archivos subidos sin usar, registro de auditoría general, tolva con cupo compartido (decisión de la Fase 8) y E2E en la CI.

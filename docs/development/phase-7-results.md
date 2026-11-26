# Fase 7 · Resultados (rutas, programación y viajes)

- **Fecha:** 2026-11-25.
- **Rama:** `fase-7/plan`, desde el cierre de la Fase 6 (`3fce518`). Sin push ni PR.
- **Plan y decisiones:** [phase-7-plan.md](phase-7-plan.md): F7-Q1 a F7-Q9, aprobadas el 2026-11-18; M-Q1 a M-Q7 (mapa), aprobadas el 2026-11-25. Etapa adicional: [equipamiento e inspecciones](plan-equipamiento-inspecciones.md), con EQ-Q1 a EQ-Q10.
- **Criterio de aceptación** ([roadmap](roadmap.md)): «Ruta multiparada con capacidad correcta por tramo».
- **Estado:** ✅ **cumplido**. El responsable aprobó el cierre (7.7) el 2026-11-25. Lo demuestran:
  - una prueba de integración en la CI (`pnpm test:integration`), por la API de la empresa;
  - una prueba E2E en el navegador, desde la ficha del viaje.

## 1. Qué se construyó

| Etapa | Commit | Contenido |
|---|---|---|
| Plan | `48ca842` | Decisiones F7-Q1 a F7-Q9 |
| 7.1 · Rutas | `9c1f912` | `routes` y `route_stops`: paradas en orden, minutos desde la salida, tiempo detenido, sube y baja. Traza GeoJSON por tramo, importada de GPX o KML (archivos hostiles rechazados) |
| 7.2 · Tarifas | `c85cec0` | Precio por par de paradas, servicio y clase, con vigencia sin solaparse y cambios programados |
| 7.3a · Viajes | `73041da` | Viajes puntuales, paradas copiadas, unidad y plano por día, inventario materializado y estados |
| 7.3b · Programaciones | `f3013ba` | Programaciones con días, vigencia y fechas sin salida; generación hasta 60 días y job diario del worker |
| 7.4 · Inventario por tramo | `d2ca865` | Motor de inventario (rango semiabierto de paradas, recursos y cupos por tramo) y bloqueos operativos. Suite §6 completa. Candados consultivos (ADR-026) |
| 7.E1 · Equipamiento (API) | `a616a04`, `f16bbbb` | Equipamiento de unidades e inspecciones preoperacionales, opcionales y de control interno |
| 7.5 · Pantallas | `cdd0db6`, `53d00b9`, `de0280a`, `37f38b7` | Maqueta aprobada. Rutas y Tarifas (7.5a); Programaciones, Viajes y ficha del viaje (7.5b); equipamiento e inspección en el celular (7.5c = 7.E2) |
| 7.6 · Mapa | `33ccb15`, `a259a00` | Mapa propio con teselas del Perú en el mismo origen (MapLibre + PMTiles): posición de las ubicaciones y trazas dibujadas en las rutas |
| 7.7 · Cierre | este documento | Prueba del criterio por la API y con las pantallas |

**Migraciones:** las seis de la fase están aplicadas a `yebo_dev`, cada una con su copia previa en `~/yebo-backups/` y su reversión en la cabecera de la migración. Las etapas 7.5, 7.6 y 7.7 no tienen migración.

| Migración | Aplicada | Copia previa |
|---|---|---|
| `20261118010000_fase7_1_routes` | 2026-11-19 | `yebo_dev-antes-7.1-rutas-20261119000659.dump` |
| `20261119010000_fase7_2_fares` | 2026-11-19 | `yebo_dev-antes-7.2-tarifas-20261119003020.dump` |
| `20261120010000_fase7_3a_trips` | 2026-11-19 | `yebo_dev-antes-7.3a-viajes-20261119010820.dump` |
| `20261121010000_fase7_3b_schedules` | 2026-11-19 | `yebo_dev-antes-7.3b-programaciones-20261119014226.dump` |
| `20261122010000_fase7_4_inventory` | 2026-11-19 | `yebo_dev-antes-7.4-inventario-20261119022531.dump` |
| `20261123010000_fase7_e1_equipment_inspections` | 2026-11-19 | `yebo_dev-antes-7.E1-equipamiento-20261119024925.dump` |

## 2. El criterio de aceptación

Las dos pruebas usan **la lancha y el bus de dos pisos de la 6.6**, sin cambios. Sus planos están ahora en un módulo compartido ([`apps/api/test/support/criterion-layouts.ts`](../../apps/api/test/support/criterion-layouts.ts)) que usan el criterio de la Fase 6, el de la Fase 7 y su E2E. Las cifras esperadas están **escritas a mano**: no se calculan.

| | Lancha | Bus de dos pisos |
|---|---|---|
| Ruta | Fluvial, 4 paradas: Puerto Pucallpa → Contamana (+12 h) → Yurimaguas (+1 d 12 h) → Iquitos (+3 d 12 h). 3 tramos | Terrestre, 3 paradas: Terminal Pucallpa → Aguaytía (+3 h) → Tingo María (+6 h). 2 tramos |
| Lo que se vende | 6 camas (y cada camarote completo), zona libre de 30 personas, cubierta de carga (5000 kg y 10 m lineales), bodega (2000 kg y 10 m³) y aforo de 36 | 56 asientos en dos pisos (1A–4D y 5A–14D), bodega de equipaje (1500 kg y 8 m³) y aforo de 56 |
| Materializado al crear y abrir el viaje | 9 recursos (3 camarotes y 6 camas), 6 vendibles; 6 cupos × 3 tramos = 18 contadores | 56 recursos, 56 vendibles; 3 cupos × 2 tramos = 6 contadores |

Un bloqueo de la parada `a` a la `b` ocupa los tramos `a … b-1` (rango semiabierto): termina donde empieza el siguiente, así que **lo contiguo cabe** y **lo superpuesto choca**.

### 2.1 API (CI)

Prueba: [`apps/api/test/integration/phase7-criterion.int-spec.ts`](../../apps/api/test/integration/phase7-criterion.int-spec.ts) (6 pruebas).

Recorre la API real (módulos, guards, RLS, roles de base de datos y Redis). Una empresa nueva, con su administradora registrada desde la invitación, publica los dos planos, los asigna a sus unidades, arma las dos rutas, crea un viaje en cada una y lo abre a la venta. Después ocupa con bloqueos:

**Lancha · lugares** (libre en cada tramo: Pucallpa–Contamana, Contamana–Yurimaguas y Yurimaguas–Iquitos):

| Bloqueo | Resultado |
|---|---|
| Camarote C1 completo, de Pucallpa a Yurimaguas | Ocupa sus dos camas (C1-B1 y C1-B2) en los tramos 1 y 2 |
| Cama C1-B1, de Yurimaguas a Iquitos (**contiguo**) | Se acepta |
| Cama C2-B1, de Contamana a Iquitos (superpuesto con otro recurso) | Se acepta |
| Cama C1-B2, de Contamana a Yurimaguas (**superpuesto**, mismo recurso) | 409 «Ocupado entre Contamana y Yurimaguas: C1-B2» |
| Camarote C2 completo, de Pucallpa a Iquitos | 409 «Ocupado entre Contamana y Iquitos: C2-B1»: el tramo exacto donde choca, no todo lo pedido |

| Lugar | Libre por tramo |
|---|---|
| C1, C1-B1 | no · no · no |
| C1-B2 | no · no · **sí** |
| C2, C2-B1 | sí · no · no |
| C2-B2, C3, C3-B1, C3-B2 | sí · sí · sí |

**Lancha · cupos** (ocupado → libre, por tramo):

| Cupo | Bloqueos | Ocupado | Libre |
|---|---|---|---|
| Zona libre (30 personas) | 10 todo el viaje; 20 en el tramo 2; 20 en el tramo 3. Uno más en el tramo 2: 409 «La zona LIBRE (personas) sin capacidad entre Contamana y Yurimaguas» | 10 · 30 · 30 | 20 · 0 · 0 |
| Cubierta de carga (5000 kg) | 4000 kg en los tramos 1 y 2; 1000 kg en los tramos 2 y 3 | 4000 · 5000 · 1000 | 1000 · 0 · 4000 |
| Cubierta de carga (10 m lineales) | 6 m en los tramos 1 y 2 | 6 · 6 · 0 | 4 · 4 · 10 |
| Bodega (2000 kg y 10 m³) | Llena en el tramo 3. Un bloqueo de bodega y cubierta que excede la cubierta en el tramo 2: 409, y **no ocupa nada** | 0 · 0 · 2000 y 0 · 0 · 10 | 2000 · 2000 · 0 y 10 · 10 · 0 |
| Aforo (36) | 6 de tripulación todo el viaje | 6 · 6 · 6 | 30 · 30 · 30 |

Liberar los 20 del tramo 2 devuelve la capacidad **solo ahí**: un bloqueo de 1 cabe y la zona libre queda en 10 · 11 · 30.

**Bus de dos pisos** (Terminal–Aguaytía y Aguaytía–Tingo María):

| Bloqueo | Resultado |
|---|---|
| 1A y 1B en el tramo 1; 1A en el tramo 2 (**contiguo**); 5A (piso 2) todo el viaje; 14D en el tramo 2 | Se aceptan |
| 2A y 5A en el tramo 2 | 409 «Ocupado entre Aguaytía y Tingo María: 5A», y 2A queda libre |
| 14D, 1B, 2A y 5A todo el viaje (chocan en tramos distintos) | 409 «Ocupados entre Terminal Pucallpa y Aguaytía: 1B; entre Terminal Pucallpa y Tingo María: 5A; entre Aguaytía y Tingo María: 14D», y no se ocupa ninguno |
| Equipaje: 1000 kg y 5 m³ todo el viaje; 500 kg en el tramo 2. Un kilo más todo el viaje | 409 «La zona EQUIPAJE (kg) sin capacidad entre Aguaytía y Tingo María» |
| Aforo: 56 en el tramo 1. Uno más todo el viaje | 409 «El aforo de la unidad sin capacidad entre Terminal Pucallpa y Aguaytía» |

Resultado: 1A no · no, 1B no · sí, 5A no · no, 14D sí · no, 2A y 4D sí · sí; **53 asientos libres en cada tramo**; equipaje 1000 · 1500 kg (libre 500 · 0) y 5 · 5 m³ (libre 3 · 3); aforo 56 · 0 (libre 0 · 56).

**Nada a medias (§6.8):** en la base, los 24 contadores de los dos viajes (cupo × tramo) son exactamente la suma de sus asignaciones activas. Solo existen los bloqueos aceptados (11 en la lancha, uno de ellos liberado, y 7 en el bus); de los rechazados, ninguno.

**Mutación detectada:** con los bloqueos en rango **cerrado** (`[]`, ocupando también la parada final), fallan 3 de las 6 pruebas: los bloqueos contiguos chocan («Ocupado entre Yurimaguas y Iquitos: C1-B1»). Revertida, pasan las 6.

### 2.2 Navegador: la ficha del viaje (E2E)

Prueba: [`tests/e2e/specs/15-criterio-fase7.spec.ts`](../../tests/e2e/specs/15-criterio-fase7.spec.ts) (proyecto `criterio7`, 5 pruebas).

Otra empresa, con los mismos planos y las mismas dos rutas, y un viaje planificado en cada una. Desde la **ficha del viaje**:
- **Lancha:** «Abrir a la venta» muestra los tres tramos. Desde «Nuevo bloqueo»:
  - el camarote C1 y 10 de la zona libre de Pucallpa a Yurimaguas;
  - la cama `c1-b1` (en minúsculas) y 30 de la zona libre de Yurimaguas a Iquitos, contiguo;
  - C1-B2 entre Contamana y Yurimaguas: el diálogo muestra «Ocupado entre Contamana y Yurimaguas: C1-B2»;
  - 1 de la zona libre de Contamana a Iquitos: «La zona LIBRE (personas) sin capacidad entre Yurimaguas y Iquitos».
  
  Tramo por tramo, **elegido con el teclado**, las camas de C1 y C2 dicen «libre» u «ocupado» como se espera (C1-B2 queda libre solo en el último tramo). La tabla de cupos muestra la zona libre en 20 · 20 · 0 de 30 y el aforo en 36 de 36 en cada tramo.
- **Bus de dos pisos:** 1A y 1B en el tramo 1, 1A en el tramo 2 y 5A (piso 2) con 4 de aforo todo el viaje; 2A y 5A en el tramo 2 se rechaza con «Ocupado entre Aguaytía y Tingo María: 5A». Tramo 1: «Zona PASAJEROS · 14 de 16 libres» y «Zona PASAJEROS2 · 39 de 40 libres»; tramo 2: 15 de 16 y 39 de 40, con 1B libre y 14D libre. Aforo: 52 de 56 en los dos tramos.
- **Accesibilidad:** axe (WCAG 2.1 AA) con los bloqueos, con un rechazo en el diálogo, en modo oscuro y a 390 px (sin desplazamiento horizontal).

## 3. Totales

Entorno: 2026-11-25, Node 24.22.2, PostgreSQL 17.6 y Redis 7.4.6.

| Batería | Resultado |
|---|---|
| Integración (`pnpm test:integration`, CI) | 37 suites y **494 pruebas** ✅. Incluye los criterios de las fases 3, 4, 5, 6 y 7 |
| Unitarias de la API | 24 suites y 157 pruebas ✅ |
| Unitarias de `apps/web` | 34 ✅ |
| Unitarias del panel (`apps/platform`) | 18 ✅ |
| Contratos | 63 ✅ |
| E2E (Playwright y axe) | **78 ✅ y 3 opcionales** (las capturas y una prueba solo de pantallas estrechas). Se ejecuta en local, porque necesita Chromium; no forma parte de la CI |
| Tipos, lint y formato del monorepo | ✅. El formato solo avisa de `identidad/tokens/yebo-tokens.css`, que no está versionado |

## 4. Hallazgos del cierre

- **Una comprobación que pasaba en vacío · corregida:** la primera versión de la reconciliación del criterio consultaba la base con el rol del dueño, que está sujeto a RLS: no veía filas y «pasaba» sin comprobar nada. Ahora usa el rol que salta RLS y exige haber revisado los 24 contadores. **Revisión de las demás pruebas** (pedida por el responsable): de las consultas con el rol del dueño, 37 `SELECT` y 14 `UPDATE`, ninguna toca alguna de las 55 tablas con RLS forzado de `yebo_test`. Las que revisan filas usan tablas sin RLS de empresa (sesiones, códigos de autorización, empresas, usuarios y plataforma). No hay otro caso.
- **Mensaje de un lugar ocupado · cambiado a pedido del responsable:** nombraba el trayecto **pedido** («Ocupado entre Puerto Pucallpa y Iquitos: C2-B1», aunque C2-B1 solo está ocupado desde Contamana). Ahora el motor nombra, para cada lugar, el tramo exacto donde choca (del primer al último tramo ocupado dentro de lo pedido) y agrupa los lugares por tramo, ordenados por dónde empiezan. Los cupos ya lo hacían. Si la exclusión de la base salta en una carrera (la última garantía), no se sabe dónde choca y el mensaje sigue nombrando lo pedido. Se ajustó la prueba de la 7.4 («Ocupado entre Contamana y Yurimaguas: 1B», antes «…y Iquitos») y el criterio suma un caso con tres lugares que chocan en tramos distintos. Los mensajes de los E2E 12 y 15 no cambian: allí lo pedido coincide con el choque.
- **Planos compartidos:** los de la lancha, el bus y la pickup pasaron de la prueba de la Fase 6 a un módulo de apoyo. La prueba de la Fase 6 sigue igual y en verde.

## 5. Pendientes al cerrar la Fase 7

Anotados en cada etapa del plan. Ninguno impide cumplir el criterio.

| Pendiente | Origen |
|---|---|
| Mapa del **Perú completo**: hoy solo está generada una zona de prueba (Ucayali, Loreto y Junín, 332 MB, en `~/yebo-mapa`). Se genera con `scripts/maps/build-map.sh` ([mapa.md](mapa.md)) | 7.6 |
| Configuración de Nginx para `/mapa/` en producción (documentada; no hay infraestructura de producción en el repositorio) | 7.6 |
| Trazas calculadas por carretera (OSRM u otro) y búsqueda de lugares | F7-Q9 |
| Venta, reservas y **registro de los datos del pasajero** en cada venta y para el manifiesto, con el mismo motor de inventario | Fase 8 |
| ¿Tolva con cupo compartido de personas y carga? | 6.6, para la Fase 8 |
| Limpiar archivos subidos que nunca se usaron (documentos, sitio y fotos de inspección) | 5.2, 6.2, 7.E1 |
| E2E en la CI (requiere Chromium en el runner) | 4.7c |

**Datos de prueba en `yebo_dev`:** el módulo `AGENCIES` sigue encendido en «tormenta» (Fase 6). `apps/web/.env.local` apunta `YEBO_MAP_DIR` al mapa de prueba; es una configuración local, fuera de git.

## 6. Siguiente paso

1. ~~Aprobación del cierre y commit de la 7.7~~: hechos el 2026-11-25.
2. Push y PR de la Fase 7, con su autorización.
3. La Fase 8 no empieza sin aprobación expresa.

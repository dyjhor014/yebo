# Fase 6 · Resultados (ubicaciones, agencias, flota y capacidades)

- **Fecha:** 2026-11-17.
- **Rama:** `fase-6/plan`, desde el cierre de la Fase 5 y el estado de los PR apilados (`8b580c0`).
- **Plan y decisiones:** [phase-6-plan.md](phase-6-plan.md) (F6-Q1 a F6-Q7, aprobadas el 2026-11-10).
- **Criterio de aceptación** ([roadmap](roadmap.md)): «Embarcación con camarotes, zona libre, bodega y cubierta; bus con asientos y bodega».
- **Estado:** ✅ **cumplido**. El responsable aprobó el cierre (6.6) el 2026-11-17. Lo demuestran:
  - una prueba de integración en la CI (`pnpm test:integration`), por la API de la empresa;
  - una prueba E2E en el navegador, con el editor del panel.

## 1. Qué se construyó

| Etapa | Commit | Contenido |
|---|---|---|
| 6.1 · Ubicaciones, sucursales y canales | `025c8b1` | `locations` con ubigeo del INEI, `branches` con su mostrador y `sales_channels` (canal `ONLINE` por empresa). Ámbito de sucursal de las membresías (F6-Q4). Categoría CONFIGURE y permisos nuevos |
| 6.2 · Flota | `3158036` | Tipos de vehículo (catálogo global y propios), `vehicles` con su modalidad heredada del tipo y `vehicle_documents` con archivo privado y vencimiento (F6-Q5). Propiedad propia o de terceros (F6-Q3) |
| 6.3 · Layouts: modelo y reglas | `3bd5e6d` | Versiones inmutables (trigger), zonas, elementos y reglas de capacidad. `validateLayout` y `deriveInventory` en contratos, validación en el servidor y asignación a vehículos sin solaparse (exclusión) |
| 6.4 · Editor y pantallas | `ad4d6e6`, `6bb0ae8`, `c0d3e19`, `1314e11` | Layouts v2 (hasta 6 pisos, medidas reales, escala de 25 o 50 cm, zonas mixtas). Pantallas de Ubicaciones, Flota y Planos, y el editor del plano: grilla por piso, generadores, plantillas, teclado, deshacer, autoguardado y publicar. Maqueta aprobada antes del código y E2E con axe |
| 6.5 · Agencias | `e3c7bcc`, `00bf625` | Agencias externas con su canal `EXTERNAL_AGENCY`, detrás del módulo `AGENCIES` (F6-Q2), y su pantalla en el panel |
| 6.6 · Cierre | este documento | Prueba del criterio por la API y con el editor. Catálogo de tipos con Van y Camioneta pickup 4×4 |

**Migraciones:** las seis de la fase están aplicadas a `yebo_dev`, cada una con su copia previa en `~/yebo-backups/` y su reversión en la cabecera de la migración.

| Migración | Aplicada |
|---|---|
| `20261113010000_fase6_1_locations_branches` | 2026-11-10 |
| `20261113020000_fase6_2_fleet` | 2026-11-11 |
| `20261113030000_fase6_3_layouts` | 2026-11-11 |
| `20261114010000_fase6_4a_layouts_v2` | 2026-11-11 |
| `20261117010000_fase6_5_agencies` | 2026-11-17 |
| `20261117020000_fase6_6_vehicle_catalog` | 2026-11-17, con copia previa (`yebo_dev-antes-6.6-catalogo-20261117192943.dump`). Su reversión se probó en una transacción deshecha: deja el catálogo como estaba |

La 6.4b–d y la 6.5b no tienen migración. La de la 6.6 solo añade datos al catálogo global.

## 2. El criterio de aceptación

Los planos son los mismos en las dos pruebas. Las cifras esperadas están escritas a mano: no se calculan con `deriveInventory`.

A pedido del responsable, el criterio va más allá de lo mínimo:
- el bus es de **dos pisos**: los pisos, sus zonas y sus asientos se modelan igual en tierra que en el río (hasta 6 pisos, bodega incluida). Un bus de un piso es el mismo plano sin el piso 2;
- se suma una **camioneta pickup 4×4** de la selva: asientos en la cabina, más caros, y en la tolva pasajeros, más baratos, y carga. Una zona mide personas o carga, no las dos: la tolva se parte en dos tramos (ver el apartado 4).

| | Lancha | Bus de dos pisos | Pickup 4×4 |
|---|---|---|---|
| Pisos | Piso 1 (16 × 5 m) y Bodega (16 × 5 m) | Dos pisos de pasajeros (12 × 3 m cada uno) y la Bodega, como su propio piso | Uno de 5,5 × 2 m, con celdas de 25 cm: cabina de 3,5 m y tolva de 2 m |
| Pasajeros con lugar asignado | 3 camarotes de 2 camas: 6 camas (`CAMA`), y cada camarote se vende también completo (`CAMAROTE`) | 56 asientos 2 + 2: 16 en el piso 1 (1A–4D) y 40 en el piso 2 (5A–14D, la numeración sigue) | 4 asientos en la cabina (copiloto y 3 atrás), con la clase `CABINA` |
| Por cantidad | Zona libre: 30 personas | — | Tolva · pasajeros: 4 personas, con la clase `TOLVA` |
| Carga | Cubierta de carga: 5000 kg y 10 metros lineales. Bodega (encomiendas): 2000 kg y 10 m³ | Bodega de equipaje: 1500 kg y 8 m³ | Tolva · carga: 600 kg |
| Aforo total | 36 | 56 | 8 |
| Lo que se vende | 6 recursos (las camas) y 3 camarotes completos; 6 pools: 5 de zona y el aforo de la unidad | 56 recursos (los asientos); 3 pools: 2 de zona y el aforo | 4 recursos (los asientos); 3 pools: la tolva de pasajeros, la de carga y el aforo |

### 2.1 API: construida, publicada, asignada y materializada (CI)

Prueba: [`apps/api/test/integration/phase6-criterion.int-spec.ts`](../../apps/api/test/integration/phase6-criterion.int-spec.ts).

Recorre la API real: módulos, guards, RLS, roles de base de datos y Redis.
- El staff publica un plan y da de alta una empresa que opera en el río (pasajeros, encomiendas y carga) y en carretera (pasajeros y carga). Su jefatura de flota crea su cuenta desde la invitación.
- Cada plano se construye como en el editor: plano en blanco; pisos y zonas, que se guardan pero aún no se pueden publicar (400); camarotes o filas de asientos con los generadores de contratos y el aforo; publicar.
- El catálogo global ofrece Van y Camioneta pickup 4×4. Crea un tipo y un vehículo para cada plano (el bus y la pickup, desde la sugerencia del catálogo) y les asigna su plano desde hoy. El plano de la lancha no se asigna al bus (400).

**Comprobaciones, para cada vehículo:**
- desde su asignación vigente, la versión publicada devuelve exactamente el resumen, los pools, los recursos vendibles y los camarotes completos de la tabla, y coincide con `deriveInventory`, la misma función que usa el editor;
- en la base, al publicar quedaron materializados los mismos elementos vendibles, los camarotes completos y las reglas de capacidad de cada zona, con el aforo y el número de pisos;
- en la pickup, los asientos de la cabina quedan con la clase `CABINA` y la tolva de pasajeros con la suya (`TOLVA`), en la API y en la base;
- un borrador nuevo no cambia la capacidad de la versión asignada.

**Mutaciones detectadas:**
- cifras esperadas cambiadas (6 camas → 7; 1500 kg → 1600), con la primera versión de la prueba: fallaron 3 de 7;
- al publicar, solo la primera regla de capacidad de cada zona: fallan 2 de 10 (la materialización de la lancha y la del bus);
- el camarote con camas no queda vendible completo: falla 1 (la materialización de la lancha);
- el camarote con camas marcado como recurso vendible suelto: la base lo rechaza al publicar (500), y fallan las 10;
- la clase de precio de la zona no se guarda al publicar: falla 1 (la tolva de la pickup);
- los asientos pierden su clase de precio al publicar: falla 1 (la cabina de la pickup). La primera versión de la prueba no lo detectaba, porque leía la clase solo de la API; ahora la lee también de la base.

### 2.2 Navegador: construidos con el editor (E2E)

Prueba: [`tests/e2e/specs/10-criterio-fase6.spec.ts`](../../tests/e2e/specs/10-criterio-fase6.spec.ts) (proyecto `criterio`).

Otra empresa, con los mismos servicios, construye los tres planos en el panel, desde «Nuevo plano» en blanco:
- **Lancha:** «Crear zona» de camarotes, tres veces «Añadir camarote» de 2 camas, zona libre de 30 personas, cubierta de carga, «Añadir piso» llamado Bodega con su zona de bodega, y el aforo. El editor muestra 3 camarotes (6 camas) y 30 personas en zonas libres, sin nada por corregir.
- **Bus de dos pisos:** modalidad terrestre; en el piso 1, zona de pasajeros y «Añadir 4 filas 2 + 2»; «Añadir piso» y, en el piso 2, otra zona y «Añadir 10 filas 2 + 2», que siguen la numeración (5 a 14); un tercer piso llamado Bodega con la bodega de equipaje (nombre, peso y volumen), y el aforo.
- **Pickup:** modalidad terrestre con celdas de 25 cm; la zona «Cabina» con cuatro «Añadir un asiento individual», cada uno con la clase de precio `CABINA`; la zona libre «Tolva · pasajeros» de 4 personas con la clase `TOLVA` y la cubierta de carga «Tolva · carga» de 600 kg (sin metros lineales), y el aforo.
- **Publicar:** el diálogo resume cada plano: «2 pisos: 0 asientos, 3 camarotes, 6 camas y 30 personas en zonas libres; aforo de 36» y «3 pisos: 56 asientos, 0 camarotes, 0 camas y 0 personas en zonas libres; aforo de 56», y «1 piso: 4 asientos, 0 camarotes, 0 camas y 4 personas en zonas libres; aforo de 8».
- **Flota:** tres tipos (la pickup, desde la sugerencia «Camioneta pickup 4×4», que rellena el nombre) y un vehículo de cada uno. Al asignar, cada vehículo solo ve los planos de su modalidad: la lancha, uno; el bus y la pickup, los dos terrestres.
- **Base de datos:** la versión vigente de cada vehículo tiene las camas, camarotes, asientos, elementos vendibles, reglas de capacidad y aforo de la tabla, y en la pickup, los asientos con la clase `CABINA` y la tolva de pasajeros con `TOLVA`.
- **Accesibilidad:** axe (WCAG 2.1 AA) en el editor con cada plano, en los diálogos de publicar y en Flota.

## 3. Totales

Entorno: 2026-11-17, Node 24.22.2, PostgreSQL 17.6 y Redis 7.4.6.

| Batería | Resultado |
|---|---|
| Integración (`pnpm test:integration`, CI) | 30 suites y **430 pruebas** ✅. Incluye el criterio de esta fase y los de las fases 3, 4 y 5 |
| Unitarias de la API | 22 suites y 146 pruebas ✅ (ver la intermitencia del apartado 4) |
| Unitarias de `apps/web` | 25 ✅ |
| Unitarias del panel (`apps/platform`) | 18 ✅ |
| Contratos | 34 ✅ |
| E2E (Playwright y axe) | **49 ✅ y 3 opcionales** (las capturas). Panel del staff, portal, editor del sitio, flota y planos, agencias y el criterio. Se ejecuta en local, porque necesita Chromium; no forma parte de la CI |
| Tipos, lint y formato del monorepo | ✅. El formato solo avisa de `identidad/tokens/yebo-tokens.css`, que no está versionado |

## 4. Hallazgos del cierre

- **Nombre accesible de los campos con ayuda (editor, 6.4) · corregido:** los campos de número, de texto y de metros del editor llevaban su ayuda y su error dentro de la etiqueta, así que su nombre accesible era la frase entera («Aforo total Tope de personas a bordo…», «Clase de precio (opcional) Vacía: GENERAL.»), y cambiaba al aparecer un error. Ahora la ayuda y el error van fuera de la etiqueta y se enlazan con `aria-describedby`: el nombre es solo la etiqueta y la ayuda se lee como descripción. El E2E busca los campos por su nombre exacto (antes del cambio fallaba así) y comprueba la descripción del aforo y de la clase de precio, también con un error.
- **Clase de precio de una zona (editor) · corregido:** la API ya la aceptaba, pero el editor solo tenía la de cada elemento. Ahora la zona tiene «Clase de precio (opcional)», con el mismo formato y mensaje de error que la del elemento, y una ayuda que dice qué se usa si queda vacía: la clase del tipo de zona; en una zona de pasajeros, los asientos la toman si no tienen la suya y las camas y los camarotes usan CAMA y CAMAROTE. El E2E pone `TOLVA` a la tolva de pasajeros de la pickup, prueba un valor no válido y lo comprueba en la base.
- **Tolva compartida:** una zona mide personas o carga, no las dos («Una zona de este tipo no mide kg»). La tolva de la pickup se parte en dos tramos con cupos separados. Si en la venta (Fase 8) personas y carga deben consumir el mismo cupo, hará falta un tipo de zona «Tolva» con las dos medidas: decisión para entonces.
- **Unitaria de la API intermitente:** en una ejecución de `pnpm test` justo después de la integración completa falló 1 de 146. No se guardó su salida, y en seis ejecuciones posteriores (solas y en paralelo con turbo) pasaron las 146. Queda sin identificar.

## 5. Pendientes al cerrar la Fase 6

Anotados en cada etapa del plan. Ninguno impide cumplir el criterio.

| Pendiente | Origen |
|---|---|
| Tildes del catálogo de ubigeo: la fuente no las trae en sus ~1 900 nombres; pide otra fuente o una tabla de corrección | 6.4d |
| Limpiar archivos subidos que nunca se usaron (documentos de vehículos y sitio): tarea programada | 6.2, 5.2 |
| Registro de auditoría general de las acciones de la empresa (hoy, publicar y asignar un plano guardan su autor) | 6.0, 5.1 |
| ¿Tolva con cupo compartido de personas y carga? (apartado 4) | 6.6, para la Fase 8 |
| E2E en la CI (requiere Chromium en el runner) | 4.7c |

**Fuera del alcance de la Fase 6** (sin cambios):
- viajes, inventario por tramo y venta (fases 7 y 8);
- comisiones de agencias y liquidación a propietarios (D6 y D7, fases 8 y 11);
- almacenes y secuencias de documentos (F6-Q7);
- avisos de vencimiento por correo (Fase 12);
- mapa interactivo de ubicaciones.

**Dato de prueba en `yebo_dev`:** para revisar la 6.5b, el módulo `AGENCIES` está encendido en «tormenta» con una excepción del staff (copia previa en `~/yebo-backups/yebo_dev-antes-modulo-agencias-20261117184924.dump`). Se retira terminando la excepción en el panel del staff.

## 6. Siguiente paso

1. Push y PR de la Fase 6, con autorización del responsable.
2. La Fase 7 no empieza sin aprobación expresa.

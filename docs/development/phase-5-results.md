# Fase 5 · Resultados (white label)

- **Fecha:** 2026-11-10.
- **Rama:** `fase-5/plan`, desde el cierre de la Fase 4 (`c98ab2e`).
- **Plan y decisiones:** [phase-5-plan.md](phase-5-plan.md).
- **Criterio de aceptación** ([roadmap](roadmap.md)): «Dos portales visualmente distintos sin duplicar apps».
- **Estado:** ✅ **cumplido**. Lo demuestran:
  - dos pruebas automáticas en la CI (`.github/workflows/ci.yml`): la de integración, en `pnpm test:integration`, y la unitaria de `apps/web`, en `pnpm test`;
  - una prueba E2E en el navegador.

## 1. Qué se construyó

| Etapa | Commit | Contenido |
|---|---|---|
| 5.1 · Modelo y API del sitio | `0bb5f66` | `site_versions` (borrador, publicada e historial; RLS forzado) y `SiteConfig` v1 en contratos. Contraste AA en el servidor, API de la empresa con `site.manage`, `GET /public/site` con caché por empresa y configuración efectiva sin `WHITE_LABEL` |
| 5.2 · Archivos | `24f9d9f` | `file_assets` y almacenamiento S3: Garage en desarrollo. Subida comprobada por contenido y recodificada sin metadatos; favicon generado del logo. Se sirven solo en el host de su empresa |
| 5.3 · Portal público | `99e55f2` | Portada de cada empresa en `apps/web`. Un solo componente y una sola compilación; tema por variables CSS, fuentes autoalojadas, metadatos y 404 por host |
| 5.4 · Editor «Mi sitio» | `7a5f02c` | Primer panel de la empresa en `apps/web`. Editor con validación por campo, vista previa en monitor o iPhone, publicar, descartar, deshacer e historial con restaurar. Revisado con Impeccable (`critique`) |
| 5.5 · Cierre | este documento | Prueba del criterio en la API, en `apps/web` y en el navegador |

**Migraciones:** la 5.1 y la 5.2 están aplicadas a `yebo_dev` desde el 2026-11-10, a las 09:49 (hora de Lima).
- **Copia previa:** `pg_dump` de cinco segundos antes, válido (`pg_restore --list`), guardado en `~/yebo-backups/`, fuera del repositorio, junto con las copias de la Fase 4.
- **Reversión:** documentada en la cabecera de cada migración.
- La 5.3, la 5.4 y la 5.5 no tienen migración.

## 2. El criterio de aceptación

### 2.1 API: tres empresas, tres documentos (CI)

Prueba: [`apps/api/test/integration/phase5-criterion.int-spec.ts`](../../apps/api/test/integration/phase5-criterion.int-spec.ts).

Recorre la API real: módulos, guards, RLS, roles de base de datos, Redis y almacenamiento S3.
- El staff publica un plan con `WHITE_LABEL` y otro sin él.
- Da de alta tres empresas, y el administrador de cada una crea su cuenta desde la invitación.
- Cada administrador hace lo mismo que en «Mi sitio»: subir el logo, guardar el borrador y publicar.

| Empresa | Plan | Lo que publica | Lo que sirve su host |
|---|---|---|---|
| Naviera Ucayali | Con `WHITE_LABEL` | Fondo oscuro, Lora, verde lima, esquinas redondeadas, su logo y su FAQ | Exactamente su documento (versión 1) |
| Ribera Amazónica | Con `WHITE_LABEL` | Fondo claro, Montserrat, azul, esquinas rectas, su logo, sus horarios y las secciones en otro orden | Exactamente su documento (versión 1) |
| Transportes del Oriente | Sin el módulo | Tema y portada propios | Tema YEBO, su nombre como título y solo servicios, sucursales y contacto (F5-Q4). Lo guardado se conserva en el editor |

**Comprobaciones:**
- Los dos portales con el módulo difieren en cada token del tema, en la portada, en el logo y en el orden de las secciones, y los dos cumplen AA.
- Nada de una empresa aparece en el portal de la otra.
- El logo de cada empresa se sirve en su host y da 404 en el otro. El favicon se sirve en su host.
- Publicar una versión nueva en una empresa no cambia el portal de otra: la caché es por empresa.

**Mutaciones detectadas:**
- caché del portal compartida entre empresas (falla en 3 de las 5 pruebas);
- portal que ignora `WHITE_LABEL` (falla en 1).

### 2.2 `apps/web`: el mismo código, tokens distintos (CI)

Prueba: [`apps/web/components/portal/theme.spec.ts`](../../apps/web/components/portal/theme.spec.ts).

El portal es un solo componente, que pinta el documento publicado con las variables de `themeStyle`.

**Comprobaciones:**
- Con dos documentos distintos, la función resuelve los mismos tokens con valores distintos: fondo, texto, principal, texto sobre el principal, acento, radio, fuente y esquema de color.
- Todos cumplen AA.
- Sin el módulo, se resuelve el tema YEBO.

**Para poder probarlo con Jest:** las pilas tipográficas pasan de `fonts.ts`, que usa `next/font` y solo funciona al compilar con Next, a `font-stacks.ts`. `fonts.ts` las reexporta, así que el portal no cambia.

**Mutaciones detectadas:**
- un color principal fijo (falla en 2 de las 3 pruebas);
- una fuente fija (falla en 1).

### 2.3 Navegador: la misma compilación (E2E)

Prueba: «criterio de la Fase 5» en [`tests/e2e/specs/06-portal.spec.ts`](../../tests/e2e/specs/06-portal.spec.ts).

Un solo servidor de `apps/web` atiende a los dos hosts (Naviera y Oriente) detrás del proxy por host, como Nginx en producción.
- **Misma compilación:** las dos páginas cargan exactamente los mismos archivos de `/_next/static/`, con su hash de contenido. Es una sola app.
- **Tokens:** los calculados en el navegador son distintos.
- **Capturas:** las de la primera pantalla (1280 × 800) se comparan píxel a píxel, y cambian **más de la mitad** de los píxeles.
- **Accesibilidad:** las mismas páginas pasan axe (WCAG 2.1 AA) en escritorio y a 390 px.

## 3. Totales

Entorno: 2026-11-10, Node 24.22.2, PostgreSQL 17.6, Redis 7.4.6 y Garage v2.5.0.

| Batería | Resultado |
|---|---|
| Integración (`pnpm test:integration`, CI) | 25 suites y **385 pruebas** ✅. Incluye el criterio de esta fase y los de las fases 3 y 4 |
| Unitarias de la API | 22 suites y 146 pruebas ✅ |
| Unitarias de `apps/web` | 2 suites y 15 pruebas ✅ (criterio de tokens y lógica del editor) |
| Unitarias del panel (`apps/platform`) | 18 ✅ |
| Contratos | 11 ✅ |
| E2E (`pnpm test:e2e`, Playwright y axe) | 25 + 3 opcionales ✅. Panel del staff, portal (con el criterio) y editor. Se ejecuta en local, porque necesita Chromium; no forma parte de la CI |
| Tipos, lint y formato del monorepo | ✅ |

**Revisión con Impeccable:**
- `critique` del editor: 24/40; se corrigieron los P1 y los P2.
- `detect` sobre las pantallas renderizadas: solo falsos positivos ya documentados.
- La telemetría está desactivada.

## 4. Pendientes al cerrar la Fase 5

Anotados en cada etapa del plan. Ninguno impide cumplir el criterio.

| Pendiente | Origen |
|---|---|
| «Ver» una versión del historial antes de restaurarla (necesita `GET /site/versions/{n}`) | 5.4 |
| Limpiar objetos huérfanos del almacenamiento (un borrado fallido o una subida que no se llegó a guardar): tarea programada | 5.2, 5.4 |
| Registro de auditoría general de las acciones de la empresa (hoy, el historial del sitio con su autor) | 5.1 |
| Una lectura del portal iniciada antes de publicar puede reescribir en la caché la versión anterior durante 60 s como mucho (riesgo aceptado) | 5.1 |
| Ideas de la crítica que serían rediseño: autoguardado, temas ya validados en AA, horarios a partir de las rutas y reordenar arrastrando | 5.4 |
| E2E en la CI (requiere Chromium en el runner) | 4.7c |

**Fuera del alcance de la Fase 5** (sin cambios):
- dominios propios y su verificación (D11);
- reservas y seguimiento públicos (fases 8 y siguientes);
- plantillas de documentos;
- notificaciones con la marca de la empresa (Fase 12);
- constructor de páginas libre.

## 5. Siguiente paso

1. Revisión de la Fase 5 por el responsable.
2. Push y PR de las fases 4 y 5, con su autorización.
3. La Fase 6 no empieza sin aprobación expresa.

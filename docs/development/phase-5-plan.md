# Fase 5 · White label (plan)

- **Estado:** ✅ Decisiones F5-Q1 a F5-Q6 **aprobadas** por el responsable el 2026-11-10, tal como se recomendaron. Etapa 5.1 en curso.
- **Rama:** `fase-5/plan`, desde el cierre de la Fase 4 (`c98ab2e`).
- **Criterio de aceptación** ([roadmap](roadmap.md)): «Dos portales visualmente distintos sin duplicar apps».

## Lo que ya está decidido en la arquitectura

| Fuente | Decisión |
|---|---|
| system-overview §5 | `TenantBranding`, `TenantTheme` y `TenantPage` se unifican en **`site_versions`**: un documento de configuración versionado y validado, que se publica y restaura de forma atómica |
| data-dictionary §11 | `site_versions`: `version`, `status DRAFT\|PUBLISHED\|ARCHIVED`, `schema_version` y `config jsonb`. El `config` lleva tema, fuentes de una lista blanca, cabecera, pie, secciones y su orden, contactos, políticas, FAQ y redes, validado con Zod. Como mucho 1 `PUBLISHED` y 1 `DRAFT` por empresa. `file_assets` para los archivos |
| multitenancy §2 | `apps/web` resuelve el tema por host llamando a `GET /api/v1/public/site`. El contrato ya existe y se amplía sin romperlo |
| multitenancy §5 | Editar el white label es `CONFIGURE`: bloqueado en `SUSPENDED`, `EXPIRED` y `CANCELLED`. El portal sigue visible; las reservas se avisan según el estado |
| Catálogo (4.2) | Módulo `WHITE_LABEL` («Marca propia: portal público con la identidad de la empresa») |
| D11 | Solo subdominios en el MVP; los dominios propios llegan después |

## Etapas propuestas

| Etapa | Contenido | Verificación |
|---|---|---|
| **5.1 · Modelo y API del sitio** | Tabla `site_versions` (de tenant, RLS forzado). Esquema Zod `SiteConfig` v1 en contratos. Validación en el servidor: contraste WCAG AA de los colores del tema, fuentes de la lista blanca, longitudes y URL seguras. API de la empresa: leer y guardar el borrador, publicar, historial y restaurar una versión anterior. `GET /public/site` con la versión publicada. Caché por host con invalidación al publicar. Auditoría | Integración: RLS y aislamiento, una sola publicada, publicación atómica, contraste inválido → 400, permiso y módulo, estados del tenant (`CONFIGURE`) y mutaciones |
| **5.2 · Archivos (logo, favicon e imagen de portada)** | `file_assets` (de tenant) y almacenamiento compatible con S3 (ver F5-Q2). Subida con tipo comprobado por contenido, tamaño y dimensiones; sin SVG (puede contener scripts). URL públicas solo de archivos `PUBLIC` y `READY` | Tipos falsos, archivos grandes, aislamiento entre empresas y archivos de otra empresa en el `config` |
| **5.3 · Portal público en `apps/web`** | La portada de cada empresa en `https://<subdominio>…`: secciones según el `config`, tema aplicado como variables CSS sobre los tokens semánticos de `@yebo/ui` (claro y oscuro), metadatos y SEO, avisos según el estado del tenant y 404 para hosts desconocidos. **Una sola app y una sola compilación** para todas las empresas | E2E con dos empresas: misma compilación y portales distintos; axe en ambas |
| **5.4 · Editor en el panel de la empresa** | Primera sección del panel de la empresa en `apps/web` (navegación mínima del panel): «Mi sitio», con formulario por secciones, vista previa del borrador, publicar, historial y restaurar. **Maqueta primero y revisión con Impeccable** antes del código, como en la 4.7 | E2E del editor: editar → vista previa → publicar → el portal cambia. axe |
| **5.5 · Cierre** | Prueba del criterio: dos empresas con configuraciones publicadas distintas se ven distintas (capturas comparadas y tokens resueltos distintos), servidas por la misma compilación de `apps/web`. Resultados en `phase-5-results.md` | Criterio en la CI (parte sin navegador) y en el E2E |

## Decisiones (todas aprobadas el 2026-11-10 según la recomendación)

| Id | Pregunta | Decisión |
|---|---|---|
| **F5-Q1** | Contenido del portal en esta fase | **Solo la portada informativa:** cabecera con logo, portada (título, texto e imagen), servicios que opera, sucursales y contactos, horarios, FAQ, políticas y pie con redes. Reservas y seguimiento llegan con sus fases (8+); la portada muestra solo sus accesos «Próximamente» si el módulo existe |
| **F5-Q2** | Dónde se guardan logos e imágenes | **MinIO (compatible con S3) en el compose de desarrollo**, con una interfaz `ObjectStorage` en la API. En producción servirá el S3 del proveedor que se elija (D12). Antes de usar la imagen la inspecciono e informo. Alternativa: bytes en PostgreSQL (más simple, pero no escala y contradice `file_assets.storage_key`) |
| **F5-Q2 (actualizada el 2026-11-10)** | MinIO ya no es viable | MinIO está **archivado** en GitHub (abril de 2026) y no publica imágenes oficiales (Docker Hub: 404; Quay: 0 etiquetas). El responsable eligió **Garage v2.5.0** (`dxflrs/garage`, AGPL-3.0, solo como servicio de desarrollo sin modificar), con `@aws-sdk/client-s3` 3.1158.0 y `sharp` 0.35.5 en la API, todos inspeccionados antes de usarlos |
| **F5-Q3** | Libertad del tema | **Tokens, no CSS libre:** color principal, color de acento, superficie clara u oscura, radio de las esquinas (3 opciones) y fuente de una lista blanca de 6 fuentes autoalojadas. El servidor rechaza combinaciones con contraste por debajo de AA. Sin HTML ni CSS propios (seguridad e identidad coherente) |
| **F5-Q4** | Empresas sin el módulo `WHITE_LABEL` en su plan | **Portal con el tema YEBO por defecto** y su nombre, logo, servicios y contactos. Colores, fuentes, portada y secciones propias solo con el módulo. El editor muestra qué se desbloquea con el módulo |
| **F5-Q5** | Quién edita el sitio | **La empresa, con un permiso nuevo `site.manage`** (incluido en la plantilla Administrador). El staff de YEBO solo con un acceso de soporte `FULL` (Fase 4.6); el panel de YEBO muestra el estado del sitio, pero no lo edita |
| **F5-Q6** | Dónde se publica la página de estado de la Fase 2 de `apps/web` | Se mueve a `/estado`, como en `apps/platform`. La raíz de cada subdominio pasa a ser el portal |

## Fuera del alcance de la Fase 5

- Dominios propios y su verificación (D11).
- Reservas y seguimiento públicos (fases 8+).
- Plantillas de documentos (tickets, guías y manifiestos: `document_templates`, con sus módulos).
- Notificaciones con la marca de la empresa (Fase 12).
- Constructor de páginas libre (arrastrar y soltar).

## Privilegios y seguridad (ADR-034)

- **`site_versions` y `file_assets`:** son de tenant, con RLS forzado. `yebo_app` lee y escribe su empresa. La API pública solo lee la versión publicada.
- **Auditoría:** publicar y restaurar quedan auditados (actor y versión).
- **Datos que no se aceptan:**
  - HTML ni CSS libres;
  - URL que no sean `https:`, `mailto:` o `tel:`;
  - imágenes que no sean PNG, JPEG o WebP;
  - archivos de otra empresa referenciados en el `config`.
- **Caché del portal:** se invalida al publicar. Nunca se sirve un borrador al público; la vista previa exige sesión con `site.manage`.

## Etapa 5.1 · Modelo y API del sitio (implementada el 2026-11-10; pendiente de revisión)

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Esquema | `SiteConfigSchema` v1 en `@yebo/contracts` (`site.ts`), compartido por la API, el editor y el portal. Tema por tokens: color principal, acento, superficie, radio y fuente de una lista blanca de 6. Secciones: las 6 una vez cada una, en orden. Contactos, sucursales (≤ 30), horarios, FAQ (≤ 20), políticas (≤ 10), redes (solo `https:`) y pie. Objetos estrictos: un campo desconocido → 400 |
| Contraste | `themeContrastProblems` (WCAG 2.1, umbral 4,5:1): el texto sobre el principal (navy o blanco, el de más contraste) y el acento sobre la superficie. La misma función la usa el servidor, que la impone al guardar, publicar y restaurar, y el editor de la 5.4, que avisará antes |
| Sin `WHITE_LABEL` (F5-Q4) | `effectiveSiteConfig`: tema YEBO, portada con el nombre y solo servicios, sucursales y contacto. Lo guardado no se pierde: al conceder el módulo, se publica sin volver a editar |
| Versiones | Un borrador editable y una publicada por empresa (`live_slot` único, como `subscriptions.is_current`). Publicar: el borrador pasa a publicado y la anterior a archivada, en la misma transacción. Restaurar publica una **copia** de una versión archivada como versión nueva, sin reescribir la historia ni tocar el borrador. Escrituras serializadas por empresa (`pg_advisory_xact_lock`) |
| Autor | `published_by_kind`/`published_by_id`: la membresía, o el staff con soporte `FULL` (`PLATFORM_USER`). Aún no hay un registro de auditoría de acciones de la empresa: el historial de versiones con su autor cumple ese papel para el sitio |
| Portal | `GET /public/site` (mismo contrato; solo se añaden `site` y `services`). Caché en Redis por empresa de 60 s, invalidada al publicar o restaurar; un cambio de plan o de módulo se refleja en ≤ 60 s |
| Fronteras | El controlador público pasa de `tenancy` a `site/http/public-site.controller.ts`, con la misma ruta ya registrada en `PUBLIC_ROUTES`. La regla de ESLint permite `@Public` **solo en ese archivo**. La alternativa, `tenancy` (L0) importando un módulo de negocio, invertiría las capas |
| Archivos | `logoAssetId` e `imageAssetId` existen en el esquema, pero el servidor exige `null` hasta la 5.2 (`file_assets`) |

### API de la empresa (permiso `site.manage`)

| Ruta | Categoría | Qué hace |
|---|---|---|
| `GET /api/v1/site` | READ | Borrador, publicada y si el plan incluye `WHITE_LABEL` |
| `PUT /api/v1/site/draft` | CONFIGURE | Crea o reemplaza el borrador |
| `POST /api/v1/site/publish` | CONFIGURE | Publica el borrador (409 si no hay) |
| `GET /api/v1/site/versions` | READ | Historial |
| `POST /api/v1/site/versions/{n}/restore` | CONFIGURE | Vuelve a publicar una versión archivada como nueva |

CONFIGURE queda bloqueado en `SUSPENDED`, `EXPIRED` y `CANCELLED` (ADR-023). El portal sigue visible.

### Base de datos (migración `20261112010000_fase5_1_site_versions`, reversión en su cabecera)

- **Tabla:** `site_versions`, de tenant, con RLS forzado.
- **CHECK:**
  - `live_slot` coherente con el estado;
  - publicada o archivada ⇔ con fecha y autor;
  - `config` es un objeto de ≤ 64 KB.
- **Trigger `site_versions_guard`:**
  - borrador editable;
  - publicada → solo archivarla;
  - archivada, nada;
  - la identidad (id, tenant, versión, creación) no cambia;
  - no nace archivada;
  - no se borra.
- **Privilegios:**
  - `yebo_app`: SELECT, INSERT y UPDATE de las columnas de estado, contenido y publicación;
  - `yebo_backoffice`: SELECT, para que el panel de YEBO vea el estado del sitio.
- **Permiso `site.manage`:** módulo `SITE`, sensible, en la plantilla Administrador y en los roles Administrador existentes (sube su `permissions_version`).

### Pruebas

- **Contratos (unitarias):** 8 nuevas.
  - Contraste: valores de referencia, texto sobre el principal, umbral exacto de 4,5:1, tema YEBO válido.
  - Esquema: secciones, URL (`javascript:`, `http:`, `data:`), campos desconocidos, longitudes y teléfonos.
  - Configuración efectiva sin el módulo.
- **`site.int-spec` (11):**
  - estado vacío y portal por defecto;
  - validaciones (contraste, archivos, `http:`, campos extra);
  - borrador único que se reemplaza;
  - publicar, con autor y caché;
  - historial y restaurar como copia;
  - 5 publicaciones simultáneas (una gana) y 5 guardados simultáneos del primer borrador (uno solo);
  - sin el módulo y al concederlo;
  - sin permiso → 403, sin sesión → 401;
  - empresa suspendida (consulta sí; guardar y publicar, 403);
  - reglas de la base y RLS.
- **Inventario actualizado:** matriz de privilegios, catálogo de permisos y contrato de `/public/site`.
- **Mutaciones:** todas las no equivalentes se detectan.
  - Servicio, 9: contraste, archivar, caché, candado, restaurar, plan, borrador en público, autor y archivos.
  - Trigger, 6: borrar, nacer archivada, identidad, archivar un borrador, editar publicada y editar archivada.
  - Dos huecos de las pruebas se cerraron por el camino: la caché del portal en la comprobación del borrador y la carrera del primer borrador.
- **Totales:** integración, 23 suites y 371 pruebas ✅; tipos, lint y formato ✅.

### Revisión del código de la 5.1 (2026-11-10, a petición del responsable)

| # | Hallazgo | Gravedad | Corrección | Prueba |
|---|---|---|---|---|
| 1 | El esquema admitía configuraciones de hasta unos 110 KB y la base las rechaza por encima de 64 KB (CHECK): un 500 con datos válidos. Reproducido con un INSERT real | Media | `SITE_MAX_BYTES` = 60 KB (bytes UTF-8 del JSON, `siteConfigBytes`), comprobado al guardar, publicar y restaurar → 400 con el tamaño y qué acortar | Integración (10 políticas de 6000 «ñ» → 400) y unitaria (bytes UTF-8 y margen frente al CHECK) |
| 2 | Una versión publicada que dejara de validar (esquema endurecido o edición manual) tumbaba el portal con un 500 | Media | El portal sirve la configuración por defecto (`version: null`) y lo registra como error para corregirlo | Integración: versión publicada con un `config` antiguo → 200 por defecto |
| 3 | `GET /public/site` decía si el plan incluye `WHITE_LABEL` (dato comercial) | Baja | Se retira del contrato público; sigue en el editor | Integración: el contrato público es exactamente `{ version, config }` |
| 4 | El historial leía y validaba el contenido de todas las versiones para descartarlo (lento y frágil) | Baja | Solo lee versión, estado y fechas | Integración: el historial responde aunque haya una versión inválida |
| 5 | No había prueba del staff con soporte | Hueco | — | Integración: `READ_ONLY` consulta (200) y no guarda ni publica (403); `FULL` publica con autor `PLATFORM_USER` y su id |
| 6 | Una lectura pública que empezó antes de publicar puede volver a escribir en la caché la versión anterior | Baja | **Riesgo aceptado** y documentado en el código: como mucho 60 s | — |

**Mutaciones de las correcciones:** se detectan las del límite de tamaño, la tolerancia del portal y la versión del portal cuando hay un fallo. Es equivalente leer la columna `config` en el historial sin validarla.

**Totales tras la revisión:** `site.int-spec`, 13 pruebas; contratos, 11.

### Pendiente

- Migración a `yebo_dev`: con autorización, copia previa y la reversión documentada.
- 5.2: archivos (MinIO, a inspeccionar antes de usarlo).
- Registro de auditoría general de las acciones de la empresa: fuera de la 5.1.

## Etapa 5.2 · Archivos: logo, favicon y portada (implementada el 2026-11-10; pendiente de revisión)

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Almacenamiento | **Garage v2.5.0** en `infra:up`, solo en `127.0.0.1:3900`. `garage server --single-node --default-bucket` crea el layout, la clave y el bucket desde variables de entorno, sin script de preparación ni secretos en `garage.toml`. `init-env.sh` genera `GARAGE_RPC_SECRET` y la clave S3. En producción, el S3 del proveedor (D12) |
| API | Interfaz `ObjectStorage` (guardar, leer y borrar) con implementación S3 (`forcePathStyle`). Es opcional: sin endpoint ni claves queda desactivada y subir responde 503, en lugar de romper el arranque |
| Subida | `POST /api/v1/site/assets?kind=logo\|hero` con la imagen en el cuerpo (`image/png`, `image/jpeg` o `image/webp`; ≤ 5 MB, si no 413), sin multipart. Permiso `site.manage`, categoría CONFIGURE |
| Validación por contenido | `sharp` lee la cabecera real (no el nombre ni el tipo declarado). Solo PNG, JPEG y WebP. Mínimos: logo 64 × 64, portada 1200 × 600. Bombas de descompresión (> 50 Mpx) rechazadas antes de decodificar. Una imagen dañada → 400, no 500 |
| Recodificación | Siempre: se aplica la orientación EXIF y se **eliminan todos los metadatos**, incluida la ubicación GPS de una foto de móvil. Nunca se guarda ni se sirve el original. Logo → PNG ≤ 1024 px; portada → WebP (calidad 82) ≤ 2400 × 1600. Del logo se genera un **favicon de 64 × 64**, sin cambiar el esquema del sitio |
| Servido | `GET /api/v1/public/assets/{id}` y `…/favicon`, en `PUBLIC_ROUTES`. Solo archivos `PUBLIC` y `READY` de la empresa del host (RLS). Cabeceras: `Cache-Control: public, max-age=31536000, immutable`, `ETag` (SHA-256; el 304 lo resuelve Express), `Content-Security-Policy: default-src 'none'; sandbox` y `nosniff`. El bucket nunca se expone |
| Referencias del sitio | `logoAssetId` y `hero.imageAssetId` deben ser archivos `READY` de la empresa (RLS) y del tipo correcto, al guardar, publicar y restaurar. Sustituye la regla provisional de la 5.1 |
| Coherencia | Si falla la fila, se borran los objetos ya subidos. Los archivos no se borran: se marcan `DELETED` y dejan de servirse y de poder referenciarse |

### Base de datos (migración `20261112020000_fase5_2_file_assets`, reversión en su cabecera)

- **Tabla:** `file_assets`, de tenant, con RLS forzado.
- **CHECK:**
  - tamaño y dimensiones;
  - SHA-256 de 32 bytes;
  - MIME de la lista;
  - **la clave del objeto empieza por `tenants/<su tenant>/`**, así que un objeto nunca se comparte entre empresas;
  - autor: membresía o staff.
- **Privilegios:**
  - `yebo_app`: SELECT, INSERT y UPDATE solo de `status`, sin DELETE;
  - `yebo_backoffice`: SELECT.

### Pruebas

- **`site-assets.int-spec` (6), contra Garage real:**
  - logo reducido y servido con sus cabeceras, 304 y favicon de 64 × 64;
  - foto JPEG con GPS y orientación 6: se gira y queda sin EXIF en WebP;
  - se rechazan un SVG que dice ser PNG, un GIF y un TIFF reales, imágenes pequeñas, una bomba de 60 Mpx, datos cortados, > 5 MB (413), un tipo de cuerpo erróneo y un `kind` desconocido;
  - referencias: tipo cambiado, otra empresa, inexistente y retirada;
  - cada host sirve solo lo suyo;
  - sin permiso → 403; suspendida → 403;
  - RLS, sin DELETE y CHECK de la clave.
- **Unitaria:** almacenamiento desactivado → 503 en cada operación.
- **Inventario actualizado:** matriz de privilegios y la prueba de la 5.1 (mensaje real del archivo).
- **Mutaciones (13):** se detectan todas las no equivalentes: formato, píxeles, mínimo, orientación, metadatos, reducción, decodificación → 400, servir no públicos, CSP de la imagen, tipo y estado de la referencia.
  - Dos huecos de las pruebas cerrados: el GIF de 1 × 1 lo frenaba la regla de tamaño, no la de formato.
  - Sobrevivía la rama propia del 304 porque Express ya lo resuelve: se quitó por redundante.
- **Totales:** integración, 24 suites y 379 pruebas ✅; tipos, lint y formato ✅.

### Pendiente

- Migraciones de la 5.1 y la 5.2 a `yebo_dev`: con autorización y copia previa.
- Retirar archivos desde el editor (`DELETED`) y limpiar objetos huérfanos: con el editor de la 5.4.

## Etapa 5.3 · Portal público en `apps/web` (implementada el 2026-11-10; pendiente de revisión)

### Decisiones de implementación

| Tema | Decisión |
|---|---|
| Raíz de cada host | La página de estado de la Fase 2 pasa a `/estado` (F5-Q6). En `/`, el servidor de Next lee `GET /api/v1/public/site` reenviando el host original (`X-Forwarded-Host`; ADR-004). Empresa → su portal; hub de cuentas → redirección a `/login`; host desconocido → 404; API caída → error, no un 404 engañoso |
| Una sola compilación | El portal es un componente de servidor que pinta el documento publicado: lo que cambia entre empresas son los datos, nunca el código ni la compilación (criterio de la fase) |
| Tema | `themeStyle` convierte los tokens en variables CSS (`--site-*`): superficie y texto de `SITE_SURFACES`, texto sobre el principal con `textOnPrimary` y radio en 3 pasos. El acento solo se usa sobre la superficie pura, la misma contra la que la API validó el contraste. Los tintes (portada, líneas) se derivan con `color-mix` y nunca llevan texto de acento |
| Fuentes | Las 6 de la lista blanca, con `next/font`: se descargan al compilar y se sirven desde el propio dominio, sin contactar con Google |
| Contenido (F5-Q1) | Cabecera con logo o nombre, navegación por secciones (≥ md), portada con llamada a la acción (WhatsApp, si no teléfono) y la imagen de portada, y las secciones activas que tienen datos, en su orden. Servicios por modalidad, sucursales, horarios (`dl`), FAQ y políticas (`details`), y contacto (`tel:`, `mailto:`, `wa.me`). Pie con su texto y redes. Aviso «Reserva de pasajes y seguimiento de envíos en línea: próximamente» si opera pasajeros o encomiendas |
| Metadatos | El título es el nombre de la empresa; la descripción, el subtítulo; el icono, el **favicon generado de su logo**; la imagen Open Graph, la portada |
| Accesibilidad | Enlace «Ir al contenido», regiones con su título, un solo `h1` y los indicadores de FAQ y políticas dibujados en SVG (no un carácter), respetando «reducir movimiento» |

### Pruebas

- **E2E `06-portal.spec.ts` (5).** El harness sirve ahora también `apps/web`, y el proxy enruta por host como Nginx (`admin.*` → panel; el resto → web; `/api` → API).
  - **Naviera Ucayali**, con `WHITE_LABEL`: tema oscuro, Lora y verde lima, con sus 6 secciones; se comprueban el fondo y la fuente calculados, la llamada a la acción y los enlaces `tel:`/`mailto:`.
  - **Transportes del Oriente**, sin el módulo: tema YEBO, portada con su nombre y solo servicios, sucursales y contacto.
  - **Los dos en 390 px**, sin desplazamiento horizontal.
  - **Hub → login; host desconocido → 404; `/estado` se conserva.**
  - **axe (WCAG 2.1 AA)** en todo.
- **Los sitios del E2E** se preparan por SQL (rol de pruebas) y se validan antes con `SiteConfigSchema` y `themeContrastProblems`. La publicación por la API ya la cubren `site.int-spec` y `site-assets.int-spec`.
- **Arreglo del harness:** la preparación global resiembra el catálogo de permisos y la plantilla Administrador desde `permission-catalog.ts`. Antes dependía del estado que dejaban las suites de integración, y un alta falló con «Falta la plantilla ADMIN». La API vuelca sus avisos y errores en la salida del E2E.
- **Totales:** E2E, 18 + 3 opcionales ✅; tipos, lint y formato ✅. La API no cambia en esta etapa.
- **Comprobado en el modo HTTPS** con `yebo_dev`: portal de la empresa real (200), raíz del hub → `/login` y `/estado` (200).

### Pendiente

- **Revisión visual con Impeccable** de los portales: en escritorio, a varias secciones les sobra ancho. Va con el editor de la 5.4, que decide cómo se ven las vistas previas.


# Fase 0 — Informe de auditoría y descubrimiento

- **Fecha:** 2026-11-05
- **Estado:** Completada. Decisiones D1–D7 respondidas el 2026-11-05 e incorporadas en la Fase 1
- **Alcance:** repositorio `yeboyebo`, entorno de desarrollo local

---

## 1. Estado real del proyecto

| Aspecto | Hallazgo |
|---|---|
| Repositorio | Git inicializado, **sin commits**, rama `master`, sin remoto configurado. La rama principal esperada para PRs es `main`. |
| Código existente | **Ninguno.** No hay código, dependencias, configuración, migraciones ni documentación previa. |
| Convenciones existentes | Ninguna. Se definen en esta fase (ver sección 5). |
| Código reutilizable | Ninguno. |
| Funcionalidades existentes | Ninguna. Proyecto *greenfield*. |

Conclusión: no hay arquitectura heredada que respetar ni migrar. Todas las decisiones se toman desde cero, lo cual elimina riesgos de compatibilidad pero obliga a fijar convenciones antes de la Fase 2.

## 2. Entorno de desarrollo detectado

| Componente | Versión / estado | Evaluación |
|---|---|---|
| SO | Linux Mint 21 (base Ubuntu 22.04), 8 núcleos, 7,5 GiB RAM | Suficiente, con margen justo para Docker + Next.js dev + NestJS dev en paralelo. |
| Node.js activo | **v18.20.4** | ❌ **Fuera de soporte (EOL abril 2025).** NestJS 11, Prisma 7 y Next.js 16 requieren Node ≥ 20. |
| Node vía nvm | v20.19.5, **v24.22.2**, v25.2.1 disponibles | ✅ Usar **Node 24 LTS** (fijado en `.nvmrc`). |
| pnpm | 10.8.2 | ✅ Adecuado para monorepo con workspaces. |
| corepack | 0.28.0 | ✅ Permite fijar `packageManager` en `package.json`. |
| Docker | 29.9.3 (Docker Desktop), Compose v2.24.6 | ⚠️ **El daemon no está en ejecución.** Debe iniciarse antes de la Fase 2. |
| PostgreSQL local | 14.24, escuchando en `127.0.0.1:5432` | ⚠️ Conflicto de puertos con el contenedor. Se usará PostgreSQL 17 en Docker en otro puerto. |
| Redis local | 6.0.16, escuchando en `127.0.0.1:6379` | ⚠️ Mismo conflicto. Redis 7 en Docker en otro puerto. |
| Puerto 80 | Ocupado por otro servicio | ⚠️ Nginx de desarrollo debe usar otro puerto (p. ej. 8080). |
| **Disco** | **468 GB, 98 % usado, 13 GB libres** | ❌ **Riesgo bloqueante.** Imágenes Docker (Postgres, Redis, Node, Nginx) + `node_modules` de un monorepo + caché de Next.js pueden consumir 5–8 GB. Liberar al menos 20–30 GB antes de la Fase 2. |

## 3. Arquitectura existente

No existe. Ver propuesta en la sección 4.

## 4. Propuesta de arquitectura objetivo (resumen)

La propuesta detallada (C4, ER, diccionario de datos y ADR definitivos) es el entregable de la **Fase 1**. Aquí se fija la dirección para validarla antes de invertir en diseño detallado.

### 4.1 Estilo

**Monolito modular** NestJS con límites de dominio explícitos, un único PostgreSQL como fuente de verdad, y **dos procesos desde el mismo código**:

- `api`: HTTP REST versionado (`/api/v1`), Swagger.
- `worker`: consumidores BullMQ (notificaciones, outbox relay, expiración de reservas, snapshots de consumo, generación de PDF/Excel).

Esto separa la carga asíncrona del tráfico HTTP sin introducir microservicios.

### 4.2 Monorepo propuesto

```
yeboyebo/
  apps/
    api/            NestJS (entrypoints: main.ts → API, worker.ts → colas)
      prisma/       schema multi-archivo por dominio + migraciones
    web/            Next.js: portal público + panel tenant + POS + PWA operativa
    platform/       Next.js: panel superadministrador SaaS
  packages/
    contracts/      Esquemas Zod + tipos compartidos (fuente única de validación y tipos)
    api-client/     Cliente tipado generado desde OpenAPI
    ui/             Componentes shadcn/ui + tokens de tema white label
    config/         tsconfig, eslint, prettier, preset Tailwind
  infrastructure/   docker compose, nginx, scripts
  docs/
```

Diferencias respecto a la estructura sugerida en el requerimiento, con justificación:

| Sugerido | Propuesto | Motivo |
|---|---|---|
| `packages/types` + `packages/validators` | `packages/contracts` | Con Zod, el tipo se infiere del esquema. Dos paquetes separados duplicarían definiciones (regla 5). |
| `prisma/` en la raíz | `apps/api/prisma/` | Solo la API accede a la base de datos. Ningún frontend debe importar Prisma. |
| `apps/admin` + `apps/booking` | `apps/web` + `apps/platform` | El panel del tenant, el POS, el portal público, el seguimiento y la PWA comparten resolución de tenant por dominio, tema white label y sesión. Separarlos multiplicaría esa lógica. El **superadmin** sí va aparte: dominio propio, superficie de ataque aislada, posibilidad de restringir por IP y sin branding del tenant. |

### 4.3 Multitenancy (dirección)

- Base de datos compartida con `tenant_id` en toda entidad del tenant.
- **Tenant resolver**: el host (`empresa.plataforma.pe` o dominio propio) resuelve el tenant en el backend. En rutas autenticadas, el tenant sale del token/sesión y **debe coincidir** con el del host; si no coincide, se rechaza.
- Contexto de request con `AsyncLocalStorage` (vía `nestjs-cls`).
- **Extensión de Prisma** que inyecta `tenantId` en lecturas y escrituras, y falla si falta contexto.
- **Row Level Security de PostgreSQL** como segunda barrera: la extensión ejecuta `set_config('app.tenant_id', …, true)` dentro de cada transacción y las políticas RLS filtran por esa variable. El rol de la aplicación **no** es propietario de las tablas (para que RLS aplique). Recomendado desde la Fase 3, no como añadido posterior.
- Índices compuestos que comienzan por `tenant_id`; claves foráneas compuestas `(tenant_id, id)` en las relaciones críticas, para que la base de datos impida referencias entre tenants.
- Usuarios de la plataforma (superadmin) en una **tabla y realm de autenticación separados** de los usuarios de tenant.

### 4.4 Inventario y concurrencia por tramos (dirección)

Es el núcleo técnico más delicado. Propuesta para validar en la Fase 1:

- **Recursos asignables** (asiento, cama, camarote, espacio de vehículo): cada ocupación se guarda como un rango de índices de parada `[desde, hasta)`. Una **restricción de exclusión** de PostgreSQL (`EXCLUDE USING gist (trip_id WITH =, resource_id WITH =, stop_range WITH &&)`) impide en la propia base de datos que dos ventas solapen el mismo recurso en el mismo tramo. Esto elimina la doble venta aunque falle la lógica de la aplicación.
- **Capacidades agregadas** (zona libre, hamacas, peso y volumen de bodega, cubierta de carga): un contador por `(viaje, zona, segmento)` actualizado con `SELECT … FOR UPDATE` en orden determinista de segmentos (para evitar *deadlocks*) y un `CHECK (used <= capacity)`.
- Prisma no modela restricciones de exclusión, así que se añaden con SQL dentro de las migraciones, documentadas en el diccionario de datos.
- Redis solo como caché de lectura de disponibilidad, nunca como fuente de verdad.

### 4.5 Otros ejes

| Eje | Dirección propuesta |
|---|---|
| Validación | Zod en `packages/contracts`, compartido por frontend y backend (`nestjs-zod` para DTOs y OpenAPI). Evita mantener class-validator y Zod en paralelo. |
| Autenticación | Access token JWT corto (≈15 min) + refresh token opaco rotado y hasheado en base de datos, con detección de reutilización y revocación por familia de tokens. Argon2id para contraseñas. |
| Eventos | Eventos de dominio en proceso + **Outbox** transaccional para eventos con efectos externos (correo, webhooks, futuros WhatsApp/SMS). El worker publica a BullMQ. |
| Archivos | Subida directa a R2 mediante URL prefirmada, validación de tipo y tamaño en backend, claves con prefijo `tenant/{id}/`. SVG sanitizado o rasterizado (vector de XSS). |
| Boletos offline | QR firmado (Ed25519, clave por tenant) que la PWA puede verificar sin conexión. |
| Fechas | Timestamps en UTC (`timestamptz`); zona horaria del tenant (por defecto `America/Lima`) para presentación y programación. |
| Dinero | Enteros en céntimos o `numeric(12,2)` + código de moneda. Nunca `float`. |
| Unidades | kg, cm, m³ como unidades canónicas internas; conversión en la presentación. |

## 5. Convenciones propuestas

- TypeScript `strict`, sin `any` implícito; `any` explícito solo con comentario justificativo.
- Nombres de tablas y columnas en `snake_case` (vía `@@map`/`@map`), modelos Prisma en `PascalCase`.
- Identificadores: UUID v7 (ordenables en el tiempo, buenos para índices).
- Códigos de negocio visibles (boleto, encomienda, traslado) separados del ID interno, con secuencias por tenant y serie.
- Borrado lógico (`deleted_at` / estado) en entidades referenciadas por operaciones históricas; `ON DELETE RESTRICT` por defecto.
- Errores con formato uniforme (código de negocio estable, mensaje y `traceId`).
- Commits con Conventional Commits.

## 6. Riesgos identificados

### 6.1 Entorno (bloquean la Fase 2)

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| E1 | Disco al 98 % | Fallo de builds e imágenes y posible corrupción de la base local | Liberar espacio (`docker system prune`, cachés) antes de la Fase 2 |
| E2 | Node 18 EOL activo | Dependencias incompatibles | `.nvmrc` con 24; `nvm use` |
| E3 | Docker daemon detenido | No se puede levantar el stack | Iniciar Docker Desktop |
| E4 | Puertos 5432/6379/80 ocupados | Conflictos al levantar contenedores | Mapear a 5433/6380/8080 en desarrollo |

### 6.2 Funcionales y de negocio

| # | Riesgo | Impacto |
|---|---|---|
| N1 | **Facturación electrónica SUNAT no figura en el requerimiento.** En Perú, la venta de pasajes y encomiendas exige comprobantes electrónicos (boleta/factura) emitidos vía SEE/OSE/PSE, con series y correlativos. | Sin esto el producto no es comercializable. Afecta el modelo de datos de ventas, caja, series por sucursal y anulaciones (notas de crédito). |
| N2 | **Obligaciones regulatorias de transporte**: manifiesto de pasajeros (MTC/SUTRAN) en terrestre y documentación de zarpe ante Capitanía de Puerto (DICAPI) en fluvial. Los formatos y campos obligatorios no están especificados. | Los manifiestos podrían no cumplir el formato exigido. |
| N3 | **Tratamiento tributario configurable**: la afectación de IGV difiere entre transporte de pasajeros, encomiendas y carga, y existen beneficios tributarios regionales en la Amazonía. | No debe codificarse ninguna tasa. Validar con un contador antes de la Fase 11. |
| N4 | **Protección de datos personales (Ley 29733)**: se almacenan DNI, teléfonos y datos de pasajeros y remitentes. | Requiere consentimiento, política de retención, cifrado de datos sensibles y registro de accesos. |
| N5 | **Alcance muy amplio** (16 fases). | Riesgo de no llegar a un MVP vendible. Conviene definir qué segmento de cliente se atiende primero (ver decisión D1). |
| N6 | **Pagos online** sin pasarela definida (Culqi, Niubiz, Izipay, Mercado Pago; Yape/Plin suelen conciliarse manualmente). | La venta online no puede completarse sin pasarela. La regla 11 prohíbe simular pagos. |
| N7 | **Dominios propios de tenants**: Nginx no emite certificados TLS bajo demanda. | Los subdominios se cubren con un certificado comodín; los dominios propios requieren Cloudflare for SaaS o Caddy con *on-demand TLS*. |
| N8 | **Offline**: sin conexión no puede garantizarse la prevención global de doble escaneo entre varios dispositivos (ya señalado en el requerimiento). | Se aceptará como limitación documentada, con conciliación posterior. |

### 6.3 Técnicos

| # | Riesgo | Mitigación |
|---|---|---|
| T1 | RLS + Prisma: el *pool* de conexiones puede filtrar contexto entre requests si se usa `SET` de sesión | Usar `set_config(..., true)` (local a la transacción) dentro de una transacción por operación. Pruebas específicas de fuga. |
| T2 | Restricciones de exclusión y SQL avanzado fuera del DSL de Prisma | SQL en migraciones, pruebas de integración contra PostgreSQL real (nunca mocks de base de datos para concurrencia). |
| T3 | Next.js multi-tenant por host con caché | Claves de caché que incluyan el tenant y prohibir caché compartida de páginas autenticadas. |
| T4 | Editor visual de plantillas (layout 2D) es un componente complejo | Acotar el alcance en la Fase 6: grilla con elementos posicionados, sin dibujo libre. |
| T5 | 7,5 GiB de RAM con dos apps Next en modo dev + Docker | Levantar solo las apps necesarias por tarea (filtros de Turborepo). |

## 7. Decisiones pendientes que afectan al modelo de datos

Cada decisión incluye una **recomendación**. Las que tienen `⚠️` deben resolverse antes de cerrar el modelo ER de la Fase 1.

| ID | Decisión | Recomendación |
|---|---|---|
| D1 ⚠️ | ¿Qué segmento se vende primero (encomiendas, pasajeros terrestres o fluvial mixto)? ¿Hay un cliente piloto? | Priorizar el módulo del cliente piloto dentro del orden de fases, sin saltarse la fundación. |
| D2 ⚠️ | ¿La facturación electrónica SUNAT entra en el MVP? ¿Mediante qué PSE/OSE (Nubefact, Efact, Bizlinks u otro)? | **Sí, en el MVP**, mediante PSE con una interfaz desacoplada (`ElectronicInvoicingProvider`). Modelar `FiscalDocument` y `DocumentSeries` por sucursal desde la Fase 1. |
| D3 ⚠️ | ¿Un usuario puede pertenecer a varios tenants con el mismo correo? | **No** en el MVP: usuario único por tenant (correo único por tenant). Más simple y coherente con el login por subdominio. |
| D4 ⚠️ | ¿Clientes y pasajeros se comparten entre tenants? | **No.** Cada tenant tiene su propio registro de clientes (privacidad y Ley 29733). |
| D5 ⚠️ | Métrica de usuarios facturables: ¿máximo del período, promedio o cantidad al cierre? | **Máximo diario del período** (snapshot diario y se factura el pico). Es predecible, difícil de manipular y fácil de explicar. Configurable por plan. |
| D6 ⚠️ | ¿Los vehículos pueden pertenecer a terceros (socios propietarios) con liquidaciones? | Modelar `VehicleOwner` y dejar `Settlement` preparado. Confirmar si es requisito del MVP. |
| D7 ⚠️ | ¿Las agencias de venta externas son terceros con comisión o solo sucursales propias? | Modelar el canal de venta (`SalesChannel`) y las agencias como entidad con comisión opcional. Confirmar. |
| D8 | Moneda: ¿solo PEN o multimoneda? | Campo `currency` en todo importe; solo PEN habilitado al inicio. |
| D9 | Pasarela de pago online | Interfaz `PaymentProvider`; elegir una pasarela antes de la Fase 8. Cobros de suscripción SaaS registrados manualmente en el MVP. |
| D10 | Autenticación web: cookies `httpOnly` o *bearer token* | Cookies `httpOnly` + `SameSite=Lax` + token CSRF para las apps web; *bearer* para la PWA operativa y futuras integraciones. |
| D11 | Dominios propios de tenants en el MVP | Solo subdominios en el MVP (certificado comodín); dominios propios después, con Cloudflare for SaaS. |
| D12 | Hosting de producción (VPS, proveedor, región) y dominio de la plataforma | Necesario antes de la Fase 15; conviene saberlo en la Fase 2 para CI/CD. |
| D13 | ¿Se aplica RLS desde el inicio? | **Sí, desde la Fase 3**, como segunda barrera. |
| D14 | Factor volumétrico por defecto | Configurable por tenant y modalidad; sin valor fijo en código. Se sugiere 5000 cm³/kg solo como valor inicial editable. |

## 8. Plan de ejecución

1. **Antes de la Fase 1**: aprobar o ajustar las decisiones D1–D7 (como mínimo D2–D5).
2. **Fase 1**: documento de arquitectura, C4 (contexto, contenedores, componentes del núcleo), modelo ER completo por dominios, diccionario de datos y ADR formales. Sin código de negocio.
3. **Antes de la Fase 2**: resolver los riesgos de entorno E1–E4.
4. **Fase 2 en adelante**: según el roadmap (`docs/development/roadmap.md`), una fase a la vez, con informe de cierre y pruebas.

## 9. Archivos creados en esta fase

- `docs/development/phase-0-audit.md` (este informe)
- `docs/architecture/architecture-decisions.md` (registro de ADR en estado *Propuesto*)
- `docs/development/roadmap.md`
- `PROJECT_STATUS.md`
- `README.md`
- `.nvmrc`, `.gitignore`, `.editorconfig`

No se ha escrito código de aplicación.

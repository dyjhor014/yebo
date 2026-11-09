# Registro de cambios de la documentación

Registro de **solo adición**. Cada entrada indica qué se añadió, qué existía y qué no se tocó. La fuente de verdad del detalle es el historial de git (`git log -p -- <archivo>`). Las entradas anteriores a este registro están en los commits `6c23c91` (Fases 0 y 1) y `29e9588` (Fase 2).

---

## 2026-11-05 · Iniciativa MKT-01 y metodología de diseño (propuesta)

- **Rama:** `docs/mkt-01-propuesta`, creada desde `fase-2/fundacion-tecnica`. El PR #1 de la Fase 2 no se modifica.
- **Estado:** propuesta pendiente de aprobación. Sin código.

### Documentos nuevos

| Documento | Contenido | Motivo |
|---|---|---|
| `docs/marketing/mkt-01-commercial-site.md` | Arquitectura del sitio comercial, páginas, SEO, flujo de prospectos, dependencias, conflictos, etapas y recomendación del momento | Entregables 2, 3, 4, 6 y 10 |
| `docs/design/design-methodology.md` | Evaluación de Impeccable (no disponible), principios propios, enfoque por contexto, capas de tokens con white label, propuesta de la Skill `yebo-design-system` | Entregables 1 y 7 |
| `docs/development/changelog.md` | Este registro | Entregables 8 y 9 |

### Documentos modificados (solo adiciones)

En todos los casos, `diff` contra la versión anterior da **0 líneas eliminadas o cambiadas**.

| Documento | Qué existía | Qué se añadió | Motivo |
|---|---|---|---|
| `docs/development/roadmap.md` | Tabla de fases 0–16 y nota de facturación electrónica | Sección "Iniciativas transversales": MKT-01, sus etapas y las adiciones propuestas a las Fases 4, 5 y 15, rotuladas como adiciones | Entregable 5. Las fases no se renumeran y sus criterios no cambian |
| `docs/architecture/architecture-decisions.md` | ADR-001 a 026 aceptados | Filas 027 y 028 (**Propuesto**) al final del índice y una sección nueva al final con su contenido | Conflicto K1 con ADR-002 y necesidad de tablas globales (K3). Ningún ADR aceptado se edita |
| `docs/architecture/decision-log.md` | Decisiones D1–D11 y cierres de fase | Una fila: MKT-01 solicitada, pendiente de aprobación | Trazabilidad de la solicitud |
| `PROJECT_STATUS.md` | Estado de la Fase 2 en revisión | Sección "Iniciativa transversal MKT-01" con las decisiones pendientes | Visibilidad del estado sin alterar la Fase 2 |

### No modificado (deliberadamente)

- ADR-001 a 026 y sus precisiones de aprobación.
- `system-overview.md` (C4). La adición `yebo.pe` → `apps/site` está documentada como pendiente (K2).
- `multitenancy.md`, `security.md`, `identity-and-sessions.md`, el diccionario de datos y los módulos.
- Código, configuración y CI.
- La autorización vigente: la Fase 2 sigue en revisión y la Fase 3 no comienza.

---

## 2026-11-05 · Aprobación de MKT-01 (segunda revisión)

- **Rama:** `docs/mkt-01-propuesta` (la misma).
- **Origen:** decisiones del responsable del proyecto (MKT-D1 a MKT-D6).
- **Sin código.**

| Documento | Qué existía (entrada anterior) | Qué cambió | Motivo |
|---|---|---|---|
| `docs/architecture/architecture-decisions.md` | ADR-027 y 028 como **Propuesto** | Estado **Aceptado**, condiciones de aprobación añadidas a cada uno, títulos de sección y de ADR actualizados, y descripción del índice de ADR-028 ajustada | MKT-D1, MKT-D2 |
| `docs/architecture/architecture-decisions.md` | Fila del índice de ADR-002: `**Aceptado**` | La misma fila: `**Aceptado** · ampliado por ADR-027 (2026-11-05)`. **El texto de la decisión ADR-002 no cambia** | Trazabilidad de la ampliación (MKT-D1) |
| `docs/architecture/decision-log.md` | Fila "MKT-01 solicitada, pendiente" | Seis filas nuevas, MKT-D1 a MKT-D6 (con un prefijo propio para no chocar con D1–D13) | Registro de las decisiones |
| `docs/marketing/mkt-01-commercial-site.md` | Propuesta pendiente; K1–K5 pendientes; dominio sujeto a D12 | Estado aprobado (sin implementación); K1, K3 y K4 resueltos y K5 autorizado; dominio `yebo.pe` aprobado con verificación pendiente; lista de subdominios reservados con `app`; condiciones de ADR-028 resumidas | MKT-D1 a MKT-D6 |
| `docs/design/design-methodology.md` | §1 "no disponible"; precedencia de 4 niveles; §6 decisiones pendientes | §1.1 conservada como historial; §1.2 nueva (revisión de la fuente oficial: componentes, hooks, red, archivos); §1.3 nueva (hallazgos I1–I6); precedencia aprobada de 5 niveles (§1.4); §6 identidad visual preliminar; §7 decisiones pendientes | MKT-D3, MKT-D4 |
| `docs/development/roadmap.md` | Sección de iniciativas como "propuesta" | Estado "planificación aprobada"; MKT-01.1 depende de aprobar la identidad; K4 como requisito aprobado de la Fase 4 con `app`; ADR-027/028 aceptados | MKT-D1, D2, D4, D6 |
| `PROJECT_STATUS.md` | Sección MKT-01 "propuesta" | Aprobado, no autorizado, pendiente (incluido el estado de Impeccable) | Visibilidad del estado |
| `docs/development/changelog.md` | Primera entrada | Esta entrada | Trazabilidad |

**No modificado:**

- el texto de ADR-001 a 026;
- el C4 (`system-overview.md`);
- `multitenancy.md` (la lista de tablas globales se actualizará al implementar ADR-028 en la Fase 4);
- `security.md`, el diccionario de datos y los módulos;
- código, configuración y CI.

**Impeccable no se instaló:** la revisión encontró los hallazgos I1–I6 y la instalación requiere un cambio de configuración, que no cabe en un PR documental.

---

## 2026-11-05 · Tercera revisión: correcciones tras la revisión de los PR

- **Rama:** `docs/mkt-01-propuesta`.
- **Sin código.**

| Documento | Qué existía | Qué cambió | Motivo |
|---|---|---|---|
| `docs/marketing/mkt-01-commercial-site.md` | "si se aprueba ADR-027" (§2.2 y K2); "dominio (D12)" en MKT-01.0; K5 "autorizada" | Redacción acorde a ADR-027 aceptado y al dominio aprobado; K5 instalada mediante el PR #3 | Textos anteriores a la aprobación |
| `docs/design/design-methodology.md` | §1.3: "instalación pendiente" | Estado de la instalación del PR #3 y regla `impeccable update --no-hooks` | El orden de integración previsto (#1 → #3 → #2) dejaría el texto anterior desactualizado |
| `PROJECT_STATUS.md` | "aún no instalada" y una tarea pendiente de instalación | Instalada mediante el PR #3; se retira la tarea | Ídem |
| `docs/development/changelog.md` | Dos entradas | Esta entrada | Trazabilidad |

---

## 2026-11-09 · Ampliación funcional: portal central, publicidad, comisiones y suscripción por usuario (propuesta)

- **Rama:** `docs/roadmap-monetizacion`, creada desde `docs/mkt-01-propuesta` (PR #2) para partir de MKT-01, ADR-027/028 y este registro sin modificar ningún PR existente. El estado de la Fase 3 vive en el PR #4.
- **Estado:** propuesta pendiente de aprobación. **Sin código, sin migraciones, sin cambios en Prisma ni en la API.**

### Documentos nuevos

| Documento | Contenido |
|---|---|
| `docs/modules/marketplace.md` | Portal central de viajes, recorrido del pasajero, índice de publicación (alternativas y diseño propuesto), conflicto de dominio con ADR-027, dependencias y decisiones AMP-Q1 a Q4 y Q15 |
| `docs/modules/platform-revenue.md` | Acuerdos comerciales por tenant, suscripción por usuario habilitado, comisión por venta de pasajes (modalidades, fotografía por venta, ciclo de vida, liquidación), gestión comercial y financiera, decisiones AMP-Q8 a Q14 y Q16 |
| `docs/modules/advertising.md` | Publicidad: alcance, modelos de administración, principios, etapas PUB-01 y decisiones AMP-Q5 a Q7 |

### Documentos modificados (solo adiciones)

| Documento | Qué existía | Qué se añadió |
|---|---|---|
| `docs/development/roadmap.md` | Fases 0–16, MKT-01 y sus adiciones | Sección "Ampliación funcional": mapa de funcionalidades, adiciones a las Fases 4, 7, 8, 11, 13 y 15, iniciativa PUB-01 y prioridades |
| `docs/architecture/architecture-decisions.md` | ADR-001 a 028 | Filas y secciones de ADR-029 a 033, **Propuestos** |
| `docs/architecture/decision-log.md` | D1–D11, MKT-D1 a D6 | Una fila: ampliación solicitada, pendiente |
| `docs/modules/billing.md` | Medición D5 | Nota: el precio por usuario podrá venir de un acuerdo (ADR-031); el cálculo no cambia |
| `docs/marketing/mkt-01-commercial-site.md` | Conflictos K1–K5 | K6: conflicto de dominio y de intención de búsqueda con el portal central, pendiente |
| `PROJECT_STATUS.md` | Estado de la Fase 2 y de MKT-01 | Sección "Ampliación funcional (propuesta)" |

### No modificado (deliberadamente)

- El texto de ADR-001 a 028, incluida la cláusula de dominio de ADR-027 (el conflicto se presenta en ADR-029).
- `system-overview.md` (C4), `multitenancy.md`, `security.md`, el diccionario de datos y el diagrama ER: las tablas propuestas se documentarán al aprobarse y diseñarse en su fase.
- Los criterios de aceptación y la numeración de las fases.
- Código, configuración, CI, Impeccable e identidad visual.

---

## 2026-11-09 · Decisión AMP-D1: distribución de `yebo.pe` (resuelve AMP-Q1)

- **Rama:** `docs/roadmap-monetizacion` (la misma). **Sin commit ni push** hasta la aprobación del responsable.
- **Origen:** decisión del responsable del proyecto: `yebo.pe/` para el portal central de viajes, `yebo.pe/empresas` para el sitio comercial y `<empresa>.yebo.pe` para las vitrinas.
- **Sin código.**

| Documento | Qué existía (entrada anterior) | Qué cambió | Motivo |
|---|---|---|---|
| `docs/architecture/architecture-decisions.md` | ADR-029 propuesto con tres opciones y `apps/marketplace` recomendada | ADR-029 **aceptado en cuanto al dominio**, con las alternativas evaluadas, la relación explícita con ADR-027 y MKT-D5, la separación de las tres experiencias, las consecuencias y las dependencias. Servir ambas secciones desde `apps/site` queda **propuesto**; se retira `apps/marketplace` por falta de justificación técnica. El índice de ADR-027 anota el reemplazo de la asignación exclusiva de la raíz. **El texto de ADR-027 no se edita** | AMP-D1, instrucciones 1, 2 y 5 |
| `docs/architecture/decision-log.md` | MKT-D5 (dominio `yebo.pe`) | Fila nueva AMP-D1, que modifica MKT-D5 y la asignación de la raíz de ADR-027. **MKT-D5 no se edita** (registro de solo adición) | Instrucción 2 |
| `docs/modules/marketplace.md` | §4 con el conflicto de dominio sin resolver | §4 reescrita: distribución aprobada, URL propuestas del portal (`/transportistas/` para no chocar con `/empresas`), SEO por intención de búsqueda y aplicación propuesta en `apps/site`. AMP-Q1 marcada como resuelta | Instrucciones 4, 5 y 7 |
| `docs/marketing/mkt-01-commercial-site.md` | Sitio en la raíz; K6 pendiente | Las URL comerciales pasan a `/empresas/...` (las legales quedan en la raíz, comunes al dominio); sitemap, Schema.org, Search Console y enlazado interno adaptados; las búsquedas B2C se derivan al portal; K6 resuelto. Alcance y objetivos sin cambios | Instrucciones 3 y 7 |
| `docs/development/roadmap.md` | Fila MKT-01 sin ubicación; adiciones a las Fases 4, 13 y 15 con subdominios y app por decidir | MKT-01 en `/empresas`; Fase 4 sin subdominios nuevos; Fases 13 y 15 con el portal como sección de `apps/site`; `/empresas/precios` | Instrucción 8 |
| `PROJECT_STATUS.md` | Conflicto abierto AMP-Q1 | AMP-D1 aprobada; pendientes AMP-Q2 a Q16 | Instrucción 8 |

**No modificado:** el texto de ADR-027 y de MKT-D5, las decisiones AMP-Q2 a Q16, el estado de ADR-030 a 033 (siguen **Propuestos**), el C4 (`system-overview.md`), `multitenancy.md`, el diccionario de datos, el código y los PR #1 a #4.

---

## 2026-11-09 · Confirmación de la aplicación compartida (AMP-D1 completa)

- **Rama:** `docs/roadmap-monetizacion`. **Sin commit ni push** hasta la autorización del responsable.
- **Origen:** el responsable confirma que `apps/site` sirve el portal central y el sitio comercial con rutas y layouts diferenciados; no se crea `apps/marketplace`. ADR-029 queda **aceptado** en sus dos decisiones. **No autoriza la implementación.**
- **Sin código.**

| Documento | Qué existía (entrada anterior) | Qué cambió |
|---|---|---|
| `docs/architecture/architecture-decisions.md` | ADR-029 aceptado solo en el dominio; aplicación propuesta | ADR-029 aceptado (dominio y aplicación compartida); título aclarado (portal en la raíz, sitio comercial en `/empresas`); alcance de la aceptación explícito. ADR-030 a 033 siguen **Propuestos**. El texto de ADR-027 no se edita |
| `docs/architecture/decision-log.md` | AMP-D1 con la distribución del dominio | AMP-D1 registra las dos decisiones (fila añadida en esta misma rama, sin commit; ninguna decisión anterior cambia) |
| `docs/modules/marketplace.md` | §4.3 propuesta | §4.3 aceptada; `/transportistas/` definido como directorio público del portal, distinto de `/empresas` y de las vitrinas |
| `docs/marketing/mkt-01-commercial-site.md` | robots.txt y canonical sin referencia a la ruta | robots.txt único para el dominio; canonical con la ruta `/empresas/...`; ADR-029 aceptado |
| `docs/development/roadmap.md` | ADR-029 aceptado en cuanto al dominio | ADR-029 aceptado; numeración y criterios de las fases sin cambios |
| `PROJECT_STATUS.md` | `apps/site` como propuesta | Las dos decisiones aprobadas; implementación no autorizada |
| `docs/marketing/mkt-01-commercial-site.md` (K6) | "ADR-029 (dominio aceptado)" | K6 indica que ADR-029 acepta el dominio y la aplicación compartida `apps/site` |
| `marketplace.md`, `architecture-decisions.md`, `roadmap.md`, `mkt-01-commercial-site.md` | Rutas del portal sin estado explícito | `/buscar`, `/rutas/...`, `/destinos/...` y `/transportistas/<slug>` identificadas como propuestas sujetas a definición en la Fase 13 |

Aprobación del responsable para el commit: cambios documentales aprobados; ADR-030 a 033 se incluyen como **Propuestos** (sin aprobación de su contenido) y AMP-Q2 a AMP-Q16 siguen pendientes.

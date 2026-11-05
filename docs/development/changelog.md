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

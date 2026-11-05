# Estado del proyecto — YEBO

**Última actualización:** 2026-11-05

## Fase actual

**Fase 1: Arquitectura y diseño (revisión 2).** Se incorporaron las 9 observaciones de la revisión. **En espera de aprobación explícita** de los ADR y de las decisiones listadas abajo. La Fase 2 **no** comienza sin esa aprobación.

No se ha escrito código de aplicación. Única herramienta añadida: `scripts/render-diagrams/` (renderizado reproducible de la documentación, sin dependencias npm).

## Fases completadas

- **Fase 0:** auditoría ([informe](docs/development/phase-0-audit.md)).

## Entregables de la Fase 1

| Documento | Contenido | Revisión 2 |
|---|---|---|
| [system-overview.md](docs/architecture/system-overview.md) | Principios, C4 L1–L3, capas, núcleo compartido, estrategias, supuestos | §5.1 núcleo frente a dominios; C4 L2 y mapa de capas rehechos |
| [multitenancy.md](docs/architecture/multitenancy.md) | Aislamiento, RLS, matriz de estados del tenant | §5 reescrita: categorías de operación + defensa en profundidad |
| [identity-and-sessions.md](docs/architecture/identity-and-sessions.md) | Hub de cuentas, PKCE, sesiones por dominio, refresh y revocación | **Nuevo** |
| [security.md](docs/architecture/security.md) | Autenticación, RBAC, cifrado, Ley 29733 | Referencias actualizadas |
| [capacity-and-inventory.md](docs/architecture/capacity-and-inventory.md) | Concurrencia por tramos con 8 ejemplos | Reescrito; **corrige el error de diseño en camarotes**; añade el aforo total |
| [main-flows.md](docs/architecture/main-flows.md) | Flujos de negocio | F1 y F5 remiten a los documentos nuevos |
| [billing.md](docs/modules/billing.md) | Medición de usuarios: intervalos, zona horaria, SQL, cierre | **Nuevo** |
| [shipments.md](docs/modules/shipments.md) | PIN de entrega: hash, pepper, intentos, recuperación | **Nuevo** |
| [electronic-invoicing.md](docs/modules/electronic-invoicing.md) | Integración con la API facturadora | §2.1–2.2: contrato interno versionado |
| [entity-relationship.md](docs/database/entity-relationship.md) | **19 diagramas ER** (antes 10, divididos por legibilidad) | Revisados visualmente |
| [data-dictionary.md](docs/database/data-dictionary.md) | Tablas y restricciones | Sesiones, medición, camarotes, pools y facturación |
| [architecture-decisions.md](docs/architecture/architecture-decisions.md) | ADR-001 a 023 | 6 revisados + 2 nuevos |
| [diagrams/](docs/diagrams/README.md) | 36 SVG renderizados y verificados | **Nuevo** |

## Decisiones pendientes de aprobación explícita

1. **ADR-001 a ADR-023**, en especial los revisados o nuevos: 007, 009, 014, 015, 016, 017, 022 y 023.
2. **Hub de cuentas visible** (`cuentas.<dominio>`, con la marca del tenant) durante el login, en lugar de un login directo en el dominio de la empresa (ADR-022, alternativa en identity-and-sessions §10).
3. **Medida diaria facturable = pico de usuarios simultáneos** (`PEAK_CONCURRENT`) frente a usuarios distintos en el día (billing §3). Elegí la primera por el ejemplo de D5.
4. **Matriz de estados del tenant:** duración de la gracia y del periodo de cierre tras `CANCELLED` (propuesta: 30 días); si "recibir encomiendas" en estado suspendido incluye **solo** la recepción por traslado (interpretación actual) o también el registro de nuevas encomiendas (que hoy se considera `NEW_COMMERCIAL`).
5. **Entrega excepcional sin PIN** (shipments §1.5): ¿debe existir y con qué requisitos?
6. **La entrega con PIN requiere conexión** (shipments §1.7). Es una consecuencia de no llevar el pepper a los dispositivos.

## Supuestos y puntos por validar (no bloquean la Fase 2)

D1 (cliente piloto), D6 (propietarios), D7 (agencias), S2 (contrato de la API de facturación; bloquea solo el adaptador), S5 (impuestos con un contador), S6 (formatos de manifiestos), D9 (pasarela de pago) y D12 (hosting).

## Bloqueos de entorno (antes de la Fase 2)

- [ ] **Disco: 97 % usado, 14 GB libres.** Las alternativas de liberación se presentaron en la conversación de la revisión 2. No se ha borrado nada.
- [ ] `nvm use` (Node 24).
- [ ] Iniciar Docker Desktop y limitar el tamaño de su disco virtual.
- [ ] Puertos 5432, 6379 y 80 ocupados: se usarán 5433, 6380 y 8080.

## Errores conocidos

Ninguno en código (no hay código). Error de diseño detectado y corregido en la revisión 2: la asignación parcial de camarotes impedía vender dos camas del mismo camarote a la vez (ADR-007).

## Próximas tareas

1. Aprobación de los ADR y de las decisiones 1–6.
2. Liberación de disco.
3. Fase 2: fundación técnica, con dos pruebas de concepto al inicio: RLS + extensión Prisma, y concurrencia con exclusión GIST + pools.

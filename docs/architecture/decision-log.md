# Registro de decisiones del proyecto

Decisiones de negocio y de producto tomadas por el responsable del proyecto. Las decisiones técnicas están en los [ADR](architecture-decisions.md). Este registro es **solo de adición**: si una decisión cambia, se añade una entrada nueva que referencia a la anterior.

| ID | Fecha | Decisión | Estado | Documentos |
|---|---|---|---|---|
| D1 | 2026-11-05 | Arquitectura completa (terrestre y fluvial; pasajeros, encomiendas y carga) con habilitación progresiva por módulos. El MVP prioriza al cliente piloto | Cliente piloto **pendiente** | system-overview §7 |
| D2 | 2026-11-05 | Facturación electrónica en el MVP mediante la API externa del propietario, configurable por tenant; contrato interno versionado | Aprobada. **Contrato de la API pendiente** (bloquea solo el adaptador) | electronic-invoicing |
| D3 | 2026-11-05 | Identidad global + membresías por empresa | Aprobada | multitenancy, identity-and-sessions |
| D3.1 | 2026-11-05 | Hub `cuentas.yebo.pe` con la identidad visual de la empresa de origen; sesiones por dominio; cambio de empresa sin contraseña | Aprobada | identity-and-sessions |
| D4 | 2026-11-05 | Clientes y pasajeros aislados por tenant; sin directorio global | Aprobada | security §5 |
| D5 | 2026-11-05 | Facturación por el pico diario de cuentas humanas habilitadas simultáneamente; sin contar sesiones; zona horaria fija | Aprobada | billing |
| D6 | 2026-11-05 | Modelo preparado para vehículos de terceros y liquidaciones (módulo apagado) | Pendiente de validación comercial | data-dictionary §4 |
| D7 | 2026-11-05 | Canales y agencias externas con comisiones (módulo apagado) | Pendiente de validación comercial | data-dictionary §3 |
| D8 | 2026-11-05 | `PAST_DUE` → `SUSPENDED` a los 7 días; `CANCELLED` con 30 días de cierre | Aprobada | multitenancy §5 |
| D9 | 2026-11-05 | En suspensión, vencimiento o cancelación: sin nuevas operaciones comerciales; se completan las obligaciones existentes | Aprobada | multitenancy §5 |
| D10 | 2026-11-05 | Entrega excepcional sin PIN: existe, deshabilitada por defecto, con doble autorización para valor alto | Aprobada | shipments §1.5b |
| D11 | 2026-11-05 | La entrega con PIN requiere conexión; sin validación offline | Aprobada | shipments §1.7 |
| — | 2026-11-05 | **Fase 1 aprobada.** Inicio de la Fase 2 en una rama independiente | — | PROJECT_STATUS |
| — | 2026-11-05 | **ADR-024, 025 y 026 aceptados** con precisiones: deriva Prisma/SQL obligatoria en CI; tenant fijado por transacción, nunca heredado; bloqueos en orden determinista y conflictos como errores controlados. **Fase 2 aprobada para revisión y cierre mediante PR** (sin merge automático; la Fase 3 no comienza hasta el cierre) | Aprobada | architecture-decisions, phase-2-results |
| — | 2026-11-05 | **Iniciativa MKT-01 solicitada** (sitio comercial, SEO, captación de prospectos y metodología de diseño). Propuesta documentada; ADR-027 y ADR-028 propuestos; Skill Impeccable no disponible en el entorno (instalación pendiente de autorización) | **Pendiente de aprobación** | mkt-01-commercial-site, design-methodology, roadmap |
| MKT-D1 | 2026-11-05 | **ADR-027 aprobado:** `apps/site` como tercera app Next.js, separada de la operativa, sin sesiones compartidas ni acceso directo a bases de datos; puede reutilizar paquetes compartidos. Amplía ADR-002 sin modificarlo | Aprobada (no autoriza la implementación) | architecture-decisions |
| MKT-D2 | 2026-11-05 | **ADR-028 aprobado:** prospectos de la plataforma, no de los tenants; tablas globales fuera del acceso de los tenants; `yebo_app` sin permisos; servicio de plataforma con permisos específicos; separación ventas, soporte y superadmin; auditoría y protección de datos; aislamiento respaldado por PostgreSQL | Aprobada (no autoriza la implementación) | architecture-decisions |
| MKT-D3 | 2026-11-05 | **Impeccable autorizada con revisión previa:** solo la fuente oficial `github.com/pbakaus/impeccable`, vía el marketplace de Claude Code, a nivel de proyecto (no global); hooks no activados sin revisión. Prioridad: ADR → seguridad → accesibilidad → `yebo-design-system` → Impeccable. No autoriza cambiar decisiones funcionales ni visuales aprobadas | Aprobada | design-methodology |
| MKT-D4 | 2026-11-05 | **Identidad visual:** sin identidad aprobada. Dirección preliminar: azul profundo, turquesa, blanco e inspiración amazónica. Sin logotipo definitivo ni tokens oficiales hasta aprobar una propuesta de identidad. `yebo-design-system` se crea al inicio de la Fase 4, tras esa aprobación | Dirección preliminar; identidad **pendiente** | design-methodology |
| MKT-D5 | 2026-11-05 | **Dominio objetivo `yebo.pe`.** Titularidad, disponibilidad y DNS por verificar antes del despliegue | Aprobada; verificación **pendiente** | mkt-01-commercial-site |
| MKT-D6 | 2026-11-05 | **K4 es requisito de la Fase 4:** lista de subdominios reservados (`www`, `api`, `app`, `cuentas`, `blog` y otros nombres internos) que los tenants no pueden registrar | Aprobada | roadmap, mkt-01-commercial-site |

Puntos abiertos que no bloquean: impuestos (validar con un contador), formatos de manifiestos MTC/DICAPI, pasarela de pago, hosting de producción.

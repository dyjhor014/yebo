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

Puntos abiertos que no bloquean: impuestos (validar con un contador), formatos de manifiestos MTC/DICAPI, pasarela de pago, hosting de producción.

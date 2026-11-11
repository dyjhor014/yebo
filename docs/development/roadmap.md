# Roadmap

Se trabaja una fase a la vez. No se avanza con errores críticos, decisiones bloqueantes abiertas ni pruebas importantes fallidas.

| Fase | Nombre | Criterio de aceptación | Estado |
|---|---|---|---|
| 0 | Auditoría y descubrimiento | Informe entregado y decisiones identificadas | ✅ Completada |
| 1 | Arquitectura y diseño | Documento de arquitectura, C4, ER, diccionario y ADR revisables | ✅ Aprobada (2026-11-05) |
| 2 | Fundación técnica | El proyecto levanta de forma reproducible y supera las pruebas iniciales | ✅ Aprobada para cierre mediante PR ([resultados](phase-2-results.md)) |
| 3 | Multitenancy y seguridad | Pruebas demuestran aislamiento total entre tenants | 🚧 Implementada (3.1–3.4), pendiente de revisión · criterio cumplido ([plan](phase-3-plan.md), [resultados](phase-3-results.md)) |
| 4 | Superadmin SaaS y membresías | Crear empresa, asignar plan, medir usuarios y calcular el importe | 🚧 Implementada (4.1–4.8), pendiente de revisión · criterio cumplido ([plan](phase-4-plan.md), [resultados](phase-4-results.md)) |
| 5 | White label | Dos portales visualmente distintos sin duplicar apps | Pendiente |
| 6 | Ubicaciones, agencias, flota y capacidades | Embarcación con camarotes, zona libre, bodega y cubierta; bus con asientos y bodega | Pendiente |
| 7 | Rutas, programación y viajes | Ruta multiparada con capacidad correcta por tramo | Pendiente |
| 8 | Pasajeros y boletos | Venta multicanal sin doble venta bajo concurrencia | Pendiente |
| 9 | Encomiendas y logística | Tenant solo de encomiendas operativo; PIN de 4 dígitos según la regla de negocio | Pendiente |
| 10 | Carga y transporte especial | Vehículo y maquinaria pesada con cotización y validación de capacidad | Pendiente |
| 11 | Caja, pagos y reportes | Conciliación de ventas, cobros y caja | Pendiente |
| 12 | Mailgun y notificaciones | Envíos de prueba, reintentos y sin duplicados | Pendiente |
| 13 | Portales públicos y UX | Seguimiento y reserva completos desde el móvil | Pendiente |
| 14 | Offline y sincronización | Operaciones pendientes se sincronizan sin duplicar | Pendiente |
| 15 | Pruebas, seguridad y producción | Sin errores críticos ni riesgos de seguridad abiertos | Pendiente |
| 16 | Evolución | — | Pendiente |

> La facturación electrónica (D2: integración con API externa) se implementa en la Fase 11. El adaptador depende del contrato documentado de la API.

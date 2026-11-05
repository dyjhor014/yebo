# Roadmap

Se trabaja una fase a la vez. No se avanza con errores críticos, decisiones bloqueantes abiertas ni pruebas importantes fallidas.

| Fase | Nombre | Criterio de aceptación | Estado |
|---|---|---|---|
| 0 | Auditoría y descubrimiento | Informe entregado y decisiones identificadas | ✅ Completada |
| 1 | Arquitectura y diseño | Documento de arquitectura, C4, ER, diccionario y ADR revisables | ✅ Aprobada (2026-11-05) |
| 2 | Fundación técnica | El proyecto levanta de forma reproducible y supera las pruebas iniciales | ✅ Aprobada para cierre mediante PR ([resultados](phase-2-results.md)) |
| 3 | Multitenancy y seguridad | Pruebas demuestran aislamiento total entre tenants | Pendiente |
| 4 | Superadmin SaaS y membresías | Crear empresa, asignar plan, medir usuarios y calcular el importe | Pendiente |
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

---

## Iniciativas transversales

> **Adición del 2026-11-05 (aprobada como planificación; la implementación requiere autorización por etapa).** Las iniciativas transversales no son fases: no renumeran, no reemplazan y no cambian las dependencias de la tabla anterior. Cada una tiene sus propias etapas, dependencias y criterios. Registro: [changelog](changelog.md).

| ID | Nombre | Objetivo | Estado |
|---|---|---|---|
| MKT-01 | Sitio web comercial de YEBO | Captar empresas de transporte como clientes: sitio corporativo del producto SaaS, SEO y flujo de prospectos. **No** es el White Label (Fase 5) ni los portales públicos de las empresas (Fase 13) | ✅ Planificación aprobada (ADR-027/028) · sin implementar · [documento](../marketing/mkt-01-commercial-site.md) |

### MKT-01 · Etapas

| Etapa | Contenido | Depende de | Criterio de aceptación | Momento recomendado |
|---|---|---|---|---|
| MKT-01.0 | Estrategia, marca, palabras clave validadas, dominio, decisión sobre ADR-027/028 | — | Propuesta aprobada · ✅ ADR-027/028 y dominio `yebo.pe` aprobados; pendientes la identidad visual, la validación de palabras clave y la verificación DNS | Ahora (solo documentación) |
| MKT-01.1 | Fundamentos de diseño: tokens en `packages/ui` y Skill `yebo-design-system` ([metodología](../design/design-methodology.md)) | MKT-01.0; **propuesta de identidad visual aprobada** (MKT-D4) | Contraste AA automatizado; tema de tenant de prueba accesible | Al inicio de la Fase 4 |
| MKT-01.2 | `apps/site`, formulario de demostración, módulo `commercial-leads`, gestión en `apps/platform` | Fases 3 y 4 cerradas; ADR-027/028 | Core Web Vitals en objetivo; axe sin errores; metadatos únicos; rate limit y CAPTCHA probados; prospectos invisibles para `yebo_app`; estado veraz de cada capacidad | Tras cerrar la Fase 4 |
| MKT-01.3 | Lanzamiento: producción, Search Console, analítica, textos legales | MKT-01.2; Fase 15 o despliegue previo dedicado | Sitemap sin errores; textos legales aprobados por un asesor | Con algo demostrable (Fase 8 o 9) y el piloto (D1) próximo |
| MKT-01.4 | Capturas reales, `/precios`, artículos | Cierre de las Fases 8–11 | Cada capacidad "Disponible" respaldada por una fase cerrada | Continuo |

### Adiciones propuestas a fases existentes (sin modificar su contenido ni su criterio)

| Fase | Adición | Origen |
|---|---|---|
| 4 | **Requisito aprobado (MKT-D6):** lista de subdominios reservados validada al crear tenants (`www`, `api`, `app`, `cuentas`, `admin`, `blog` y otros nombres internos) | MKT-01 §2.3 |
| 4 | Gestión de prospectos en `apps/platform` y enlace prospecto → tenant (ADR-028 aceptado, con sus condiciones) | MKT-01 §5 |
| 4 | Fundamentos de diseño MKT-01.1 antes de la primera UI | Metodología §5 |
| 5 | Capas de tokens (base, semántica, marca, datos) y validación de contraste de los temas de tenant | Metodología §4 |
| 15 | Despliegue de `apps/site`, CDN y Search Console (ADR-027 aceptado); verificación de titularidad y DNS de `yebo.pe` | MKT-01 §6 |

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
| MKT-01 | Sitio web comercial de YEBO | Captar empresas de transporte como clientes: sitio corporativo del producto SaaS, SEO y flujo de prospectos, en `yebo.pe/empresas` (AMP-D1). **No** es el White Label (Fase 5), ni los portales públicos de las empresas (Fase 13), ni el portal central de viajes de la raíz | ✅ Planificación aprobada (ADR-027/028; ubicación según ADR-029) · sin implementar · [documento](../marketing/mkt-01-commercial-site.md) |

### MKT-01 · Etapas

| Etapa | Contenido | Depende de | Criterio de aceptación | Momento recomendado |
|---|---|---|---|---|
| MKT-01.0 | Estrategia, marca, palabras clave validadas, dominio, decisión sobre ADR-027/028 | — | Propuesta aprobada · ✅ ADR-027/028 y dominio `yebo.pe` aprobados; pendientes la identidad visual, la validación de palabras clave y la verificación DNS | Ahora (solo documentación) |
| MKT-01.1 | Fundamentos de diseño: tokens en `packages/ui` y Skill `yebo-design-system` ([metodología](../design/design-methodology.md)) | MKT-01.0; **propuesta de identidad visual aprobada** (MKT-D4) | Contraste AA automatizado; tema de tenant de prueba accesible | Al inicio de la Fase 4 |
| MKT-01.2 | `apps/site`, formulario de demostración, módulo `commercial-leads`, gestión en `apps/platform` | Fases 3 y 4 cerradas; ADR-027/028 | Core Web Vitals en objetivo; axe sin errores; metadatos únicos; rate limit y CAPTCHA probados; prospectos invisibles para `yebo_app`; estado veraz de cada capacidad | Tras cerrar la Fase 4 |
| MKT-01.3 | Lanzamiento: producción, Search Console, analítica, textos legales | MKT-01.2; Fase 15 o despliegue previo dedicado | Sitemap sin errores; textos legales aprobados por un asesor | Con algo demostrable (Fase 8 o 9) y el piloto (D1) próximo |
| MKT-01.4 | Capturas reales, `/empresas/precios`, artículos | Cierre de las Fases 8–11 | Cada capacidad "Disponible" respaldada por una fase cerrada | Continuo |

### Adiciones propuestas a fases existentes (sin modificar su contenido ni su criterio)

| Fase | Adición | Origen |
|---|---|---|
| 4 | **Requisito aprobado (MKT-D6):** lista de subdominios reservados validada al crear tenants (`www`, `api`, `app`, `cuentas`, `admin`, `blog` y otros nombres internos) | MKT-01 §2.3 |
| 4 | Gestión de prospectos en `apps/platform` y enlace prospecto → tenant (ADR-028 aceptado, con sus condiciones) | MKT-01 §5 |
| 4 | Fundamentos de diseño MKT-01.1 antes de la primera UI | Metodología §5 |
| 5 | Capas de tokens (base, semántica, marca, datos) y validación de contraste de los temas de tenant | Metodología §4 |
| 15 | Despliegue de `apps/site`, CDN y Search Console (ADR-027 aceptado); verificación de titularidad y DNS de `yebo.pe` | MKT-01 §6 |

---

## Ampliación funcional (2026-11-09, propuesta)

> **Propuesta pendiente de aprobación. No autoriza ninguna implementación.** Se incorporan seis funcionalidades **ampliando fases existentes**, sin renumerarlas ni cambiar su criterio de aceptación, y con una iniciativa transversal nueva (PUB-01) para la publicidad. Decisiones de arquitectura: ADR-029 **aceptado** (AMP-D1: portal en la raíz `yebo.pe/`, sitio comercial en `yebo.pe/empresas`, ambos servidos por `apps/site`; no autoriza la implementación) y ADR-030 a 033 **Propuestos**. Decisiones de negocio pendientes: AMP-Q2 a AMP-Q16. Registro: [changelog](changelog.md).

| Funcionalidad | Documento | Dónde se incorpora |
|---|---|---|
| Portal central de viajes (marketplace) | [marketplace.md](../modules/marketplace.md) | Fase 13 (construcción) · Fase 15 (despliegue) |
| Índice central de publicación de viajes | [marketplace.md §3](../modules/marketplace.md) | Fase 7 (eventos) · Fase 8 (disponibilidad y atribución) · Fase 13 (proyección y búsqueda) |
| Publicidad y recomendaciones patrocinadas | [advertising.md](../modules/advertising.md) | Iniciativa transversal PUB-01 |
| Comisión por venta de pasajes | [platform-revenue.md §3](../modules/platform-revenue.md) | Fase 4 (acuerdo) · Fase 8 (fotografía por venta) · Fase 11 (liquidación) |
| Suscripción por usuario habilitado | [platform-revenue.md §2](../modules/platform-revenue.md) | Fase 4 |
| Gestión comercial y financiera | [platform-revenue.md §4](../modules/platform-revenue.md) | Fase 4 (suscripción y acuerdos) · Fase 11 (comisiones) · PUB-01 (campañas) |

### Adiciones propuestas a fases existentes (sin modificar su contenido ni su criterio)

| Fase | Adición | Origen | ADR |
|---|---|---|---|
| 4 | Acuerdos comerciales versionados por tenant: precio por usuario negociado y componente de comisión (porcentaje, modalidad, vigencia, historial). La medición D5 no cambia | platform-revenue §2 | 031 |
| 4 | Superadmin: acuerdos, suscripciones, usuarios facturables, pagos, vencimientos, saldos y auditoría comercial; vista "Obligaciones con YEBO" del tenant (`BILLING_SELF`) | platform-revenue §4 | 031 |
| 4 | Módulo `MARKETPLACE` en el catálogo de módulos. Sin subdominios reservados nuevos: el portal y el sitio comercial comparten `yebo.pe` por rutas (AMP-D1) | marketplace §4 | 029 |
| 7 | Contrato de los eventos de publicación de viajes (alta, cambio de horario o tarifa, cancelación, cierre de venta) en el outbox, y marca de publicable por ruta o viaje | marketplace §3 | 030 |
| 8 | Toda venta de pasaje guarda la fotografía del acuerdo de comisión (`platform_fee_accruals`) y la atribución del canal, incluida la referencia del portal central | platform-revenue §3 | 032 |
| 8 | Eventos de banda de disponibilidad (`DISPONIBLE`, `POCOS_ESPACIOS`, `AGOTADO`) | marketplace §3 | 030 |
| 11 | Reversión de comisiones por anulación y devolución, liquidaciones, ajustes, línea de comisión en `platform_invoices` y conciliación; vista de comisiones del tenant | platform-revenue §3–4 | 032 |
| 13 | Índice de publicación (proyección global con roles dedicados); portal central en la raíz `yebo.pe/` como sección de `apps/site`, con páginas de rutas, destinos y transportistas (URL propuestas, sujetas a definición en esta fase); enlace directo a la vitrina con el contexto en la URL | marketplace | 029, 030 |
| 15 | Despliegue de `apps/site` con las dos secciones (raíz y `/empresas`), sitemaps separados, CDN y monitorización del retraso del índice | marketplace §4–5 | 029 |

### Iniciativa transversal PUB-01 · Publicidad (propuesta)

Es una iniciativa y no una fase porque tiene otro tipo de cliente (anunciantes), un modelo de negocio sin decidir y dependencias en las Fases 4, 11, 13 y 15 ([advertising §2](../modules/advertising.md)).

| Etapa | Contenido | Depende de | Momento recomendado |
|---|---|---|---|
| PUB-01.0 | Modelo de administración y de cobro (AMP-Q5 a Q7), política editorial | — | Antes de la Fase 13 (solo decisiones) |
| PUB-01.1 | Anunciantes, campañas, espacios y moderación en `apps/platform` | Fase 4; PUB-01.0 | Tras el portal central |
| PUB-01.2 | Espacios rotulados en el portal central; impresiones y clics | Fase 13 | Tras el portal central |
| PUB-01.3 | Tarifas, pagos, facturación y reportes | Fase 11; D9 | Tras PUB-01.2 |
| PUB-01.4 | Espacios en las vitrinas (si se aprueba) | PUB-01.2; AMP-Q7 | Según demanda |

### Prioridad sugerida

1. **Alta:** acuerdos comerciales y suscripción por usuario (Fase 4), y la fotografía de la comisión en cada venta (Fase 8). Son baratas de incluir a tiempo y caras de reconstruir después.
2. **Media:** eventos de publicación (Fase 7), índice y portal central (Fase 13), liquidación de comisiones (Fase 11).
3. **Baja:** publicidad (PUB-01), después de que el portal central tenga tráfico.

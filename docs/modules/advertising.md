# Publicidad y recomendaciones patrocinadas

- **Estado:** 📝 Propuesta (2026-11-09). **Nada implementado ni autorizado. El modelo de administración no está decidido** (AMP-Q5 a AMP-Q7). Decisión de arquitectura: ADR-033 (**Propuesto**).
- **Ubicación en el roadmap:** iniciativa transversal **PUB-01** ([roadmap](../development/roadmap.md#ampliación-funcional-2026-11-09-propuesta)), con etapas tras las Fases 11 y 13.
- **Documentos relacionados:** [portal central](marketplace.md) · [ingresos de la plataforma](platform-revenue.md) · [security.md](../architecture/security.md) · [ADR-028](../architecture/architecture-decisions.md) (patrón de datos de plataforma).

---

## 1. Alcance

| Elemento | Contenido |
|---|---|
| Anunciantes | Hoteles y hospedajes, restaurantes, agencias de turismo, transporte local, movilidad, comercios y servicios en destino |
| Superficies | Portal central y, si se decide (AMP-Q7), las vitrinas de los tenants |
| Formatos | Banners, tarjetas promocionales, recomendaciones patrocinadas, ofertas por destino |
| Segmentación | **Contextual:** ciudad, origen, destino, ruta, empresa, modalidad y otros criterios comerciales por definir |
| Gestión | Anunciantes, campañas, espacios, fechas, segmentación, tarifas, pagos, impresiones, clics, métricas y reportes |

**Regla obligatoria:** todo contenido pagado se rotula visiblemente como «Patrocinado» o «Publicidad», con un estilo distinto del contenido orgánico, y nunca se intercala sin rótulo entre los resultados de búsqueda del portal.

## 2. Por qué es una iniciativa transversal y no una fase

- Introduce **otro tipo de cliente** (anunciantes, que no son tenants) con su propio ciclo comercial.
- Su **modelo de negocio no está decidido** (§3).
- Depende de varias fases (4, 11, 13 y 15) sin pertenecer a ninguna.

Es el mismo criterio con el que se planificó MKT-01. No se renumera ni se añade ninguna fase.

## 3. Modelo de administración (no decidido)

| Opción | Descripción | Ventajas | Inconvenientes |
|---|---|---|---|
| A · Gestionada por YEBO | YEBO vende y administra todos los espacios | Un solo inventario, criterios editoriales uniformes, una sola integración de cobro | Los tenants no reciben ingreso por su vitrina; necesitan *opt-in* para mostrar anuncios en ella |
| B · Gestionada por cada tenant | Cada empresa vende los espacios de su vitrina | Ingreso para el tenant; conoce su mercado local | Un "mini ad-server" por tenant; criterios dispares; datos de anunciantes dentro de cada tenant |
| C · Mixta | YEBO gestiona el portal central; en las vitrinas, YEBO o el tenant según su acuerdo, con reparto de ingresos | Flexible | La más compleja: reparto, liquidación al tenant, conflictos de exclusividad |

**Recomendación (para validar):** empezar por **A en el portal central únicamente**. Abrir las vitrinas después, con *opt-in* del tenant y exclusión de categorías (como mínimo, ninguna empresa de transporte competidora en la vitrina de otra). Reevaluar C cuando haya demanda real.

## 4. Principios de diseño (ADR-033, propuesto)

| Tema | Regla propuesta | Motivo |
|---|---|---|
| Datos | Anunciantes, campañas, creatividades, espacios y métricas en **tablas globales de plataforma**, con un rol de BD dedicado y `yebo_app` sin permisos (patrón de ADR-028) | Los anunciantes no son tenants; sus datos no se mezclan con los de ninguno |
| Segmentación | **Solo contextual** (ruta, ciudad, fecha, modalidad, empresa). Sin perfiles de personas ni datos de los pasajeros de los tenants | D4, Ley 29733 y ADR-019: los datos de los pasajeros pertenecen a cada tenant |
| Entrega | Creatividades propias servidas por YEBO (imagen y texto revisados). **Sin scripts de redes publicitarias de terceros** | CSP estricta (`security.md`), privacidad y rendimiento |
| Medición | Impresiones contadas en el servidor con filtrado de bots; clics a través de un endpoint de redirección de YEBO; agregados por día, sin identificar personas | Métricas verificables para facturar, sin seguimiento entre sitios |
| Moderación | Toda creatividad se aprueba antes de publicarse; categorías prohibidas configurables | Reputación de YEBO y de los tenants |
| Separación del buscador | El orden orgánico de los viajes no depende de la publicidad (AMP-Q4) | Confianza del pasajero |
| Cobro | Pago manual registrado (como `subscription_payments`) en el MVP; pasarela cuando se decida D9. Comprobante de YEBO por el puerto de ADR-015 | Coherencia con la facturación de la plataforma |

## 5. Etapas propuestas (PUB-01)

| Etapa | Contenido | Depende de | Criterio de aceptación |
|---|---|---|---|
| PUB-01.0 | Decisiones AMP-Q5 a AMP-Q7, textos legales y política editorial | — | Modelo aprobado |
| PUB-01.1 | Anunciantes, campañas, espacios y moderación en `apps/platform` | Fase 4; PUB-01.0 | Aislamiento: `yebo_app` sin acceso a las tablas de publicidad |
| PUB-01.2 | Espacios y rótulos en el portal central; medición de impresiones y clics | Fase 13 (portal central); PUB-01.1 | Todo anuncio rotulado; sin scripts de terceros; filtrado de bots probado |
| PUB-01.3 | Tarifas, pagos, facturación y reportes al anunciante | Fase 11; D9 | Importe facturado = métricas cerradas del período |
| PUB-01.4 | Espacios en las vitrinas (si se aprueba) | PUB-01.2; AMP-Q7 | *Opt-in* del tenant y exclusión de competidores probados |

## 6. Decisiones pendientes

| ID | Pregunta |
|---|---|
| AMP-Q5 | ¿Quién administra los espacios: YEBO, los tenants o un modelo mixto? (§3) |
| AMP-Q6 | ¿Cómo se comercializan y cobran las campañas? Tarifa fija por período y espacio, por mil impresiones (CPM) o por clic (CPC); prepago o crédito |
| AMP-Q7 | Publicidad en las vitrinas: ¿*opt-in*, reparto de ingresos con el tenant, exclusión de competidores y categorías? |
| AMP-Q16 | Tratamiento tributario de la publicidad (compartida con [platform-revenue §6](platform-revenue.md)) |

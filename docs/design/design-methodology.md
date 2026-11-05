# Metodología de diseño visual del frontend de YEBO

- **Estado:** propuesta revisada (2026-11-05). Impeccable autorizada con revisión previa (MKT-D3). Identidad visual **no aprobada**, solo una dirección preliminar (MKT-D4). No hay código ni tokens implementados.
- **Alcance:** todas las interfaces de YEBO:
  - el sitio comercial (MKT-01);
  - el panel de la empresa y el superadmin;
  - los portales públicos y el seguimiento de encomiendas;
  - venta, reservas, caja, embarque y operaciones;
  - formularios, tablas, dashboards, reportes y componentes.
- **Rango:** complementa, nunca reemplaza, los ADR, la seguridad (`security.md`), la accesibilidad y las reglas de negocio. Ante un conflicto, prevalecen estas.

---

## 1. Evaluación de la Skill Impeccable

### 1.1 Disponibilidad comprobada (2026-11-05)

Primera comprobación: **Impeccable no estaba disponible en este entorno.** Búsquedas realizadas:

| Ubicación | Resultado |
|---|---|
| Skills listadas por Claude Code en esta sesión | No aparece |
| `~/.claude/skills/` (personales y sincronizadas) | No existe |
| `.claude/skills/` del proyecto | El repositorio no tiene carpeta `.claude/` |
| `~/.claude/plugins/` y caché del marketplace oficial (`claude-plugins-official`) | Sin coincidencias para "impeccable" |

En ese momento no se describieron sus instrucciones. Tras la autorización (MKT-D3) se revisó la fuente oficial (§1.2). **Sigue sin instalarse.**

### 1.2 Revisión de la fuente oficial (2026-11-05, autorizada en MKT-D3)

Fuente: `https://github.com/pbakaus/impeccable`, commit `ac0966d` del 2026-11-05. Se clonó en un directorio aislado y **no se ejecutó nada**.

**Qué instala el marketplace de Claude Code** (`.claude-plugin/marketplace.json` → `./plugin`): el plugin **`impeccable` v4.8.0**, licencia Apache 2.0, 65 archivos.

| Componente | Contenido | Acciones ejecutables |
|---|---|---|
| Skill `impeccable` (`SKILL.md`, 87 líneas, + 40 referencias) | 24 subcomandos (`audit`, `critique`, `polish`, `typeset`, `layout`, `colorize`, `harden`, `init`, `document`…); "modos" por superficie (*Persuade*, *Operate*, *Read*…); un suelo de calidad (`craft-floor.md`) | Pide ejecutar `scripts/impeccable context` una vez por sesión |
| 4 agentes | `asset-producer`, `documenter`, `finish-reviewer`, `manual-edit-applier`. Tres de ellos pueden escribir archivos | Al invocarlos |
| **Hooks** (`hooks/hooks.json`) | `SessionStart` (5 s), **`PostToolUse` en cada `Edit`/`Write`** (5 s) y `Stop` ("deep pass", 30 s) | Ejecutan `scripts/impeccable hook` **automáticamente** al habilitar el plugin |
| Lanzador `scripts/impeccable` (POSIX sh) | Busca un binario nativo (Rust, "engine" v0.1.18). Si no lo encuentra, lo **descarga de GitHub Releases** a `~/.impeccable/bin/0.1.18/` y lo verifica con SHA-256 contra `engine-checksums.txt` (linux-x64: `736ed785…f648`). Si no hay checksum, se niega a descargar | Descarga y ejecuta un binario |
| Scripts de navegador (`live-browser*.js`, 0,6 MB) | Modo `live`: inyección en la página en desarrollo | Solo con `/impeccable live` |

**Comportamiento de red del motor:**

- Telemetría **activada por defecto**: envía a `https://impeccable.style/api/chosen` las elecciones entre propuestas de diseño (identificadores de la opción elegida, ronda y modo; no envía código ni contenido del proyecto). Se desactiva con `DO_NOT_TRACK=1`, `IMPECCABLE_NO_TELEMETRY=1` o `"telemetry": false` en `.impeccable/config.json`.
- Comprobación de versiones (`GET https://impeccable.style/api/version`). Se desactiva con `"updateCheck": false`.

**Archivos que escribe en el proyecto:**

- `PRODUCT.md` y `DESIGN.md` en la raíz (`init`, `document`; en un rediseño "se reemplaza DESIGN.md");
- `.impeccable/config.json` (compartido) y `.impeccable/config.local.json`;
- briefs de superficie;
- en algunos modos, entradas de hooks en `.claude/settings.local.json`.

### 1.3 Hallazgos frente a las condiciones de MKT-D3 y MKT-D4

| # | Hallazgo | Condición afectada | Tratamiento propuesto |
|---|---|---|---|
| I1 | Al instalar el plugin desde el marketplace, sus **3 hooks quedan activos sin un paso de activación separado**. `PostToolUse` se ejecuta en cada edición de todo el monorepo, también en el backend (los `.ts` se analizan en silencio salvo que haya hallazgos) | "No activar hooks sin revisar" | Revisados en §1.2. Se propone instalar con el detector desactivado (`IMPECCABLE_HOOK_DISABLED=1` y `hook.enabled: false`) y activarlo después solo si lo autorizas. **Pendiente de verificar tras la instalación** que, con esa configuración, los hooks terminan sin efecto |
| I2 | El motor se descarga y se cachea en `~/.impeccable/` (carpeta de usuario, fuera del proyecto) | "No instalar globalmente" | Fijar `IMPECCABLE_HOME` en una carpeta del proyecto ignorada por git |
| I3 | Telemetría y comprobación de versiones activadas por defecto | Protección de datos y control de dependencias | `telemetry: false` y `updateCheck: false` en `.impeccable/config.json` versionado |
| I4 | `init` y `document` generan `PRODUCT.md` y `DESIGN.md`, que actúan como sistema de diseño de facto | **MKT-D4:** sin tokens ni identidad oficiales sin aprobación | No ejecutar `init`, `document` ni flujos que escriban `DESIGN.md` hasta aprobar la identidad. `DESIGN.md` se tratará como un documento que requiere aprobación |
| I5 | Instalar en el proyecto modifica `.claude/settings.json` (plugins habilitados y marketplace conocido) | El PR documental debe ser **solo documentación** | La instalación va en un **cambio separado** (PR de configuración), no en el PR de MKT-01 |
| I6 | El principio de la Skill "Finish the job… production-grade code" podría empujar a implementar | Límites de autorización vigentes | La precedencia de §1.4 manda: Impeccable no autoriza implementar ni cambiar decisiones |

**Estado: revisión completada. Instalación pendiente** de tu confirmación de la configuración segura (I1–I3) y de hacerla en un cambio separado (I5).

### 1.4 Cómo se adoptaría

- **Impeccable:** metodología complementaria de oficio. Comandos de revisión (`audit`, `critique`), refinamiento (`polish`, `typeset`, `layout`, `harden`) y su suelo de calidad. Sus "modos" encajan con los contextos de §3: *Persuade* con el sitio comercial y *Operate* con los paneles y la operación.
- **`yebo-design-system` (§5):** las decisiones propias de YEBO y cómo aplicarlas en cada contexto.
- **Orden de precedencia (aprobado, MKT-D3):**
  1. ADR y decisiones de arquitectura (incluidas las reglas de negocio aprobadas);
  2. seguridad;
  3. accesibilidad (WCAG 2.2 AA);
  4. identidad y reglas de `yebo-design-system`;
  5. Impeccable, como metodología complementaria de diseño.

  Si Impeccable recomienda algo que contradice un nivel superior, se documenta y gana el nivel superior. **Impeccable no autoriza a cambiar decisiones funcionales ni visuales ya aprobadas.**
- Usar la misma guía **no implica una estética idéntica**: cada contexto tiene su objetivo (§3).

## 2. Principios propios de YEBO

Independientes de cualquier Skill.

1. **La verdad del sistema, a la vista.**
   - Estados operativo, comercial y fiscal separados (principio 3 de la arquitectura) y siempre distinguibles.
   - Nunca se muestra como confirmado algo pendiente: retenciones, sincronización offline, comprobantes en proceso.
2. **Prevenir antes que corregir.** En las acciones irreversibles o de dinero (anular, reembolsar, cerrar caja, entregar sin PIN), la confirmación muestra el efecto concreto: importe, asiento, tramo.
3. **Intención visual, no plantilla.**
   - Cada pantalla parte de la tarea del usuario, no de un layout genérico de dashboard.
   - Se evitan los patrones de "diseño autogenerado": tarjetas idénticas en rejilla, degradados decorativos sin función, iconos genéricos en cada título, métricas de relleno.
4. **Densidad según el contexto, no según la moda.** La información se agrupa por la decisión que permite tomar.
5. **El contexto local es parte del diseño.** Español del Perú; términos del dominio ("pasaje", "encomienda", "zarpe", "embarque", "agencia"); `PEN` con formato `S/ 1 234,50`; fechas en `America/Lima`; documentos peruanos (DNI, RUC, CE).
6. **Funciona en el peor caso real.** Muelles con sol directo, conexiones inestables (Fase 14), teléfonos de gama baja y lectores de código de barras.

## 3. Enfoque por contexto

| Contexto | Objetivo dominante | Densidad | Tipografía y color | Interacción | Presupuesto y entrada |
|---|---|---|---|---|---|
| **Sitio comercial (MKT-01)** | Diferenciación, confianza, claridad de la propuesta, conversión | Baja; ritmo editorial | Escala expresiva (títulos grandes), marca YEBO protagonista, color con intención narrativa | Pocas acciones: una CTA principal por sección | LCP < 2,5 s; JS mínimo; móvil primero |
| **Panel de la empresa** | Configurar y supervisar con productividad y consistencia | Media | Escala compacta; color reservado a estado y acción; marca del tenant en elementos acotados (§4) | Teclado y ratón; tablas con filtros persistentes; formularios largos por secciones | Escritorio primero, responsive real |
| **Superadmin YEBO** | Control de la plataforma, soporte, facturación SaaS | Media-alta | Marca YEBO sobria; señalización fuerte del contexto (no confundirlo con el panel de un tenant) y del acceso de soporte | Acciones sensibles con confirmación y motivo (auditoría) | Escritorio |
| **Operación (POS, caja, embarque, almacén)** | Rapidez, legibilidad, pocos pasos, cero errores | Alta pero escaneable | Tamaños grandes para los datos críticos (asiento, tramo, importe); alto contraste, legible al sol; el color nunca es la única señal | Flujos de ≤ 3 pasos; atajos de teclado; lector de códigos; objetivos táctiles ≥ 44 px; estados offline explícitos | Tableta y escritorio; red inestable |
| **Portales públicos (reserva)** | Simplicidad, confianza, accesibilidad | Baja | Marca del tenant; tipografía de alta legibilidad | Un paso por pantalla en móvil; errores en lenguaje claro | Móvil primero; gama baja; 3G |
| **Seguimiento de encomiendas** | Saber dónde está y qué falta, sin cuenta | Mínima | Línea de tiempo clara; estados con texto + icono | Búsqueda por código; datos personales parciales (`public_tracking_show_recipient_initials`) | Móvil; carga instantánea |
| **Reportes y dashboards** | Comparar y decidir | Media-alta | Paleta de datos validada, independiente de la marca del tenant | Filtros explícitos de periodo y zona horaria; exportación | Escritorio |

## 4. Tokens y convivencia con el white label (Fase 5)

Un mismo sistema da servicio a la marca YEBO y a las marcas de los tenants. Propuesta de capas en `packages/ui` (ADR-002):

| Capa | Contenido | ¿Personalizable por un tenant? |
|---|---|---|
| **Base** | Escala de espaciado, radios, sombras, escala tipográfica, *breakpoints*, duración de animaciones | No |
| **Semántica** | Éxito, peligro, advertencia, información, foco; estados de inventario (libre, retenido, vendido, bloqueado) | **No.** Un asiento "vendido" debe significar lo mismo en todas las empresas |
| **Marca** | Primario, acento, logo, una fuente de una lista blanca (coherente con `site_versions.config`) | Sí, en los portales públicos y en el sitio del tenant; de forma acotada en sus paneles |
| **Datos** | Paleta de gráficos | No |

- Todo color de marca de un tenant pasa una **validación automática de contraste** (AA) al publicarse. Si falla, se ajusta o se rechaza con un mensaje claro.
- Las interfaces operativas no adoptan colores de marca en los elementos semánticos.
- El sitio comercial usa solo la marca YEBO.

Esto **no modifica** ninguna decisión aprobada de la Fase 5. Es la propuesta de cómo implementarla, a confirmar en esa fase.

## 5. Propuesta de Skill propia: `yebo-design-system`

### 5.1 ¿Conviene? Sí, con condiciones

**A favor:**

- Las decisiones de diseño de YEBO (contextos, capas de tokens, estados de inventario, terminología, formato peruano) se repiten en todas las fases de UI.
- Sin una guía cargable, cada sesión de trabajo las redescubre y aparecen inconsistencias.

**Condiciones:**

1. **No crearla todavía.** La identidad visual no está aprobada (solo una dirección preliminar, §6). Crearla ahora obligaría a inventar decisiones.
2. **Se crea en MKT-01.1, al inicio de la Fase 4**, después de aprobar la propuesta de identidad visual y junto con los primeros tokens reales.
3. **No duplica valores:** los tokens viven en código (`packages/ui`). La Skill remite a ellos y explica cómo usarlos.
4. **No duplica Impeccable:** si se adopta, la Skill solo dice cuándo y cómo aplicarla en YEBO.

### 5.2 Ubicación y estructura propuestas

En el repositorio (`.claude/skills/yebo-design-system/`), versionada y revisada por PR como el resto del código.

```
.claude/skills/yebo-design-system/
├── SKILL.md              # cuándo usarla, cómo elegir el contexto, verificaciones obligatorias, orden de precedencia
└── references/
    ├── identity.md       # marca YEBO: logo, uso, tono de voz (solo cuando esté aprobada)
    ├── tokens.md         # mapa de capas (§4) y enlace a packages/ui; sin copiar valores
    ├── contexts.md       # tabla §3 desarrollada, con ejemplos correctos e incorrectos
    ├── components.md     # inventario de packages/ui: cuándo usar cada uno y cuándo no
    ├── patterns.md       # formularios, tablas, estados (vacío, carga, error, offline, pendiente),
    │                     # confirmaciones de dinero, formato es-PE, PEN y zona horaria
    ├── accessibility.md  # WCAG 2.2 AA aplicada: foco, contraste, objetivos táctiles, lector de pantalla
    ├── white-label.md    # qué puede personalizar un tenant y qué no; validación de contraste
    ├── content.md        # terminología del dominio y microcopia de errores
    └── review.md         # lista de revisión antes de cerrar un PR de UI
```

### 5.3 Contenido del `SKILL.md` (borrador de las reglas, no definitivo)

- **Cuándo cargarla:** al crear o modificar cualquier interfaz en `apps/web`, `apps/platform`, `apps/site` o `packages/ui`.
- **Primer paso obligatorio:** identificar el contexto (§3) y declararlo en el PR.
- **Verificaciones antes de terminar:**
  - contraste AA;
  - navegación por teclado;
  - estados vacío, carga, error y offline;
  - textos en español peruano;
  - ningún color semántico sobrescrito por la marca;
  - presupuesto de rendimiento del contexto;
  - ninguna capacidad presentada como disponible si su fase no está cerrada (sitio comercial).
- **Precedencia:** la de §1.4 (aprobada).

## 6. Identidad visual (MKT-D4)

- **No existe una identidad de marca aprobada.**
- **Dirección preliminar** indicada por el responsable: azul profundo, turquesa, blanco e inspiración amazónica.
- **Restricciones vigentes:**
  - no se crea un logotipo definitivo;
  - no se fijan valores de color, tipografía ni tokens oficiales;
  - la dirección preliminar no es una paleta aprobada.
- **Siguiente paso:** una **propuesta de identidad visual**, presentada para su aprobación antes del inicio de la Fase 4. Incluirá:
  - logotipo en exploración;
  - paleta con contraste verificado (AA) en claro y oscuro;
  - tipografía con licencia apta para autoalojarla;
  - tono de voz;
  - aplicación en los contextos de §3.

  Solo tras aprobarla se crean los tokens en `packages/ui` y la Skill `yebo-design-system`.

## 7. Decisiones pendientes que necesitan al responsable del proyecto

0. **Instalación de Impeccable:** confirmar la configuración segura de §1.3:
   - detector desactivado;
   - `IMPECCABLE_HOME` dentro del proyecto;
   - sin telemetría ni comprobación de versiones;
   - sin `init` ni `document` hasta aprobar la identidad;
   - instalación en un PR de configuración separado.
1. Aprobar la propuesta de identidad visual (cuando se presente).
2. Aprobar el enfoque por contextos (§3) y las capas de tokens (§4) como base para la Fase 4.
3. Confirmar la creación de `yebo-design-system` al inicio de la Fase 4, tras aprobar la identidad (ya indicado en MKT-D4).

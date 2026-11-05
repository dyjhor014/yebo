# Impeccable en YEBO: instalación y mantenimiento

Skill de diseño de terceros (`pbakaus/impeccable`, Apache 2.0) instalada en el proyecto el 2026-11-05. Su papel y su precedencia frente a las decisiones de YEBO se describen en la metodología de diseño de la iniciativa MKT-01.

## Estado actual

| Elemento | Valor |
|---|---|
| Versión | Skill 4.8.0 (release firmada `skill-v4.8.0`) · motor 0.1.18 |
| Ubicación | `.claude/skills/impeccable/` y `.claude/agents/impeccable-*.md` (versionados, **sin modificar**) |
| Motor nativo | `.claude/skills/impeccable/scripts/bin/<os>-<arch>/impeccable` (no se versiona). Si falta, el lanzador lo descarga y verifica su SHA-256 contra `engine-checksums.txt` |
| Hooks | **Prohibidos.** Instalada con `--no-hooks`; además `hook.enabled: false` en `.impeccable/config.json` |
| Telemetría | Desactivada (`"telemetry": false`) |
| Conexiones que se mantienen | `GET https://impeccable.style/api/roll` (catálogo visual, al iniciar un diseño) y `GET https://impeccable.style/api/version` (aviso de versión, sin actualización automática) |

## Reglas

1. **Actualizar siempre con `--no-hooks`:**
   ```bash
   npx impeccable@<versión> update --no-hooks --project
   ```
   Sin ese parámetro, la actualización puede instalar o reparar los hooks (`SessionStart`, `PostToolUse` y `Stop`) en `.claude/settings.local.json`: `--no-hooks` es lo que garantiza que no toca los manifiestos de hooks. Antes de actualizar, revisar el cambio de versión y obtener aprobación.
2. Tras cualquier actualización, comprobar:
   - que no existen `.claude/settings.json` ni `.claude/settings.local.json`;
   - que `impeccable hooks status` indica `disabled`;
   - que `impeccable telemetry status` indica `off`.
3. **No modificar** los archivos distribuidos. Están excluidos de Prettier (`.prettierignore`) y de las comprobaciones de espacios en blanco (`.gitattributes`), para que sigan idénticos a la release.
4. **No ejecutar** `init`, `document` ni flujos que generen `PRODUCT.md` o `DESIGN.md` mientras no haya una identidad visual aprobada.
5. No usar `impeccable hooks on`.

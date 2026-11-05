# Estado del proyecto — YEBO

**Última actualización:** 2026-11-05

## Fase actual

**Fase 2: Fundación técnica — aprobada para revisión y cierre mediante PR.** El PR hacia `main` espera la revisión del responsable del proyecto. **No se fusiona automáticamente.** La Fase 3 no comienza hasta el cierre. Resultados: [phase-2-results.md](docs/development/phase-2-results.md).

## Fases completadas

- **Fase 0:** auditoría ([informe](docs/development/phase-0-audit.md)).
- **Fase 1:** arquitectura y diseño, aprobada el 2026-11-05 (ADR-001 a 023; [registro de decisiones](docs/architecture/decision-log.md)).

## Estado de la Fase 2

| Verificación requerida para el PR | Resultado |
|---|---|
| Migración desde una base vacía | ✅ producción y las dos PoC |
| Migración desde el esquema anterior (con datos) | ✅ las dos PoC; en producción no hay esquema anterior |
| Aislamiento RLS, con contexto vacío y conexiones reutilizadas | ✅ 25 pruebas + verificación estática de ADR-025 |
| Repetición de las 40 colisiones | ✅ 0 interbloqueos con ADR-026 (antes, 18–28 de 40) |
| Mayor concurrencia (300 ventas, 40 conexiones) | ✅ solo errores controlados; 0 dobles ventas |
| Tramos superpuestos y no superpuestos | ✅ |
| Formato, lint, typecheck, unitarias (32) y build | ✅ |
| Integración (6 suites, 66 pruebas) | ✅ en desarrollo y en una sala limpia que simula CI |

## ADR

- ADR-001 a 023: aceptados (Fase 1).
- **ADR-024, 025 y 026: aceptados** (2026-11-05), con estas precisiones:
  - **ADR-024:** prueba de deriva obligatoria en CI.
  - **ADR-025:** tenant fijado por transacción, nunca heredado.
  - **ADR-026:** orden de bloqueo determinista; los conflictos se traducen en errores controlados.

## Iniciativa transversal MKT-01 (planificación aprobada, 2026-11-05)

**Sitio web comercial de YEBO**, más la metodología de diseño del frontend. Solo hay documentación; **nada implementado**. No altera la Fase 2 en revisión ni autoriza la Fase 3.

- Documentos: [mkt-01-commercial-site.md](docs/marketing/mkt-01-commercial-site.md) · [design-methodology.md](docs/design/design-methodology.md) · [roadmap §Iniciativas transversales](docs/development/roadmap.md#iniciativas-transversales) · [changelog](docs/development/changelog.md).
- **Aprobado:**
  - ADR-027 (`apps/site`, amplía ADR-002);
  - ADR-028 (módulo global de prospectos, con condiciones);
  - dominio `yebo.pe`;
  - subdominios reservados como requisito de la Fase 4;
  - Impeccable con revisión previa. **Revisión hecha; aún no instalada**, porque los hooks se activan al instalar, el motor se cachea en `~/.impeccable` y la telemetría está activa por defecto. Ver [metodología §1.3](docs/design/design-methodology.md).
- **No autorizado:**
  - implementar `apps/site` o el módulo de prospectos;
  - otros cambios de arquitectura;
  - avanzar a la Fase 3.
- **Pendiente:**
  - confirmar la configuración segura de Impeccable e instalarla en un PR de configuración separado;
  - propuesta de identidad visual (dirección preliminar: azul profundo, turquesa, blanco, inspiración amazónica);
  - verificación de titularidad y DNS de `yebo.pe`;
  - validación de las palabras clave.

## Supuestos y puntos por validar (no bloquean)

D1 (cliente piloto), D6 (propietarios), D7 (agencias), S2 (contrato de la API de facturación; bloquea solo el adaptador), S5 (impuestos con un contador), S6 (formatos de manifiestos), D9 (pasarela de pago) y D12 (hosting).

## Entorno

- Node 24 (`nvm use`). El Node 18 del sistema no cumple `engines`.
- Docker Desktop: `systemctl --user start docker-desktop`. Puertos 5433 (PostgreSQL) y 6380 (Redis).
- Los volúmenes creados antes de este cambio necesitan la base `yebo_migrations` (ver phase-2-results §4). Ya está creada en el entorno local.
- Disco: 36 GB libres (93 %).

## Errores conocidos

Ninguno abierto.

## Próximas tareas

1. Revisión del PR de la Fase 2 por el responsable del proyecto. El merge lo hace él.
2. Tras el cierre: activar la protección de `main` exigiendo el check de CI.
3. Fase 3 (multitenancy y seguridad), **solo después del cierre de la Fase 2**.

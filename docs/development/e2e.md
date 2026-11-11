# Recorridos E2E del panel (Playwright y axe)

Fase 4.7c. Están en el workspace `tests/e2e` (`@yebo/e2e`), con `@playwright/test` 1.64.1 y `@axe-core/playwright` 4.14.0, ambos solo de desarrollo.

## Ejecutar

```bash
pnpm infra:up                         # PostgreSQL y Redis
pnpm --filter @yebo/e2e exec playwright install chromium   # una vez por equipo
pnpm test:e2e                         # compila API y panel y ejecuta los recorridos
```

- **Base de datos:** siempre `yebo_test`. La preparación global vacía staff, catálogo, empresas y facturación, pone a cero los límites de intentos de Redis y crea un superadmin con el bootstrap real.
- **Hosts y puertos:** `admin.yebo.localhost:3201`, una dirección que Chromium resuelve a loopback y trata como contexto seguro (las cookies `__Host-` funcionan sin TLS). Detrás hay un proxy mínimo (`support/proxy.mjs`): `/api` va a la API en el puerto 4200 y el resto al panel en el 3202, el mismo origen que con Nginx en producción. Los puertos son propios, así que no chocan con `pnpm dev` ni con `pnpm https:up`.
- **Informe:** `tests/e2e/report/` en HTML, con trazas y capturas de los fallos en `tests/e2e/results/`. Ambas carpetas las ignora git.

## Qué cubren

| Proyecto | Recorrido |
|---|---|
| `acceso` | Sin sesión, redirige al login. Errores del login. Activación obligatoria de la MFA con la clave de la pantalla, incluidos el código mal formado y el incorrecto. Cierre de sesión y nuevo acceso con un código de 6 dígitos, sin reutilizar el ya usado |
| `recorrido` | La maqueta 4.7 v2 de principio a fin:<br>• empresas: vacía, alta con errores y la invitación del primer administrador («Copiar» y la confirmación al cerrar sin copiar), urgencia, próximo hito y filtros;<br>• ficha: trayecto, «Registrar pago» (supera el saldo, fecha futura, falta la referencia, pago parcial con coma decimal, anulación con motivo y pago total que reactiva), invitar a la empresa (Esc sin copiar), cambio de plan, acceso de soporte (abrir y revocar), excepciones (crear y terminar), historial, resumen y cambio de estado (cancelar exige el nombre);<br>• staff: dominio @yebo.pe y Superadmin con confirmación;<br>• planes |
| `oscuro`, `movil` | Las mismas pantallas y un diálogo en modo oscuro y a 390 px: axe y comprobación de que nada se desplaza en horizontal |
| `capturas` | Solo con `YEBO_E2E_CAPTURAS=1`: guarda cada pantalla renderizada, con sus estilos, en `tests/e2e/capturas/`, para el detector de Impeccable |

**Accesibilidad:** axe aplica WCAG 2.1 A y AA (contraste incluido) en cada pantalla y en cada diálogo. Para comprobar que la verificación funciona de verdad, se quitó el nombre del botón de cerrar de los diálogos y el recorrido falló con `button-name` (crítico).

**Datos que el panel aún no crea:** la factura vencida se prepara por SQL con el rol de pruebas `yebo_test_bypass` (ADR-034), y el plan por la API con la sesión del recorrido.

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
| `flota` | Fase 6.4d, panel de la empresa (`08-flota-planos.spec.ts`), con la administradora registrada desde su invitación:<br>• Ubicaciones: puerto con departamento, provincia y distrito (ubigeo del INEI), sucursal y su mostrador;<br>• Planos: «Nuevo plano» desde una plantilla y el editor. Comprueba el teclado del plano, deshacer, quitar, las filas que no caben con «Antes de publicar», pisos y zonas, el autoguardado al recargar y publicar. También que a 1440 × 900 la página no se desplaza y el plano sigue a la vista;<br>• Flota: tipo, vehículo y asignación del plano publicado; versión nueva a partir de la publicada;<br>• modo oscuro y 390 px: axe y nada se desplaza en horizontal |
| `agencias` | Fase 6.5b, panel de la empresa (`09-agencias.spec.ts`), con una empresa nueva sin el módulo `AGENCIES`:<br>• sin el módulo, «Agencias» no está en el carril y su dirección lo explica;<br>• YEBO enciende el módulo con una excepción y la sección aparece;<br>• alta con el RUC comprobado junto al campo (pegado con guiones o espacios), RUC repetido, edición, archivar y restaurar;<br>• su canal en «Ubicaciones › Canales de venta», con el nombre de la agencia y sin «Activar» mientras está archivada;<br>• modo oscuro y 390 px: axe y nada se desplaza en horizontal, también con el diálogo abierto |
| `criterio` | Fase 6.6, criterio de la fase con el editor (`10-criterio-fase6.spec.ts`), con una empresa fluvial y terrestre:<br>• lancha desde un plano en blanco: camarotes de 2 camas, zona libre, cubierta de carga y un piso de bodega, con el aforo;<br>• bus terrestre de dos pisos en blanco: 4 filas 2 + 2 en el piso 1 y 10 en el piso 2, con la numeración seguida, y la bodega de equipaje en su propio piso, con el aforo;<br>• publicar (el diálogo resume cada plano) y asignar desde Flota, donde cada vehículo solo ve los planos de su modalidad;<br>• camioneta pickup 4×4 con celdas de 25 cm: asientos de cabina con su clase de precio, la tolva partida en pasajeros (con la clase de precio de la zona) y carga, y su tipo desde la sugerencia del catálogo;<br>• la capacidad materializada del plano vigente de cada vehículo, comprobada en la base;<br>• axe en el editor, en los diálogos de publicar y en Flota |
| `rutas` | Fase 7.5a, panel de la empresa (`11-rutas-tarifas.spec.ts`), con una empresa fluvial y tres ubicaciones:<br>• carril con «Operación» y «Configuración»;<br>• Rutas: nueva ruta con tiempos escritos a mano y su error junto a la fila, Alt + flechas, traza GPX, aviso fluvial, archivar y restaurar;<br>• Tarifas: clase a mano, precio, cambio programado, anular, cambiar el fin y precios en lote;<br>• modo oscuro y 390 px: axe y nada se desplaza en horizontal |
| `viajes` | Fase 7.5b, panel de la empresa (`12-viajes.spec.ts`), con una empresa terrestre, una ruta de tres paradas y un bus con plano:<br>• Programaciones: diaria con fecha excluida y «Generar viajes» (58 creados; la segunda vez, ninguno);<br>• Viajes: agenda semanal y viaje puntual sin unidad, cancelado con motivo;<br>• ficha: abrir a la venta, tramo con el teclado, bloqueos de asientos y cupo, error de ocupado, volver a planificado rechazado por la ocupación, liberar y volver;<br>• modo oscuro y 390 px: axe y nada se desplaza en horizontal |
| `capturas` | Solo con `YEBO_E2E_CAPTURAS=1`: guarda cada pantalla renderizada, con sus estilos, en `tests/e2e/capturas/`, para el detector de Impeccable |

**Accesibilidad:** axe aplica WCAG 2.1 A y AA (contraste incluido) en cada pantalla y en cada diálogo. Para comprobar que la verificación funciona de verdad, se quitó el nombre del botón de cerrar de los diálogos y el recorrido falló con `button-name` (crítico).

**Datos que el panel aún no crea:** la factura vencida se prepara por SQL con el rol de pruebas `yebo_test_bypass` (ADR-034), y el plan por la API con la sesión del recorrido.

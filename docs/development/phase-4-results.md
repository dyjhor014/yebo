# Fase 4 · Resultados (superadmin SaaS y membresías)

- **Fecha:** 2026-11-10.
- **Rama:** `fase-4/plan`, solo con commits locales; push y PR esperan la autorización del responsable.
- **Plan y decisiones:** [phase-4-plan.md](phase-4-plan.md).
- **Criterio de aceptación** ([roadmap](roadmap.md)): «Crear empresa, asignar plan, medir usuarios y calcular el importe».
- **Estado:** ✅ **cumplido**. Lo demuestra una prueba automática de extremo a extremo que forma parte de `pnpm test:integration` y, por tanto, de la CI (`.github/workflows/ci.yml`).

## 1. Qué se construyó

| Etapa | Commit | Contenido |
|---|---|---|
| 4.1 · Staff de YEBO | `99587b7` | Realm propio en `admin.<dominio>`. MFA TOTP obligatoria, roles de plataforma y auditoría. Rol de base de datos `yebo_backoffice` |
| 4.2 · Catálogo comercial | `b67e470` | Planes con versiones inmutables, módulos efectivos (plan ∩ servicios ± excepciones) y `@RequiresModule` |
| 4.3a · Alta y estados | `6a357f5` | Alta de empresas con subdominio y servicios. Máquina de estados con historial, job de estados y excepción temporal de `USERS_ADD` |
| 4.3b · Invitaciones | `b54696b` | Primer administrador en el alta, invitaciones de la empresa y aceptación en el hub, creando la cuenta si hace falta |
| — | `7ac682e` | 503 reintentable, en lugar de 500, cuando el pool de PostgreSQL se satura (era la causa del fallo intermitente de la 3.4) |
| 4.4 · Medición | `fd58c89`, `adcf690` | Historial de membresías escrito por triggers, con su autor. Valor diario (billing §3), snapshots FINAL con el rol `yebo_metering` y consumo en el panel |
| 4.5 · Períodos y cobro | `318e63c` | Cierre de períodos, precio en un punto único (F4-Q1), facturas inmutables, pagos manuales, vencimiento → PAST_DUE y reactivación, «Obligaciones con YEBO» y cambio de plan con prorrateo |
| 4.6 · Acceso de soporte | `c5a2e10` | Accesos temporales con motivo, visibles para la empresa, con aprobación opcional, READ_ONLY y registro de cada petición |
| 4.7a · Panel | `aff5f8e` | `packages/ui`, `apps/platform` con acceso con MFA, Empresas y ficha con cobro |
| 4.7b · Panel | `83d686d` | Anulación de pagos (API y panel), acciones y pestañas de la ficha, alta de empresa, planes y staff |
| — | `2d55992` | Modo HTTPS local para probar desde la red (OpenSSL, Nginx y sslip.io) |
| 4.7c · E2E y pulido | `7f484e5` | Playwright y axe (WCAG 2.1 AA) en claro, oscuro y móvil. «Nueva empresa» pulida con Impeccable. Menú móvil |
| 4.8 · Cierre | este documento | Prueba del criterio de extremo a extremo |

**Migraciones:** 4.1 a 4.7b, todas aplicadas a `yebo_dev` con copia previa (`pg_dump`, fuera del repositorio) y la reversión documentada en la cabecera de cada una. La 4.7c y la 4.8 no tienen migración.

## 2. El criterio de aceptación

Prueba: [`apps/api/test/integration/phase4-criterion.int-spec.ts`](../../apps/api/test/integration/phase4-criterion.int-spec.ts).

**Qué hace:** recorre la API real con todos sus módulos, guards, RLS y roles de base de datos. Usa el reloj de la aplicación sustituido por uno que avanza noche a noche. Cada noche ejecuta los mismos jobs del worker y en su orden: primero los snapshots de los días terminados y después el cierre de los períodos vencidos.

| Paso | Quién y cómo |
|---|---|
| Crear la empresa y asignarle el plan | El staff publica un plan (S/ 99 al mes, 5 usuarios incluidos, S/ 15 por adicional, pico diario, pago a 7 días) y da de alta la empresa con ese plan y su primer administrador |
| Usuarios | El administrador crea su cuenta desde el enlace (hub). Por la API de la empresa invita, suspende y reactiva personas, que crean su cuenta desde su enlace |
| Medir | Cada noche se cierran los días terminados (en la zona de la empresa, Lima) |
| Calcular el importe | Al terminar el período, el cierre emite la factura |
| Cobrar | Sin pago al vencer, la empresa pasa a PAST_DUE. El staff registra el pago y vuelve a «Al día» |

### Escenario y resultado (período del 1 al 31 de octubre de 2026)

| Día | Qué pasa | Pico del día |
|---|---|---|
| 1 oct | Administrador + 5 personas | 6 |
| 10 oct | +4 personas | 10 |
| 15 oct | Se suspende a 3 a las 10:00 | 10, porque hasta las 10:00 había 10 |
| 16–19 oct | — | 7 |
| 20 oct | Vuelve 1 | 8 |
| 25 oct | Reemplazo en la misma operación: sale una persona y entra otra | 8, porque las salidas se cuentan antes que las entradas (billing §3) |

| Cálculo (billing §5) | Valor |
|---|---|
| Valor del período (pico diario, máximo de los 31 días) | 10 |
| Incluidos / adicionales | 5 / 5 |
| Base + adicionales | S/ 99.00 + 5 × S/ 15.00 |
| **Factura** | **S/ 174.00**, emitida el 1 nov y con vencimiento el 8 nov. Líneas BASE 99.00 y EXTRA_USERS 5 × 15.00 |

**Otras comprobaciones de la prueba:**
- Antes del cierre no hay factura.
- Repetir los jobs no crea nada.
- El staff ve el saldo en la lista del panel (próximo hito: cierre del período siguiente, 30 nov) y las líneas en la ficha.
- La empresa la ve en «Obligaciones con YEBO».
- El 9 nov la empresa pasa a PAST_DUE y, al registrar el pago, vuelve a «Al día».

**Mutaciones verificadas contra esta prueba:**
- Detectadas: un adicional de menos, el pico tratado como promedio, contar membresías no facturables, ignorar las salidas y procesar las entradas antes que las salidas en el mismo instante.
- Equivalente para el pico, por eso sobrevive: no recortar los intervalos al día. Solo afecta a la medida informativa `distinct_active`.

### Hallazgo: el reloj del historial

Los triggers de `membership_status_history` fechan con el reloj de PostgreSQL (`now()`). En producción coincide con el de la aplicación, pero una prueba que simula semanas no puede mover ese reloj.

**Lo que no se hizo:** cambiar los triggers. Dejar que la aplicación dicte las fechas del historial de facturación permitiría falsearlo.

**Cómo lo resuelve la prueba:**
- Simula un mes **pasado**, octubre de 2026, de modo que el reloj de PostgreSQL va siempre por delante del simulado y los intervalos que cierra el trigger son válidos.
- Tras cada acción, traslada las fechas recién escritas al instante simulado, con el guardián del historial desactivado solo en esa transacción. Es lo mismo que hace el fixture de `billing.int-spec`.

## 3. Totales

Entorno: 2026-11-10, Node 24.22.2, PostgreSQL 17.6, Redis 7.4.6.

| Batería | Resultado |
|---|---|
| Integración (`pnpm test:integration`, CI) | 22 suites y **360 pruebas** ✅. Incluye el criterio, el aislamiento entre tenants de la Fase 3 y la deriva del esquema (ADR-024) |
| Unitarias de la API | 21 suites y 144 pruebas ✅ |
| Unitarias del panel (`apps/platform`) | 18 ✅ |
| Contratos | 2 ✅ |
| E2E del panel (`pnpm test:e2e`, Playwright y axe) | 12 ✅. Acceso con MFA, recorrido completo, modo oscuro y 390 px. Se ejecuta en local (necesita Chromium); no forma parte de la CI |
| Tipos, lint y formato del monorepo | ✅ |

**Mutaciones:** en cada etapa se mutó el código y las funciones SQL nuevas hasta que todas las mutaciones no equivalentes quedaron detectadas. El detalle está en cada etapa del plan.

## 4. Pendientes al cerrar la Fase 4

Anotados en cada etapa del plan; ninguno impide cumplir el criterio.

| Pendiente | Origen |
|---|---|
| S5: fijar `tax_rate` cuando el contador valide los impuestos (hoy, tasa 0 configurable) | 4.5 |
| Ajustes, notas de crédito y anulación de facturas (`ADJUSTMENT`, `CREDIT`, `VOID`); los tipos existen, la operación no | 4.5 |
| Rotación de `FIELD_ENCRYPTION_KEY` y restablecer la MFA de un miembro del staff | 4.1 |
| Código QR al activar la MFA (hoy, la clave para escribirla a mano) | 4.7a |
| Crear planes y versiones desde el panel (hoy, por la API) | 4.7b |
| Vistas globales de «Cobros» y «Accesos de soporte» (hoy, en la ficha de cada empresa) | 4.7b |
| Fin de las excepciones de operación calculado con la hora de Perú (UTC−5) | 4.7b |
| `cancelledClosingDays` del plan (hoy, constante de 30 días) y `config` de los módulos del plan | 4.2, 4.3a |
| Dominios propios (`CUSTOM`) y su verificación | 4.3a |
| Límites del plan (sucursales, vehículos, almacenamiento): se aplicarán con los módulos que creen esos recursos | 4.2 |
| E2E del panel en la CI (requiere Chromium en el runner) | 4.7c |

**Fuera del alcance de la Fase 4** (sin cambios):
- acuerdos comerciales y comisiones (ADR-031 y ADR-032);
- incidencias de soporte (F4-Q5);
- envío de correo (Fase 12);
- pasarela de pago (D9);
- comprobantes fiscales (Fase 11);
- white label (Fase 5).

## 5. Siguiente paso

1. Revisión de la Fase 4 por el responsable.
2. Push y PR solo con su autorización: la rama arrastra los commits de la Fase 3 sin subir.
3. La Fase 5 (white label) no empieza sin aprobación expresa.

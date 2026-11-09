# Facturación SaaS y medición de usuarios (Usage Metering)

> **Aprobado el 2026-11-05:** el pico diario de cuentas humanas habilitadas simultáneamente. **No** se cuentan sesiones conectadas: el cálculo se basa en los intervalos de vigencia de las membresías habilitadas, en la zona horaria fija del período. Un reemplazo sin superposición (se deshabilita la cuenta anterior y luego se habilita la nueva) **no** suma dos usuarios.

- **Decisión base:** D5. Se factura el máximo de usuarios humanos activos, configurable por plan.
- **ADR:** ADR-016.

## 1. Qué es un "usuario facturable"

En un instante dado, una **membresía** cuenta como facturable si se cumple **todo** lo siguiente:

| Condición | Motivo |
|---|---|
| `tenant_memberships.status = ACTIVE` | `INVITED` (no aceptada), `SUSPENDED` y `REVOKED` no cuentan |
| `tenant_memberships.billable = true` | Solo YEBO puede ponerlo en `false` (excepción comercial auditada) |
| `users.status = ACTIVE` | Un usuario deshabilitado globalmente deja de contar en todas sus empresas |
| Es una persona (`tenant_memberships`) | Las **cuentas de servicio e integraciones** están en otra tabla (`service_accounts`) y el **staff de YEBO** en `platform_users`. Quedan excluidos por diseño, no por un filtro que podría olvidarse |

Una persona con acceso a dos empresas cuenta **una vez en cada una**: cada empresa paga por su propio acceso.

## 2. Intervalos de actividad

### 2.1 Fuente: `membership_status_history`

Cada vez que cambia **cualquiera** de los factores anteriores, en la **misma transacción** que el cambio:

1. Se cierra la fila vigente de la membresía (`valid_to = now()`).
2. Se abre una nueva (`valid_from = now()`, `valid_to = NULL`) con `status`, `billable` y `effective_billable` (el resultado de las cuatro condiciones).

Un cambio global del usuario (deshabilitarlo) hace esto en **todas** sus membresías.

| Garantía | Cómo |
|---|---|
| Sin huecos ni solapes por membresía | `EXCLUDE USING gist (membership_id WITH =, tstzrange(valid_from, valid_to) WITH &&)` |
| No se puede reescribir el pasado | Las fechas las pone el servidor (`now()`), nunca el cliente. Un trigger rechaza `valid_from` anterior a `now() − 1 min` y cualquier `UPDATE` que no sea cerrar `valid_to` de la fila vigente. `DELETE` está prohibido |
| Reproducibilidad | Cualquier cálculo puede rehacerse desde el historial y debe dar el mismo resultado |

Intervalo de actividad facturable de una membresía = cada fila con `effective_billable = true`, como `tstzrange(valid_from, COALESCE(valid_to, 'infinity'), '[)')`.

### 2.2 El día según la zona horaria de la empresa

Un "día" es el día calendario **en la zona horaria del período de facturación** (`billing_periods.timezone`, copiada de `tenants.timezone` al abrir el período y **fija** durante todo el período):

```sql
-- día D en la zona horaria tz → rango absoluto en UTC
tstzrange( (D::timestamp       AT TIME ZONE tz),
           ((D + 1)::timestamp AT TIME ZONE tz), '[)')
```

- Para `America/Lima` (UTC−5, sin horario de verano), el 10/11/2026 es `[2026-11-10 05:00Z, 2026-11-11 05:00Z)`.
- El cálculo es correcto también en zonas con horario de verano: el día puede durar 23 o 25 horas.
- Si la empresa cambia de zona horaria a mitad de período, el cambio se aplica **desde el período siguiente**. Así no se pierden ni se duplican horas.

## 3. Valor diario

Para cada día se calculan **dos** medidas y se guardan ambas:

| Medida | Definición | Uso |
|---|---|---|
| `peak_concurrent` | Máximo de membresías facturables **activas al mismo tiempo** en algún instante del día | **Valor facturable por defecto.** Corresponde al ejemplo de D5 ("5 usuarios activos simultáneamente como máximo en un día") |
| `distinct_active` | Membresías distintas que estuvieron facturables en algún momento del día | Informativa. Detecta rotación de cuentas. Puede elegirse por plan |

```sql
WITH day AS (
  SELECT tstzrange(($d::timestamp AT TIME ZONE $tz), (($d + 1)::timestamp AT TIME ZONE $tz), '[)') AS r
),
iv AS (   -- intervalos facturables recortados al día
  SELECT h.membership_id,
         tstzrange(h.valid_from, COALESCE(h.valid_to, 'infinity'), '[)') * day.r AS c
    FROM membership_status_history h, day
   WHERE h.tenant_id = $tenant AND h.effective_billable
     AND tstzrange(h.valid_from, COALESCE(h.valid_to, 'infinity'), '[)') && day.r
),
ev AS (   -- +1 al empezar, −1 al terminar (si termina dentro del día)
  SELECT lower(c) AS t, +1 AS d FROM iv
  UNION ALL
  SELECT upper(c), -1 FROM iv, day WHERE upper(c) < upper(day.r)
),
run AS (  -- en el mismo instante, las salidas (−1) se procesan antes que las entradas (+1)
  SELECT SUM(d) OVER (ORDER BY t, d ROWS UNBOUNDED PRECEDING) AS active FROM ev
)
SELECT COALESCE((SELECT MAX(active) FROM run), 0)             AS peak_concurrent,
       (SELECT COUNT(DISTINCT membership_id) FROM iv)           AS distinct_active;
```

Ordenar las salidas antes que las entradas en el mismo instante evita contar dos veces un reemplazo inmediato (se desactiva a Ana y se activa a Luis en la misma operación).

### 3.1 Ejemplo

Empresa en Lima, día 10/11/2026 (hora local):

| Membresía | Facturable |
|---|---|
| Ana | todo el día |
| Beto | 00:00 – 10:00 (se le suspende) |
| Carla | desde las 10:00 (reemplaza a Beto) |
| Dino | 14:00 – 16:00 |

| Franja | Activos | Simultáneos |
|---|---|---|
| 00:00 – 10:00 | Ana, Beto | 2 |
| 10:00 – 14:00 | Ana, Carla | 2 |
| 14:00 – 16:00 | Ana, Carla, Dino | **3** |
| 16:00 – 24:00 | Ana, Carla | 2 |

`peak_concurrent = 3` y `distinct_active = 4`.

## 4. Snapshots diarios

- Un job horario (rol `yebo_metering` desde la Fase 4.4, con el contexto de cada empresa; F4-Q2) busca, por empresa, los días **ya terminados en su zona horaria** (+15 min de margen) que aún no tienen snapshot `FINAL`, y los calcula. Es idempotente: `UNIQUE (tenant_id, usage_date)` + `UPSERT`.
- Como el historial no puede modificarse hacia atrás, un día terminado no puede cambiar: el snapshot `FINAL` es definitivo.
- El panel muestra el valor del día en curso calculado al vuelo (`PROVISIONAL`, sin guardar).
- Cada snapshot guarda `timezone`, `day_range`, `algorithm_version`, ambas medidas y el detalle (IDs de las membresías contadas) para la auditoría.
- Si el job estuvo caído varios días, al volver calcula todos los días pendientes. El resultado es el mismo que si hubiera corrido a tiempo.

## 5. Valor del período e importe

`plan_versions` define:
- `usage_metric`: `PEAK_DAILY` (por defecto), `AVERAGE_DAILY` o `END_OF_PERIOD`.
- `daily_aggregation`: `PEAK_CONCURRENT` (por defecto) o `DISTINCT_ACTIVE`.

| `usage_metric` | Valor del período |
|---|---|
| `PEAK_DAILY` | `MAX(valor diario)` de los días del período |
| `AVERAGE_DAILY` | `CEIL(AVG(valor diario))` |
| `END_OF_PERIOD` | Valor del último día |

```
usuarios_adicionales = MAX(0, valor_periodo − included_users)
importe = base_price + usuarios_adicionales × extra_user_price
```

Ejemplo con el Plan Profesional (precios de ejemplo): base S/ 99, 5 incluidos, S/ 15 por adicional. El pico del período es 12, así que hay 7 adicionales: 99 + 7 × 15 = **S/ 204**.

## 6. Cierre del período

1. `billing_periods.status`: `OPEN → CLOSING` cuando termina el último día del período en su zona horaria.
2. Se verifica que existan snapshots `FINAL` para **todos** los días del período. Si falta alguno, se calcula; si no se puede, el cierre se detiene y se alerta. Nunca se factura con días faltantes.
3. Se crea `usage_period_calculations` con: métrica, agregación, valor, incluidos, adicionales, importes, la **copia del `plan_version`** usado y la serie diaria completa.
4. Se genera `platform_invoice` con sus líneas (`BASE`, `EXTRA_USERS`).
5. `CLOSED`. Un trigger impide modificar snapshots de días de un período cerrado y su cálculo. Las correcciones se hacen con una línea `ADJUSTMENT` o `CREDIT` en el período siguiente, con motivo y responsable.

Eliminar o desactivar usuarios **después** del cierre no altera nada: el cálculo cerrado se basa en snapshots inmutables.

## 7. Casos especiales

| Caso | Regla |
|---|---|
| Trial | Se mide igual (útil para la conversión). La factura del trial tiene importe 0 o no se emite, según el plan |
| Cambio de plan a mitad del período | **Decisión del 2026-11-10 (Fase 4.5)**:<br>• **Upgrade:** el plan nuevo (módulos, límites y precio) aplica **desde el día en que se registra**. El período en curso se corta ese día y se factura con la **base prorrateada** (días usados / días del período) más los usuarios adicionales medidos en esos días; el plan nuevo empieza ese día su propio ciclo y se cobra a su cierre.<br>• **Downgrade:** aplica desde el período siguiente.<br>Upgrade = la base mensual equivalente sube, o es igual con más usuarios incluidos |
| Altas y bajas por error en pocos minutos | Cuentan mientras estuvieron activas. Opcional por plan: `min_active_seconds` para ignorar intervalos muy cortos (por defecto 0, por validar) |
| Tenant `SUSPENDED` | La medición continúa: las membresías activas siguen siendo accesos habilitados. El tenant puede reducir usuarios (`USERS_REDUCE`) |

## 8. Pruebas (Fase 4)

- El ejemplo de la sección 3.1 da 3 y 4.
- Reemplazo en el mismo instante: no hay doble conteo.
- Día con horario de verano (zona de prueba con cambio de hora): duración de 23 y 25 horas correcta.
- Job caído 3 días: el recálculo coincide con lo que se habría calculado a tiempo.
- Intentar modificar el historial hacia atrás: rechazado por el trigger.
- Período cerrado: modificar un snapshot es rechazado. Revocar membresías después del cierre no altera la factura.
- Cuentas de servicio y staff de YEBO no aparecen nunca en el conteo.

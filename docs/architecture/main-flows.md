# Flujos principales

## F1. Login y cambio de empresa (D3)

Movido y ampliado en **[identity-and-sessions.md](identity-and-sessions.md)**: hub de cuentas, *authorization code* + PKCE, sesiones por dominio, refresh tokens con rotación y revocación.

## F2. Venta de pasaje por tramo (cualquier canal)

```mermaid
sequenceDiagram
  actor C as Cajero / cliente online
  participant API
  participant DB as PostgreSQL
  participant OB as Outbox→Worker
  C->>API: POST /bookings (Idempotency-Key) {trip, from_seq, to_seq, items[]}
  API->>DB: BEGIN
  API->>DB: liberar retenciones vencidas de los recursos pedidos
  API->>DB: INSERT resource_allocations HELD [from,to) (exclusión GIST)
  API->>DB: o bien lock pool_segment_usage + incrementar (zona libre)
  API->>DB: INSERT booking HOLD (expires_at) + booking_items (fare snapshot)
  API->>DB: COMMIT
  API-->>C: booking HOLD + total + expira en N min
  C->>API: POST /sales/{id}/payments (Idempotency-Key)
  API->>DB: BEGIN · payment CONFIRMED · allocation · cash_movement (si caja)
  API->>DB: si saldo = 0 (o pago parcial permitido por política) → booking CONFIRMED<br/>allocations CONFIRMED · tickets ISSUED (unique por booking_item)
  API->>DB: si einvoicing habilitado → fiscal_document PENDING
  API->>DB: outbox: BookingConfirmed, TicketsIssued, FiscalDocumentRequested
  API->>DB: COMMIT
  OB-->>OB: correo de boleto · emisión electrónica · PDF del boleto
```

Si la retención expira sin pago, un job pasa la reserva a `EXPIRED` y libera las asignaciones. Un pago que llega tarde (pasarela) sobre una reserva expirada intenta **re-retener**; si no hay disponibilidad, se genera un reembolso automático pendiente de aprobación.

## F3. Recepción y entrega de encomienda con PIN (regla obligatoria)

```mermaid
sequenceDiagram
  actor R as Remitente
  actor O as Operador
  participant API
  participant DB
  O->>API: POST /shipments {parties, packages[], dest, quote_id, pin?}
  API->>DB: lee tenant_settings.require_delivery_pin
  alt require_delivery_pin = true
    API->>API: valida pin ^[0-9]{4}$ (obligatorio, elegido por el remitente, nunca autogenerado)
    API->>DB: shipment_delivery_secrets (HMAC+Argon2id), require_pin_snapshot=true
  else false
    API->>API: rechaza si se envía pin (evita confusión) · require_pin_snapshot=false
  end
  API->>DB: shipment RECEIVED · packages con código · quote snapshot · sale · tracking_event
  Note over R,O: El PIN se teclea en un campo enmascarado por el remitente.<br/>no se imprime ni se notifica
  O->>API: POST /shipments/{id}/deliver {pin, receiver_doc, evidence}
  API->>DB: SELECT secret FOR UPDATE
  alt locked o intentos agotados
    API-->>O: 423 PIN_LOCKED → procedimiento de reemplazo autorizado
  else verificar
    API->>DB: delivery_pin_attempts (éxito/fallo, operador, dispositivo)
    alt correcto
      API->>DB: secret CONSUMED · delivery_confirmation · shipment DELIVERED · tracking
    else incorrecto
      API->>DB: failed_attempts++ (bloqueo al llegar al límite)
      API-->>O: 422 PIN_INVALID (sin pistas)
    end
  end
```

- La regla se evalúa con el **snapshot** guardado al recibir la encomienda: si la empresa cambia la configuración después, las encomiendas existentes conservan su regla.
- **Reemplazo de PIN:** lo solicita el remitente presentándose con identificación (o mediante un canal verificado definido por la empresa) y lo aprueba un rol con `shipments.pin.reset`. El remitente ingresa el nuevo PIN; el anterior pasa a `REPLACED`. Queda auditado con evidencia. El destinatario nunca puede cambiarlo.

## F4. Traslado entre almacenes con conciliación

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> READY: paquetes escaneados
  READY --> DISPATCHED: despacho firmado
  DISPATCHED --> IN_TRANSIT: viaje salió
  IN_TRANSIT --> RECEIVED: todo recibido
  IN_TRANSIT --> PARTIALLY_RECEIVED: faltantes/daños
  PARTIALLY_RECEIVED --> RECEIVED: faltantes llegan
  PARTIALLY_RECEIVED --> INCIDENT: pérdida confirmada
  DRAFT --> CANCELLED
  READY --> CANCELLED
```

- Los ítems son **paquetes** (`shipment_packages`), no encomiendas, porque los bultos de un mismo envío pueden viajar separados.
- Un índice único parcial impide que un paquete esté en dos traslados abiertos a la vez.
- Al recibir, cada escaneo marca `RECEIVED`, `DAMAGED` o `EXTRA`. Al cerrar, lo no escaneado queda `MISSING`. Se generan `tracking_events` y se actualiza `current_location`, que es una caché del último evento. El historial nunca se sobrescribe.
- Si el traslado va en un viaje, consume capacidad de peso y volumen de la bodega por tramo (F2, pools).

## F5. Medición de usuarios y cierre del período de facturación (D5)

```mermaid
sequenceDiagram
  participant J as Job horario (yebo_platform)
  participant DB
  J->>DB: tenants cuyo día D ya terminó en su zona horaria (+15 min) sin snapshot FINAL
  J->>DB: intervalos facturables de membership_status_history recortados al día D (zona horaria del período)
  J->>DB: peak_concurrent (barrido +1/−1) y distinct_active
  J->>DB: UPSERT usage_daily_snapshots (tenant, D) FINAL
  Note over J,DB: Fin de período en la zona horaria del período
  J->>DB: billing_period → CLOSING · verifica snapshots de todos los días
  J->>DB: usage_period_calculations (usage_metric + daily_aggregation del plan_version)
  J->>DB: platform_invoice + líneas BASE / EXTRA_USERS · billing_period CLOSED (inmutable)
```

Especificación completa (intervalos, zona horaria, SQL, ejemplo y casos especiales) en **[billing.md](../modules/billing.md)**.

## F6. Cotización y asignación de carga especial

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> QUOTED: cotización emitida (versión N)
  QUOTED --> QUOTED: nueva versión
  QUOTED --> APPROVED: cliente acepta versión vigente
  APPROVED --> CONTRACTED: venta creada (pago o crédito)
  CONTRACTED --> SCHEDULED: asignación a viaje + compatibilidad OK
  SCHEDULED --> LOADED
  LOADED --> IN_TRANSIT
  IN_TRANSIT --> UNLOADED
  UNLOADED --> DELIVERED
  REQUESTED --> CANCELLED
  QUOTED --> CANCELLED
  APPROVED --> CANCELLED
  CONTRACTED --> CANCELLED: con reembolso según política
```

## F7. Notificación vía outbox

`tx de negocio + outbox_event` → relay (polling con `FOR UPDATE SKIP LOCKED`) → BullMQ `jobId = eventId` → resolución de plantilla, preferencias y destinatarios → `notification_deliveries` (unique por clave de idempotencia) → Mailgun → estado (`SENT`, `FAILED`, `BOUNCED` vía webhook firmado).

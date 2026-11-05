# Encomiendas

> Este documento crecerá en la Fase 9. Por ahora solo contiene la especificación del **PIN de entrega**, una regla de negocio obligatoria que se cierra en el diseño (ADR-017). El flujo completo está en [main-flows.md → F3](../architecture/main-flows.md#f3-recepción-y-entrega-de-encomienda-con-pin-regla-obligatoria).

## 1. PIN de entrega

### 1.1 Reglas de negocio (confirmadas)

| Regla | Implementación |
|---|---|
| La empresa decide si exige PIN en **todas** sus encomiendas | `tenant_settings.require_delivery_pin` (global por tenant) |
| Si está desactivado, no se pide PIN | El backend **rechaza** un PIN enviado en una empresa que no lo exige, para evitar que el remitente crea que su encomienda está protegida |
| Si está activado, el remitente elige **exactamente 4 dígitos** (0–9, se aceptan ceros iniciales: `0042`, `0001`) | Se valida como **texto** con `^[0-9]{4}$` en Zod (frontend y backend). Nunca como número, porque se perderían los ceros iniciales |
| No se genera automáticamente | No existe ningún endpoint ni función que genere un PIN. Si falta el PIN y la empresa lo exige, la recepción falla con `422 DELIVERY_PIN_REQUIRED` |
| El destinatario no puede modificarlo | No hay endpoint de cambio para el destinatario. Solo existe el reemplazo autorizado (1.5) |
| Se pide al recoger y lo introduce el operador | `POST /shipments/{id}/deliver` con `pin` |
| No se entrega si la validación falla | La transición a `DELIVERED` ocurre **solo** dentro de la transacción que verificó el PIN con éxito |
| La regla vigente es la del momento de recepción | `shipments.require_pin_snapshot`. Si la empresa cambia la configuración después, las encomiendas existentes conservan su regla |

### 1.2 Almacenamiento: hash con pepper fuera de la base de datos

```
pin_hash = Argon2id( password = HMAC-SHA256( pepper[v], tenant_id ‖ shipment_id ‖ pin ),
                     salt     = 16 bytes aleatorios,
                     params   = OWASP vigente (p. ej. m=19 MiB, t=2, p=1) )
```

- **Por qué no basta un hash**: solo existen 10 000 PIN posibles. Con un volcado de la base de datos, incluso Argon2id se recorre en segundos: 10 000 intentos por fila. El **pepper** es una clave secreta que **no está en la base de datos**. Sin ella, el volcado no permite verificar ningún PIN.
- **Dónde vive el pepper**: variable de entorno inyectada en el despliegue (o un gestor de secretos o KMS cuando se adopte), solo en los procesos de la API. No está en el repositorio, en backups de la base de datos, en logs ni en el worker si no lo necesita.
- **Versionado**: `shipment_delivery_secrets.pepper_version`. Para rotar, se añade `pepper[v+1]` para las nuevas encomiendas y se conservan las versiones anteriores mientras queden encomiendas pendientes con ellas. Rehashear no es posible, porque no se conoce el PIN.
- `tenant_id ‖ shipment_id` dentro del HMAC liga el hash a esa encomienda: copiar un hash a otra fila no sirve.
- Argon2id se mantiene sobre el HMAC: si el pepper se filtrara, sigue encareciendo el ataque.
- La verificación usa `argon2.verify`, que compara en tiempo constante.

### 1.3 El PIN nunca se expone

| Canal | Medida |
|---|---|
| Respuestas de la API | El PIN y el hash no existen en ningún DTO de salida (prueba automatizada sobre el esquema OpenAPI) |
| Logs | Redacción por ruta en el logger (`req.body.pin`, `*.pin`, `*.pinHash`) + prueba que verifica la redacción |
| Auditoría | Registra "PIN establecido, verificado o reemplazado", nunca el valor |
| Notificaciones | El contexto de las plantillas no incluye campos de seguridad (lista de bloqueo en `NotificationTemplateService`) |
| Seguimiento público | La proyección pública no tiene el campo |
| Comprobante y etiqueta impresos | No se imprime. El comprobante solo indica "Entrega protegida con clave" |
| Captura en mostrador | El remitente teclea el PIN en un campo enmascarado. Idealmente en una pantalla orientada al cliente o con el terminal girado; el operador no necesita verlo |

### 1.4 Límite de intentos

- `tenant_settings.delivery_pin_max_attempts`: valor por defecto 5, rango permitido de 3 a 10.
- Cada intento queda en `delivery_pin_attempts` (operador, dispositivo, IP, resultado y hora), dentro de la misma transacción con `SELECT … FOR UPDATE` sobre el secreto. Dos operadores no pueden "gastar" intentos en paralelo sin que se contabilicen.
- Al llegar al límite, el secreto pasa a `LOCKED`. Desde entonces, `deliver` responde `423 DELIVERY_PIN_LOCKED` aunque el PIN sea correcto. Solo se desbloquea con el procedimiento de reemplazo.
- **Límite por operador**: más de N fallos por hora entre distintas encomiendas (configurable) bloquea temporalmente la acción de entrega de ese operador y alerta al supervisor. Esto mitiga que alguien interno vaya probando encomienda por encomienda.
- Probabilidad de acertar a ciegas con 5 intentos: 5 / 10 000 = 0,05 %.
- Los mensajes de error no dan pistas ("Clave incorrecta. Intentos restantes: 2").

### 1.5 Procedimiento de recuperación o reemplazo

Se usa cuando el destinatario no conoce la clave, la encomienda está `LOCKED` o el remitente la olvidó.

1. **Solo el remitente** puede establecer un PIN nuevo. Se presenta en una agencia con su documento de identidad o, si la empresa lo habilita, mediante un canal verificado que la empresa defina (p. ej., videollamada con validación del documento). El documento se compara con el *snapshot* del remitente.
2. Un usuario con permiso **`shipments.pin.reset`** aprueba. La empresa puede exigir que sea una persona **distinta** del operador que atiende (control de cuatro ojos, configurable).
3. El remitente teclea el **nuevo** PIN (4 dígitos, elegido por él). El secreto anterior pasa a `REPLACED`, se crea uno nuevo `ACTIVE` y se reinician los intentos.
4. Se registra `delivery_pin_resets`: motivo, evidencia (foto del documento si la política lo permite, conforme a la Ley 29733), quién aprobó y cuándo. Queda en la auditoría.
5. Se envía al remitente un aviso **sin la clave**: "Se registró una nueva clave de entrega para su envío X. Si no fue usted, comuníquese con…".

### 1.5b Entrega excepcional sin PIN (aprobada el 2026-11-05)

Es un procedimiento **separado** del reemplazo de PIN, para cuando el remitente no puede presentarse ni reemplazar la clave.

| Requisito | Implementación |
|---|---|
| **Deshabilitado por defecto** | `tenant_settings.exceptional_delivery_enabled = false`. Solo lo activa un administrador de la empresa, con auditoría |
| Identificación y verificación del destinatario | Documento del destinatario comparado con el *snapshot* de `shipment_parties(RECIPIENT)`. Si no coincide, la operación se rechaza |
| Motivo obligatorio | `reason_code` (catálogo) + `reason_detail` (texto mínimo de 20 caracteres) |
| Autorización de un supervisor | Permiso `shipments.deliver.exceptional.approve`. **Debe ser una persona distinta** del operador que entrega (se valida por membresía y por usuario) |
| **Segunda autorización si el valor declarado es alto** | Si `declared_value >= tenant_settings.exceptional_delivery_second_approval_threshold`, se exige un **segundo aprobador**, distinto del operador y del primer supervisor |
| Identificación del operador y de los supervisores | Registrados en `exceptional_delivery_authorizations` (membresía, usuario, fecha y hora del servidor y dispositivo) |
| Evidencia | Foto del documento y de la entrega, y firma, según la política del tenant (`exceptional_delivery_required_evidence`), conforme a la Ley 29733 |
| Registro inmutable | `exceptional_delivery_authorizations` *append-only* (sin `UPDATE` ni `DELETE` para `yebo_app`) + `audit_logs` |
| Notificación al remitente | Evento `ShipmentDeliveredExceptionally` → aviso al remitente (sin datos sensibles del destinatario más allá de los que la empresa autorice) |
| Trazabilidad | `delivery_confirmations.method = EXCEPTIONAL` + reporte de excepciones por sucursal, operador y supervisor |

Flujo: el operador solicita, el supervisor (o los supervisores) aprueba desde su propia sesión, y la entrega se confirma **en la misma transacción** que verifica que las aprobaciones requeridas existen, siguen vigentes (15 min) y no se reutilizaron. Requiere conexión, igual que la entrega con PIN.

### 1.6 Evidencia de entrega

`delivery_confirmations`: método (`PIN`, `STANDARD`, `EXCEPTIONAL`), *snapshot* de quien recibe (nombre y documento, cifrados), relación con el destinatario, fotos y firma (opcionales según la empresa), operador, sucursal y fecha y hora del servidor. Una sola confirmación por encomienda (`UNIQUE`).

### 1.7 Requiere conexión (confirmado el 2026-11-05)

La verificación necesita el pepper, que **no puede estar en los dispositivos**. Por eso, en empresas con PIN obligatorio, **la entrega requiere conexión** con el backend. La PWA offline (Fase 14) no podrá entregar encomiendas con PIN sin red. Lo indicará claramente y dejará la entrega pendiente. Es una decisión deliberada y **aprobada**: **no existe ninguna alternativa de validación offline** ni ninguna que complete la entrega sin consultar el servidor. Almacenar verificadores de PIN en el dispositivo permitiría a quien lo robe recuperar todos los PIN en segundos.

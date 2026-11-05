# Diagramas renderizados

SVG generados a partir de los bloques Mermaid de `docs/` con `scripts/render-diagrams/render.sh` (Mermaid 11.12.0 + Chrome headless; el script falla si algún diagrama no renderiza o si un SVG no es XML válido).

**Fuente de verdad: los bloques Mermaid de cada documento.** Estos SVG se regeneran; no se editan a mano.

| SVG | Documento | Sección |
|---|---|---|
| [architecture_capacity-and-inventory-01.svg](architecture_capacity-and-inventory-01.svg) | [capacity-and-inventory.md](../architecture/capacity-and-inventory.md) | 1. Tramos |
| [architecture_identity-and-sessions-01.svg](architecture_identity-and-sessions-01.svg) | [identity-and-sessions.md](../architecture/identity-and-sessions.md) | 2. Piezas |
| [architecture_identity-and-sessions-02.svg](architecture_identity-and-sessions-02.svg) | [identity-and-sessions.md](../architecture/identity-and-sessions.md) | 3. Flujo 1: primer ingreso |
| [architecture_identity-and-sessions-03.svg](architecture_identity-and-sessions-03.svg) | [identity-and-sessions.md](../architecture/identity-and-sessions.md) | 4. Flujo 2: cambio de empresa (un clic) |
| [architecture_main-flows-01.svg](architecture_main-flows-01.svg) | [main-flows.md](../architecture/main-flows.md) | F2. Venta de pasaje por tramo (cualquier canal) |
| [architecture_main-flows-02.svg](architecture_main-flows-02.svg) | [main-flows.md](../architecture/main-flows.md) | F3. Recepción y entrega de encomienda con PIN (regla obligatoria) |
| [architecture_main-flows-03.svg](architecture_main-flows-03.svg) | [main-flows.md](../architecture/main-flows.md) | F4. Traslado entre almacenes con conciliación |
| [architecture_main-flows-04.svg](architecture_main-flows-04.svg) | [main-flows.md](../architecture/main-flows.md) | F5. Medición de usuarios y cierre del período de facturación (D5) |
| [architecture_main-flows-05.svg](architecture_main-flows-05.svg) | [main-flows.md](../architecture/main-flows.md) | F6. Cotización y asignación de carga especial |
| [architecture_multitenancy-01.svg](architecture_multitenancy-01.svg) | [multitenancy.md](../architecture/multitenancy.md) | 1. Modelo de identidad (decisión D3) |
| [architecture_multitenancy-02.svg](architecture_multitenancy-02.svg) | [multitenancy.md](../architecture/multitenancy.md) | 2. Resolución del tenant |
| [architecture_system-overview-01.svg](architecture_system-overview-01.svg) | [system-overview.md](../architecture/system-overview.md) | 2. C4 — Nivel 1: contexto |
| [architecture_system-overview-02.svg](architecture_system-overview-02.svg) | [system-overview.md](../architecture/system-overview.md) | 3. C4 — Nivel 2: contenedores |
| [architecture_system-overview-03.svg](architecture_system-overview-03.svg) | [system-overview.md](../architecture/system-overview.md) | 4.1 Mapa de módulos por capa |
| [architecture_system-overview-04.svg](architecture_system-overview-04.svg) | [system-overview.md](../architecture/system-overview.md) | 5.1 Núcleo compartido frente a dominios operativos (ADR-014) |
| [database_entity-relationship-01.svg](database_entity-relationship-01.svg) | [entity-relationship.md](../database/entity-relationship.md) | 1a. Tenant y configuración |
| [database_entity-relationship-02.svg](database_entity-relationship-02.svg) | [entity-relationship.md](../database/entity-relationship.md) | 1b. Planes, suscripción, medición y facturación SaaS |
| [database_entity-relationship-03.svg](database_entity-relationship-03.svg) | [entity-relationship.md](../database/entity-relationship.md) | 1c. Soporte |
| [database_entity-relationship-04.svg](database_entity-relationship-04.svg) | [entity-relationship.md](../database/entity-relationship.md) | 2a. Usuarios, membresías y permisos |
| [database_entity-relationship-05.svg](database_entity-relationship-05.svg) | [entity-relationship.md](../database/entity-relationship.md) | 2b. Sesiones, cuentas de servicio y dispositivos |
| [database_entity-relationship-06.svg](database_entity-relationship-06.svg) | [entity-relationship.md](../database/entity-relationship.md) | 3. Organización, ubicaciones y canales |
| [database_entity-relationship-07.svg](database_entity-relationship-07.svg) | [entity-relationship.md](../database/entity-relationship.md) | 4a. Vehículos y propietarios |
| [database_entity-relationship-08.svg](database_entity-relationship-08.svg) | [entity-relationship.md](../database/entity-relationship.md) | 4b. Plantillas de distribución (layouts) |
| [database_entity-relationship-09.svg](database_entity-relationship-09.svg) | [entity-relationship.md](../database/entity-relationship.md) | 5. Rutas, viajes e inventario |
| [database_entity-relationship-10.svg](database_entity-relationship-10.svg) | [entity-relationship.md](../database/entity-relationship.md) | 6a. Clientes, ventas, canales e impuestos |
| [database_entity-relationship-11.svg](database_entity-relationship-11.svg) | [entity-relationship.md](../database/entity-relationship.md) | 6b. Pagos, devoluciones y caja |
| [database_entity-relationship-12.svg](database_entity-relationship-12.svg) | [entity-relationship.md](../database/entity-relationship.md) | 6c. Facturación electrónica |
| [database_entity-relationship-13.svg](database_entity-relationship-13.svg) | [entity-relationship.md](../database/entity-relationship.md) | 7. Pasajeros |
| [database_entity-relationship-14.svg](database_entity-relationship-14.svg) | [entity-relationship.md](../database/entity-relationship.md) | 8a. Registro, tarifa y entrega |
| [database_entity-relationship-15.svg](database_entity-relationship-15.svg) | [entity-relationship.md](../database/entity-relationship.md) | 8b. Traslados y seguimiento |
| [database_entity-relationship-16.svg](database_entity-relationship-16.svg) | [entity-relationship.md](../database/entity-relationship.md) | 9. Carga y vehículos transportados |
| [database_entity-relationship-17.svg](database_entity-relationship-17.svg) | [entity-relationship.md](../database/entity-relationship.md) | 10a. Manifiestos, white label y archivos |
| [database_entity-relationship-18.svg](database_entity-relationship-18.svg) | [entity-relationship.md](../database/entity-relationship.md) | 10b. Notificaciones, outbox y dispositivos offline |
| [database_entity-relationship-19.svg](database_entity-relationship-19.svg) | [entity-relationship.md](../database/entity-relationship.md) | 10c. Protección de datos y auditoría |
| [modules_electronic-invoicing-01.svg](modules_electronic-invoicing-01.svg) | [electronic-invoicing.md](../modules/electronic-invoicing.md) | 2. Componentes |
| [modules_electronic-invoicing-02.svg](modules_electronic-invoicing-02.svg) | [electronic-invoicing.md](../modules/electronic-invoicing.md) | 3. Ciclo de vida del comprobante |

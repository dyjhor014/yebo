/**
 * Catálogo de MÓDULOS funcionales (multitenancy §6; data-dictionary `modules`). FUENTE ÚNICA en código: la migración
 * `20261110170000_fase4_2_commercial_catalog` siembra exactamente estos valores y una prueba compara la base con este
 * archivo. Un módulo nuevo = migración nueva. La gestión de accesos (permisos `members.*`, `roles.*`) es núcleo: no es
 * un módulo contratable.
 */
export const MODULE_CATALOG = {
  PASSENGERS: { name: 'Pasajeros', description: 'Venta de pasajes, embarque y manifiestos' },
  PARCELS: { name: 'Encomiendas', description: 'Registro, traslado y entrega de encomiendas' },
  CARGO: { name: 'Carga', description: 'Cotización, contratación y entrega de carga' },
  VEHICLE_TRANSPORT: {
    name: 'Transporte de vehículos',
    description: 'Vehículos y maquinaria como carga especial',
  },
  EINVOICING: {
    name: 'Facturación electrónica',
    description: 'Emisión de comprobantes mediante la API externa',
  },
  AGENCIES: { name: 'Agencias externas', description: 'Agencias y canales con comisiones (D7)' },
  OWNER_SETTLEMENTS: {
    name: 'Liquidación a propietarios',
    description: 'Unidades de terceros y liquidaciones (D6)',
  },
  WHITE_LABEL: { name: 'Marca propia', description: 'Portal público con la identidad de la empresa' },
  OFFLINE_OPS: {
    name: 'Operación sin conexión',
    description: 'Dispositivos de embarque y almacén sin conexión',
  },
} as const satisfies Record<string, { name: string; description: string }>;

export type ModuleCode = keyof typeof MODULE_CATALOG;
export const MODULE_CODES = Object.keys(MODULE_CATALOG) as ModuleCode[];

/**
 * Módulos de SERVICIO (multitenancy §6): un módulo del plan solo es efectivo si la empresa opera ese servicio en
 * alguna modalidad (`tenant_services` habilitado). Los demás módulos no dependen de los servicios.
 */
export const SERVICE_OF_MODULE: Readonly<
  Partial<Record<ModuleCode, 'PASSENGER' | 'PARCEL' | 'CARGO' | 'VEHICLE_TRANSPORT'>>
> = {
  PASSENGERS: 'PASSENGER',
  PARCELS: 'PARCEL',
  CARGO: 'CARGO',
  VEHICLE_TRANSPORT: 'VEHICLE_TRANSPORT',
};

/** Se intentó acceder a un modelo de tenant sin contexto de tenant. Nunca se devuelve "todo". */
export class MissingTenantContextError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
  ) {
    super(`Operación ${model}.${operation} sin contexto de tenant`);
    this.name = 'MissingTenantContextError';
  }
}

/** La operación intentó leer o escribir con un tenant distinto al del contexto. */
export class TenantMismatchError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
  ) {
    super(`Operación ${model}.${operation} con un tenant distinto al del contexto`);
    this.name = 'TenantMismatchError';
  }
}

/** Operación de Prisma no contemplada por el filtro de tenant: se rechaza (falla segura). */
export class UnsupportedTenantOperationError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
  ) {
    super(`Operación ${model}.${operation} no soportada en modelos de tenant`);
    this.name = 'UnsupportedTenantOperationError';
  }
}

export class InvalidTenantIdError extends Error {
  constructor() {
    super('El identificador de tenant del contexto no es un UUID válido');
    this.name = 'InvalidTenantIdError';
  }
}

/**
 * Se intentó abrir una transacción interactiva desde el cliente por operación del tenant.
 * Ese cliente envuelve cada operación en su propia transacción por lotes (sesión RLS), así que
 * dentro de `$transaction` las operaciones quedarían fuera de la transacción del llamador.
 */
export class TenantTransactionMisuseError extends Error {
  constructor() {
    super(
      'Usa TenantDbService.transaction() para transacciones de tenant; client.$transaction no está permitido',
    );
    this.name = 'TenantTransactionMisuseError';
  }
}

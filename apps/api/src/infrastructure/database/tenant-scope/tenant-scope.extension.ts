import { Prisma } from '@prisma/client/extension';
import { applyTenantScope } from './apply-tenant-scope';
import {
  InvalidTenantIdError,
  MissingTenantContextError,
  TenantTransactionMisuseError,
} from './tenant-scope.errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantScopeOptions {
  /** Modelos Prisma con columna tenant_id (nombres de modelo, p. ej. "Shipment"). */
  tenantScopedModels: ReadonlySet<string>;
  /** Devuelve el tenant del contexto del request (CLS) o undefined si no hay contexto. */
  resolveTenantId: () => string | undefined;
}

function requireTenantId(options: TenantScopeOptions, model: string, operation: string): string {
  const tenantId = options.resolveTenantId();
  if (!tenantId) throw new MissingTenantContextError(model, operation);
  if (!UUID.test(tenantId)) throw new InvalidTenantIdError();
  return tenantId;
}

/**
 * Barrera 1 (aplicación): inyecta tenant_id en filtros y datos.
 * IMPORTANTE: el hook NO es async. Devuelve la PrismaPromise perezosa de `query`, lo que permite
 * que la extensión de sesión la incluya en una transacción por lotes.
 */
export function tenantFilterExtension(options: TenantScopeOptions) {
  return Prisma.defineExtension({
    name: 'yebo-tenant-filter',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!options.tenantScopedModels.has(model)) return query(args);
          const tenantId = requireTenantId(options, model, operation);
          return query(applyTenantScope(model, operation, args, tenantId) as typeof args);
        },
      },
    },
  });
}

/**
 * Subconjunto del cliente que necesita la extensión de sesión. El cliente genérico que entrega
 * `defineExtension` no tipa `$executeRaw`, aunque existe en tiempo de ejecución en todo PrismaClient.
 */
interface RawBatchClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<number>;
  $transaction(queries: PromiseLike<unknown>[]): Promise<unknown[]>;
}

/**
 * Barrera 2 (base de datos): ejecuta cada operación de tenant en una transacción por lotes
 * precedida de set_config('app.tenant_id', …, true). El tercer parámetro `true` hace el valor
 * LOCAL A LA TRANSACCIÓN: no se filtra a otros requests que reutilicen la conexión del pool.
 * Las políticas RLS usan current_setting('app.tenant_id', true).
 *
 * No funciona dentro de transacciones interactivas: para ellas se usa `TenantDbService.transaction()`,
 * que fija el tenant con `setTransactionTenant` al inicio. Por eso el cliente que lleva esta extensión
 * se expone sin `$transaction` (`withoutInteractiveTransactions`).
 */
export function tenantSessionExtension(options: TenantScopeOptions) {
  return Prisma.defineExtension((client) => {
    const raw = client as unknown as RawBatchClient;
    return client.$extends({
      name: 'yebo-tenant-session',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!options.tenantScopedModels.has(model)) return query(args);
            const tenantId = requireTenantId(options, model, operation);
            const [, result] = await raw.$transaction([
              raw.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
              query(args),
            ]);
            return result;
          },
        },
      },
    });
  });
}

/** Fija el tenant de la transacción interactiva en curso. Debe ser la primera sentencia. */
export async function setTransactionTenant(
  tx: { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => PromiseLike<number> },
  options: TenantScopeOptions,
): Promise<string> {
  const tenantId = requireTenantId(options, '$transaction', 'interactive');
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  return tenantId;
}

/**
 * Devuelve el cliente por operación sin `$transaction`, en los tipos y en tiempo de ejecución.
 * Una transacción interactiva abierta desde él ejecutaría cada operación de tenant en otra
 * transacción por lotes (la de la extensión de sesión), fuera de la atomicidad del llamador.
 */
export function withoutInteractiveTransactions<T extends object>(client: T): Omit<T, '$transaction'> {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return () => {
          throw new TenantTransactionMisuseError();
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

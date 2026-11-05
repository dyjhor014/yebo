import 'server-only';
import { HealthResponseSchema, type HealthResponse } from '@yebo/contracts';

export type ApiStatus = { reachable: true; health: HealthResponse } | { reachable: false; reason: string };

/**
 * Consulta el estado de la API desde el servidor (nunca desde el navegador).
 * La respuesta se valida con el contrato compartido de @yebo/contracts.
 */
export async function getApiStatus(): Promise<ApiStatus> {
  const baseUrl = process.env.API_INTERNAL_URL;
  if (!baseUrl) return { reachable: false, reason: 'API_INTERNAL_URL no está configurada' };
  try {
    const res = await fetch(`${baseUrl}/api/v1/health/ready`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    const parsed = HealthResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { reachable: false, reason: 'Respuesta de la API con formato inesperado' };
    return { reachable: true, health: parsed.data };
  } catch (error) {
    return {
      reachable: false,
      reason:
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Tiempo de espera agotado'
          : 'API no disponible',
    };
  }
}

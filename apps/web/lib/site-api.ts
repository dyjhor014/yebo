'use client';

import {
  SiteAssetSchema,
  SiteEditorResponseSchema,
  SiteVersionsResponseSchema,
  type SiteAsset,
  type SiteAssetKind,
  type SiteConfig,
  type SiteEditorResponse,
  type SiteVersionsResponse,
} from '@yebo/contracts';
import { AuthRequestError, apiFetch, readCsrfCookie } from './auth-client';

/** API «Mi sitio» de la empresa del host (Fase 5.1–5.4), mismo origen y con el token CSRF. */
const write = (path: string, init: RequestInit = {}) =>
  apiFetch(path, { ...init, method: init.method ?? 'POST', csrf: readCsrfCookie() });

export async function getEditor(): Promise<SiteEditorResponse> {
  return SiteEditorResponseSchema.parse(await (await apiFetch('/api/v1/site')).json());
}

export async function saveDraft(config: SiteConfig): Promise<SiteEditorResponse> {
  const res = await write('/api/v1/site/draft', { method: 'PUT', body: JSON.stringify({ config }) });
  return SiteEditorResponseSchema.parse(await res.json());
}

export async function publishDraft(): Promise<SiteEditorResponse> {
  return SiteEditorResponseSchema.parse(await (await write('/api/v1/site/publish')).json());
}

export async function getVersions(): Promise<SiteVersionsResponse> {
  return SiteVersionsResponseSchema.parse(await (await apiFetch('/api/v1/site/versions')).json());
}

export async function restoreVersion(version: number): Promise<SiteEditorResponse> {
  const res = await write(`/api/v1/site/versions/${version}/restore`);
  return SiteEditorResponseSchema.parse(await res.json());
}

export const ACCEPTED_IMAGES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export async function uploadAsset(kind: SiteAssetKind, file: File): Promise<SiteAsset> {
  if (!(ACCEPTED_IMAGES as readonly string[]).includes(file.type)) {
    throw new AuthRequestError(400, 'VALIDATION_FAILED', 'Usa una imagen PNG, JPEG o WebP.');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new AuthRequestError(413, 'PAYLOAD_TOO_LARGE', 'La imagen pesa más de 5 MB.');
  }
  const res = await write(`/api/v1/site/assets?kind=${kind}`, {
    body: file,
    headers: { 'Content-Type': file.type },
  });
  return SiteAssetSchema.parse(await res.json());
}

/** Retira un archivo que el borrador ya no usa. 404/409 (ya retirado o aún publicado) no son errores aquí. */
export async function retireAsset(id: string): Promise<void> {
  await write(`/api/v1/site/assets/${id}`, { method: 'DELETE' }).catch((e: unknown) => {
    if (e instanceof AuthRequestError && (e.status === 404 || e.status === 409)) return;
    throw e;
  });
}

/** Mensaje para la persona: el de la API cuando lo hay; si no, uno genérico. */
export function errorMessage(e: unknown): string {
  if (e instanceof AuthRequestError) return e.message;
  return 'No se pudo completar la operación. Revisa tu conexión e inténtalo de nuevo.';
}

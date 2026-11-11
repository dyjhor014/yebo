import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Token del enlace de invitación (Fase 4.3b): `<id del tenant>.<secreto>` (256 bits en base64url). El id del tenant NO
 * es secreto: permite al hub fijar el contexto del tenant (RLS) antes de buscar el hash. En la base solo se guarda el
 * SHA-256 del secreto. El enlace lleva el token en el fragmento (`#`), que no llega al servidor ni al Referer.
 */
export const INVITATION_TTL_MS = 72 * 3_600_000;

const UUID = z.uuid();
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export function newInvitationToken(tenantId: string): { token: string; hash: Buffer } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${tenantId}.${secret}`, hash: hashSecret(secret) };
}

/** `null` si el formato no es válido (se trata igual que un token inexistente). */
export function parseInvitationToken(token: unknown): { tenantId: string; hash: Buffer } | null {
  if (typeof token !== 'string' || token.length > 120) return null;
  const [tenantId, secret, ...rest] = token.split('.');
  if (rest.length > 0 || !tenantId || !secret || !UUID.safeParse(tenantId).success || !SECRET.test(secret)) {
    return null;
  }
  return { tenantId: tenantId.toLowerCase(), hash: hashSecret(secret) };
}

export function invitationLink(hubHost: string, token: string): string {
  return `https://${hubHost}/invitacion#${token}`;
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

import type { NextConfig } from 'next';

/**
 * Pantallas de autenticación (identity-and-sessions §5): nunca dentro de un marco, sin Referer (el código de
 * autorización viaja en la URL del callback) y sin caché.
 */
const AUTH_HEADERS = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cache-Control', value: 'no-store' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Componentes de la 3.2b compartidos con apps/platform (Fase 4.7): se publican como fuente TypeScript.
  transpilePackages: ['@yebo/ui'],
  async headers() {
    return ['/login', '/sin-acceso', '/salir', '/auth/callback', '/panel', '/panel/:path*'].map((source) => ({
      source,
      headers: AUTH_HEADERS,
    }));
  },
};

export default config;

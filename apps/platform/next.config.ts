import type { NextConfig } from 'next';

/**
 * Panel del staff (Fase 4.7). Todo el panel es sensible: nunca dentro de un marco, sin Referer y sin caché.
 * En producción Nginx enruta admin.yebo.pe/api a la API (mismo origen). En desarrollo, si API_INTERNAL_URL está
 * definida, Next reenvía /api a la API con X-Forwarded-Host (la API confía en el proxy local, TRUST_PROXY).
 */
const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cache-Control', value: 'no-store' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  transpilePackages: ['@yebo/ui'],
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    const api = process.env.API_INTERNAL_URL;
    return api ? [{ source: '/api/:path*', destination: `${api}/api/:path*` }] : [];
  },
};

export default config;

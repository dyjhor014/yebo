// Proxy de los E2E (como Nginx en producción y en `pnpm https:up`): mismo origen para cada app y la API.
//   /api/* → API ; host del panel (admin.*) → apps/platform ; cualquier otro host (hub y empresas) → apps/web.
//   Conserva Host y añade X-Forwarded-*; la API confía en loopback.
// Uso: node proxy.mjs <puerto> <puerto de la API> <puerto del panel> <puerto de la web>
import http from 'node:http';
import process from 'node:process';

const [listen, api, platform, web] = process.argv.slice(2).map(Number);
const server = http.createServer((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const target = req.url?.startsWith('/api/') ? api : host.startsWith('admin.') ? platform : web;
  const headers = {
    ...req.headers,
    'x-forwarded-host': req.headers.host ?? '',
    'x-forwarded-proto': 'http',
    'x-forwarded-for': req.socket.remoteAddress ?? '',
  };
  const upstream = http.request(
    { host: '127.0.0.1', port: target, method: req.method, path: req.url, headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('proxy E2E: destino no disponible');
  });
  req.pipe(upstream);
});
server.listen(listen, '127.0.0.1');
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.close(() => process.exit(0)));

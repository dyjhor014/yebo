// Fase 7.6: copia el worker de MapLibre a public/ (mismo origen), con la versión en el nombre para la caché.
// El worker no se empaqueta con Next: MapLibre lo carga por URL (setWorkerUrl). No va en git (.gitignore).
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('maplibre-gl/package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vendor');
mkdirSync(out, { recursive: true });
copyFileSync(
  join(dirname(pkgPath), 'dist', 'maplibre-gl-worker.mjs'),
  join(out, `maplibre-gl-worker-${version}.mjs`),
);

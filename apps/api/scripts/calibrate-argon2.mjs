#!/usr/bin/env node
// Calibra Argon2id en la máquina donde se ejecuta (security.md §1: "recalibrar en la Fase 3").
// Mide el tiempo de un hash para varias combinaciones que cumplen el mínimo de OWASP
// (m ≥ 19 MiB, t ≥ 2, p = 1) y recomienda la más costosa por debajo del objetivo.
// Uso: node scripts/calibrate-argon2.mjs [objetivo_ms=250] [repeticiones=5]
// Debe ejecutarse en el hardware de PRODUCCIÓN: el resultado de un portátil de desarrollo no vale.
import { argon2Sync, randomBytes } from 'node:crypto';
import { availableParallelism, cpus, totalmem } from 'node:os';

const targetMs = Number(process.argv[2] ?? 250);
const runs = Number(process.argv[3] ?? 5);
const candidates = [
  { memory: 19456, passes: 2 },
  { memory: 19456, passes: 3 },
  { memory: 47104, passes: 1 }, // OWASP alternativo (46 MiB, t=1): no cumple t ≥ 2 del esquema; solo referencia
  { memory: 65536, passes: 2 },
  { memory: 65536, passes: 3 },
  { memory: 131072, passes: 2 },
  { memory: 262144, passes: 2 },
];

function measure({ memory, passes }) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    argon2Sync('argon2id', {
      message: Buffer.from('calibracion-de-argon2id'),
      nonce: randomBytes(16),
      parallelism: 1,
      tagLength: 32,
      memory,
      passes,
    });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

console.log(
  `CPU: ${cpus()[0]?.model ?? '?'} · núcleos: ${availableParallelism()} · RAM: ${(totalmem() / 2 ** 30).toFixed(1)} GiB`,
);
console.log(
  `Node ${process.version} · objetivo ≤ ${targetMs} ms por hash · mediana de ${runs} ejecuciones\n`,
);
console.log('memoria (KiB)  t   mediana (ms)  ¿cumple el esquema?  ¿≤ objetivo?');
let best = null;
for (const c of candidates) {
  const ms = measure(c);
  const valid = c.memory >= 19456 && c.passes >= 2;
  const ok = ms <= targetMs;
  if (valid && ok && (!best || c.memory * c.passes > best.memory * best.passes)) best = { ...c, ms };
  console.log(
    `${String(c.memory).padStart(13)}  ${c.passes}   ${ms.toFixed(1).padStart(12)}  ${(valid ? 'sí' : 'no').padStart(19)}  ${ok ? 'sí' : 'no'}`,
  );
}
console.log(
  best
    ? `\nRecomendado: ARGON2_MEMORY_KIB=${best.memory} ARGON2_ITERATIONS=${best.passes} ARGON2_PARALLELISM=1 (${best.ms.toFixed(1)} ms)`
    : '\nNinguna combinación válida cumple el objetivo: se mantiene el mínimo de OWASP (19456, 2, 1).',
);
console.log('Recuerda: cada login concurrente reserva esa memoria. Revisa el pico de logins simultáneos.');

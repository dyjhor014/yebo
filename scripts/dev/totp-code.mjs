#!/usr/bin/env node
// SOLO PRUEBAS: calcula el código de 6 dígitos (TOTP, RFC 6238: SHA-1, 30 s) de una clave de la verificación en
// dos pasos del panel, para cuentas de prueba sin app de autenticación en el móvil. Sin dependencias.
// Uso: node scripts/dev/totp-code.mjs            (pide la clave sin mostrarla)
//      node scripts/dev/totp-code.mjs --watch    (muestra el código vigente cada 30 s; Ctrl+C para salir)
// No usar con cuentas reales: quien tenga la clave genera los códigos.
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  for (const c of clean) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error(`Carácter no válido en la clave: «${c}»`);
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

async function askHidden(question) {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  return new Promise((done) => {
    rl.question(question, (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write('\n');
      done(answer);
    });
    muted = true;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = base32Decode(
    process.env.YEBO_TOTP_KEY ?? (await askHidden('Clave de la verificación en dos pasos: ')),
  );
  const show = () => {
    const left = 30 - (Math.floor(Date.now() / 1000) % 30);
    process.stdout.write(`Código: ${totp(secret)}  (válido ${left} s más)\n`);
    return left;
  };
  if (process.argv.includes('--watch')) {
    const loop = () => setTimeout(loop, show() * 1000 + 50);
    loop();
  } else show();
}

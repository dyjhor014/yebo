import { test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Captura de la pantalla renderizada, con sus estilos incrustados, en tests/e2e/capturas/<proyecto>-<nombre>.html
 * (ignorado por git), para el detector de Impeccable: necesita la página ya renderizada para las reglas de
 * contraste, tamaño de texto y maquetación, y los paneles exigen sesión. Solo con YEBO_E2E_CAPTURAS=1.
 */
export const CAPTURAS = Boolean(process.env.YEBO_E2E_CAPTURAS);

export async function capture(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  const html = await page.evaluate(() => {
    const css = [...document.styleSheets]
      .map((s) => {
        try {
          return [...s.cssRules].map((r) => r.cssText).join('\n');
        } catch {
          return '';
        }
      })
      .join('\n');
    const doc = document.documentElement.cloneNode(true) as HTMLElement;
    doc.querySelectorAll('script, link[rel="stylesheet"], link[rel="preload"]').forEach((n) => n.remove());
    const style = document.createElement('style');
    style.textContent = css;
    doc.querySelector('head')?.appendChild(style);
    return `<!doctype html>\n${doc.outerHTML}`;
  });
  mkdirSync('capturas', { recursive: true });
  writeFileSync(`capturas/${test.info().project.name}-${name}.html`, html);
  // Y cómo se ve en la ventana, para la revisión visual (la página completa pinta arriba los elementos fijos).
  await page.screenshot({ path: `capturas/${test.info().project.name}-${name}.png` });
}

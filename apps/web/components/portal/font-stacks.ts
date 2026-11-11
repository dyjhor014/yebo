import type { SiteFont } from '@yebo/contracts';

/*
 * Pilas tipográficas del tema, sin next/font (que solo funciona al compilar con Next): así el cálculo del tema
 * (theme.ts) también se prueba con Jest, como parte del criterio de la Fase 5 en la CI.
 */

/** Pila tipográfica de cada fuente del tema, con su alternativa genérica. */
export const FONT_STACK: Record<SiteFont, string> = {
  inter: 'var(--font-inter), ui-sans-serif, system-ui, sans-serif',
  manrope: 'var(--font-manrope), ui-sans-serif, system-ui, sans-serif',
  'nunito-sans': 'var(--font-nunito-sans), ui-sans-serif, system-ui, sans-serif',
  montserrat: 'var(--font-montserrat), ui-sans-serif, system-ui, sans-serif',
  'source-serif': 'var(--font-source-serif), ui-serif, Georgia, serif',
  lora: 'var(--font-lora), ui-serif, Georgia, serif',
};

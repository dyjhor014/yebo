import { Lora, Montserrat, Nunito_Sans, Source_Serif_4 } from 'next/font/google';
import type { SiteFont } from '@yebo/contracts';

/*
 * Fuentes de la lista blanca del tema (F5-Q3). next/font las descarga al compilar y las sirve desde el propio
 * dominio (el navegador no contacta con Google). Inter y Manrope ya las carga el layout raíz (marca YEBO).
 */
const nunitoSans = Nunito_Sans({ subsets: ['latin'], variable: '--font-nunito-sans', display: 'swap' });
const sourceSerif = Source_Serif_4({ subsets: ['latin'], variable: '--font-source-serif', display: 'swap' });
const montserrat = Montserrat({ subsets: ['latin'], variable: '--font-montserrat', display: 'swap' });
const lora = Lora({ subsets: ['latin'], variable: '--font-lora', display: 'swap' });

/** Clases que declaran las variables de las fuentes extra (se aplican en el contenedor del portal). */
export const PORTAL_FONT_VARIABLES = [nunitoSans, sourceSerif, montserrat, lora]
  .map((f) => f.variable)
  .join(' ');

/** Pila tipográfica de cada fuente del tema, con su alternativa genérica. */
export const FONT_STACK: Record<SiteFont, string> = {
  inter: 'var(--font-inter), ui-sans-serif, system-ui, sans-serif',
  manrope: 'var(--font-manrope), ui-sans-serif, system-ui, sans-serif',
  'nunito-sans': 'var(--font-nunito-sans), ui-sans-serif, system-ui, sans-serif',
  montserrat: 'var(--font-montserrat), ui-sans-serif, system-ui, sans-serif',
  'source-serif': 'var(--font-source-serif), ui-serif, Georgia, serif',
  lora: 'var(--font-lora), ui-serif, Georgia, serif',
};

import { Lora, Montserrat, Nunito_Sans, Source_Serif_4 } from 'next/font/google';

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

export { FONT_STACK } from './font-stacks';

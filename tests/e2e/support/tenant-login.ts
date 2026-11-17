import type { Page } from '@playwright/test';
import { hostUrl } from './env';

/**
 * La API redirige entre la empresa y el hub siempre con https:// (producción) y los E2E sirven por http en el
 * proxy local: en las rutas de autenticación, la redirección a https:// se lleva al mismo host y ruta del proxy.
 */
export async function followHttpRedirects(page: Page) {
  await page.route(/\/api\/v1\/(auth|hub)\//, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers()['location'];
    if (!location?.startsWith('https://')) return route.fulfill({ response });
    // Una página que navega (no otra redirección: los saltos de una redirección no pasan por page.route).
    const url = new URL(location);
    const target = hostUrl(url.hostname, `${url.pathname}${url.search}${url.hash}`);
    const headers: Record<string, string> = { ...response.headers(), 'content-type': 'text/html' };
    delete headers['location'];
    delete headers['content-security-policy']; // la de la API bloquearía este script de prueba
    return route.fulfill({
      status: 200,
      headers,
      body: `<script>location.replace(${JSON.stringify(target)})</script>`,
    });
  });
}

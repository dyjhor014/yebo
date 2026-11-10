import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** axe con las reglas de WCAG 2.1 A y AA. Falla con la lista legible de lo que incumple. */
export async function expectAccessible(page: Page, label: string, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  const report = violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1] ?? ''}`).join('\n')}`,
  );
  expect(report, `axe en «${label}»`).toEqual([]);
}

/** Sin desplazamiento horizontal de la página (maqueta: 16 px de margen y nada fuera de la pantalla). */
export async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `desplazamiento horizontal en «${label}»`).toBeLessThanOrEqual(0);
}

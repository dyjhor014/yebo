import { passwordProblem } from './password-policy';

const ctx = { email: 'maria.quispe@transportes.pe', fullName: 'María Quispe Huamán' };

describe('política de contraseñas (Fase 4.3b)', () => {
  it('longitud entre 10 y 128', () => {
    expect(passwordProblem('Ab3$fg7hj', ctx)).toMatch(/al menos 10/);
    expect(passwordProblem('x'.repeat(129), ctx)).toMatch(/como mucho 128/);
    expect(passwordProblem('ríos-claros-del-ucayali', ctx)).toBeNull();
  });

  it('rechaza las filtradas de la lista local, sin distinguir mayúsculas', () => {
    expect(passwordProblem('1234567890', ctx)).toMatch(/filtraciones/);
    expect(passwordProblem('QWERTYUIOP', ctx)).toMatch(/filtraciones/);
  });

  it('rechaza el correo, su parte local, las palabras del nombre (sin tildes) y «yebo»', () => {
    expect(passwordProblem('maria.quispe-2026', ctx)).toMatch(/correo/);
    expect(passwordProblem('soy-huaman-de-lima', ctx)).toMatch(/nombre/);
    expect(passwordProblem('Clave-de-YEBO-larga', ctx)).toMatch(/yebo/);
    expect(passwordProblem('rio-amazonas-2026', ctx)).toBeNull();
  });
});

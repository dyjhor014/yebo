import { invitationLink, newInvitationToken, parseInvitationToken } from './invitation-token';

const TENANT = '0190f0a0-0000-7000-8000-00000000a043';

describe('token de invitación', () => {
  it('ida y vuelta: el hash coincide y el tenant viaja en claro', () => {
    const { token, hash } = newInvitationToken(TENANT);
    expect(parseInvitationToken(token)).toEqual({ tenantId: TENANT, hash });
    expect(token.startsWith(`${TENANT}.`)).toBe(true);
    expect(hash).toHaveLength(32);
  });

  it('dos tokens nunca coinciden', () => {
    expect(newInvitationToken(TENANT).token).not.toBe(newInvitationToken(TENANT).token);
  });

  it('formatos inválidos → null', () => {
    const { token } = newInvitationToken(TENANT);
    for (const bad of [
      undefined,
      42,
      '',
      'x.y',
      `${TENANT}`,
      `no-uuid.${token.split('.')[1]}`,
      `${token}.extra`,
      `${token}=`,
      'a'.repeat(200),
    ]) {
      expect(parseInvitationToken(bad)).toBeNull();
    }
  });

  it('el enlace lleva el token en el fragmento', () => {
    expect(invitationLink('cuentas.yebo.pe', 'abc')).toBe('https://cuentas.yebo.pe/invitacion#abc');
  });
});

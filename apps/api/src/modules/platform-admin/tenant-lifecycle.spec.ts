import type { TenantStatus } from '../../generated/prisma/client';
import {
  MANUAL_TRANSITIONS,
  SUBSCRIPTION_STATUS_FOR,
  dueTransition,
  isManualTransitionAllowed,
} from './tenant-lifecycle';

const DAY = 86_400_000;
const T0 = new Date('2026-11-10T05:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

describe('máquina de estados del tenant (multitenancy §5.2)', () => {
  it('CANCELLED es final y ningún estado transita a sí mismo ni a TRIAL', () => {
    expect(MANUAL_TRANSITIONS.CANCELLED).toEqual([]);
    for (const [from, tos] of Object.entries(MANUAL_TRANSITIONS) as [TenantStatus, TenantStatus[]][]) {
      expect(tos).not.toContain(from);
      expect(tos).not.toContain('TRIAL');
    }
  });

  it('las reactivaciones aprobadas: SUSPENDED / EXPIRED / PAST_DUE → ACTIVE', () => {
    expect(isManualTransitionAllowed('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(isManualTransitionAllowed('EXPIRED', 'ACTIVE')).toBe(true);
    expect(isManualTransitionAllowed('PAST_DUE', 'ACTIVE')).toBe(true);
    expect(isManualTransitionAllowed('ACTIVE', 'SUSPENDED')).toBe(false);
    expect(isManualTransitionAllowed('CANCELLED', 'ACTIVE')).toBe(false);
  });

  it('cada estado tiene su estado de suscripción', () => {
    expect(SUBSCRIPTION_STATUS_FOR.TRIAL).toBe('TRIALING');
    expect(SUBSCRIPTION_STATUS_FOR.SUSPENDED).toBe('SUSPENDED');
  });

  describe('transiciones automáticas', () => {
    const base = { statusChangedAt: T0, trialEndsAt: null, pastDueGraceDays: null };

    it('TRIAL → EXPIRED exactamente al llegar trial_ends_at; sin fecha no vence solo', () => {
      const trial = { ...base, status: 'TRIAL' as const, trialEndsAt: at(14) };
      expect(dueTransition(trial, new Date(at(14).getTime() - 1))).toBeNull();
      expect(dueTransition(trial, at(14))).toBe('EXPIRED');
      expect(dueTransition({ ...base, status: 'TRIAL' }, at(400))).toBeNull();
    });

    it('PAST_DUE → SUSPENDED a los 7 días por defecto, o a los del plan', () => {
      const pastDue = { ...base, status: 'PAST_DUE' as const };
      expect(dueTransition(pastDue, new Date(at(7).getTime() - 1))).toBeNull();
      expect(dueTransition(pastDue, at(7))).toBe('SUSPENDED');
      expect(dueTransition({ ...pastDue, pastDueGraceDays: 3 }, at(3))).toBe('SUSPENDED');
      expect(dueTransition({ ...pastDue, pastDueGraceDays: 0 }, T0)).toBe('SUSPENDED');
    });

    it('los demás estados nunca cambian solos', () => {
      for (const status of ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'] as const) {
        expect(dueTransition({ ...base, status, trialEndsAt: at(-1) }, at(1000))).toBeNull();
      }
    });
  });
});

import { ConflictException } from '@nestjs/common';
import { assertTransition, CASE_STAGES, canTransition, stagesLeadingTo, TERMINAL_STAGES, TRANSITIONS } from './state-machine';

describe('case state machine (18-1)', () => {
  it('walks the happy path', () => {
    const path = ['draft', 'sent', 'accepted', 'in_transit', 'arrived', 'handed_over', 'profile_created', 'closed'] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });

  it('never gates care on payment (NHA 2014 §20)', () => {
    expect(canTransition('accepted', 'in_transit')).toBe(true);
    expect(canTransition('payment_pending', 'in_transit')).toBe(true);
    // Nothing requires passing through payment_pending to reach care.
    expect(stagesLeadingTo('in_transit')).toEqual(expect.arrayContaining(['accepted', 'payment_pending']));
  });

  it('lets a facility hand back an acceptance before arrival (4-9) but not after', () => {
    expect(canTransition('accepted', 'sent')).toBe(true);
    expect(canTransition('in_transit', 'sent')).toBe(false);
    expect(canTransition('arrived', 'sent')).toBe(false);
  });

  it('allows a re-send from declined, expired and diverted', () => {
    for (const s of ['declined', 'expired', 'diverted'] as const) expect(canTransition(s, 'sent')).toBe(true);
  });

  it('has no way out of a terminal stage', () => {
    for (const s of TERMINAL_STAGES) expect(TRANSITIONS[s]).toEqual([]);
  });

  it('defines every stage and only targets known stages', () => {
    for (const s of CASE_STAGES) {
      expect(TRANSITIONS[s]).toBeDefined();
      for (const t of TRANSITIONS[s]) expect(CASE_STAGES).toContain(t);
    }
  });

  it('assertTransition throws a 409 for an illegal move', () => {
    expect(() => assertTransition('closed', 'sent')).toThrow(ConflictException);
    expect(() => assertTransition('sent', 'accepted')).not.toThrow();
  });
});

import { ConflictException } from '@nestjs/common';

export const CASE_STAGES = [
  'draft',
  'sent',
  'accepted',
  'payment_pending',
  'in_transit',
  'arrived',
  'handed_over',
  'profile_created',
  'closed',
  'declined',
  'expired',
  'cancelled',
  'diverted',
  'disputed',
] as const;
export type CaseStage = (typeof CASE_STAGES)[number];

/**
 * Case state machine (18-1).
 *
 * Payment never gates care (NHA 2014 §20, 19-6): `accepted → in_transit` is
 * always allowed, and `payment_pending` can move to `in_transit` without a
 * payment ever arriving. Payment status lives on `case.payment`, outside this
 * machine.
 *
 * `accepted → sent` is the receiving facility cancelling before arrival (4-9):
 * the case goes straight back out. `declined`/`expired`/`diverted → sent` is a
 * re-send.
 */
export const TRANSITIONS: Readonly<Record<CaseStage, readonly CaseStage[]>> = {
  draft: ['sent', 'cancelled'],
  sent: ['accepted', 'declined', 'expired', 'cancelled'],
  accepted: ['payment_pending', 'in_transit', 'sent', 'diverted', 'cancelled'],
  payment_pending: ['in_transit', 'sent', 'diverted', 'cancelled'],
  in_transit: ['arrived', 'diverted', 'cancelled'],
  arrived: ['handed_over', 'disputed'],
  handed_over: ['profile_created', 'closed', 'disputed'],
  profile_created: ['closed', 'disputed'],
  closed: [],
  declined: ['sent', 'cancelled'],
  expired: ['sent', 'cancelled'],
  cancelled: [],
  diverted: ['sent'],
  disputed: ['closed'],
};

export const TERMINAL_STAGES: ReadonlySet<CaseStage> = new Set(['closed', 'cancelled']);

/** Stages in which a bed is held for the patient. */
export const BED_HOLD_STAGES: readonly CaseStage[] = ['accepted', 'payment_pending', 'in_transit'];

export function canTransition(from: CaseStage, to: CaseStage): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Stages from which `to` is reachable — the `stage: { $in }` filter for an atomic transition. */
export function stagesLeadingTo(to: CaseStage): CaseStage[] {
  return CASE_STAGES.filter((from) => canTransition(from, to));
}

export function assertTransition(from: CaseStage, to: CaseStage): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`A case that is ${from.replace('_', ' ')} cannot move to ${to.replace('_', ' ')}.`);
  }
}

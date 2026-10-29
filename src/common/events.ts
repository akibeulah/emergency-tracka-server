/**
 * In-process domain events (EventEmitter2). The service that writes a case
 * event emits one of these in the same method; the realtime gateway relays it
 * to socket rooms. Not a durable bus — `case_events` is the record (arch §2.2).
 */
export const DomainEvents = {
  CaseSent: 'case.sent',
  OfferCreated: 'offer.created',
  OfferWithdrawn: 'offer.withdrawn',
  OfferDeclined: 'offer.declined',
  OfferExpired: 'offer.expired',
  ApprovalNeeded: 'offer.approval_needed',
  CaseAccepted: 'case.accepted',
  CaseStageChanged: 'case.stage_changed',
  CaseUnplaced: 'case.unplaced',
  BedHoldWarning: 'case.bed_hold_warning',
  BedHoldReleased: 'case.bed_hold_released',
  CapacityUpdated: 'capacity.updated',
  PaymentConfirmed: 'payment.confirmed',
} as const;
export type DomainEventName = (typeof DomainEvents)[keyof typeof DomainEvents];

/** Every domain event names the facility codes whose rooms should hear it. */
export interface DomainEventPayload {
  facilities: string[];
  caseId?: string;
  caseNumber?: string;
  [key: string]: unknown;
}

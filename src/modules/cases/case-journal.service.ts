import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DomainEventName, DomainEventPayload, DomainEvents } from '../../common/events';
import { AuditService } from '../audit/audit.service';
import { CaseEventDocument, CaseEvent } from './schemas/case-event.schema';
import { CaseStage } from './state-machine';

/** Who did it. null = the system (a timer or the reconciliation sweep). */
export type Actor = { userId: string; facilityCode: string; role: string } | null;

export interface CaseRef {
  _id: Types.ObjectId;
  caseNumber: string;
  senderFacility: string;
  acceptedBy?: string | null;
}

/**
 * The three side effects of a case change, in the order arch §2.2 sets:
 * append to case_events, write the audit chain (stage changes), emit the
 * in-process domain event. Timers are queued by the caller.
 */
@Injectable()
export class CaseJournal {
  constructor(
    @InjectModel(CaseEvent.name) private readonly events: Model<CaseEventDocument>,
    private readonly audit: AuditService,
    private readonly emitter: EventEmitter2,
  ) {}

  async record(c: CaseRef, type: string, actor: Actor, payload: Record<string, unknown> = {}, clientTimestamp?: Date) {
    await this.events.create({
      caseId: c._id,
      type,
      actorId: actor ? new Types.ObjectId(actor.userId) : null,
      actorFacility: actor?.facilityCode,
      payload,
      clientTimestamp,
    });
  }

  async stageChanged(c: CaseRef, from: CaseStage, to: CaseStage, actor: Actor, payload: Record<string, unknown> = {}) {
    await this.record(c, 'stage_changed', actor, { from, to, ...payload });
    await this.audit.append({
      entityType: 'case',
      entityId: c._id,
      action: 'stage_changed',
      oldValue: { stage: from },
      newValue: { stage: to, ...payload },
      actorId: actor?.userId ?? null,
      actorRole: actor?.role ?? 'system',
    });
    this.emit(DomainEvents.CaseStageChanged, {
      facilities: [c.senderFacility, c.acceptedBy ?? undefined, payload.acceptedBy as string | undefined].filter(
        (f): f is string => !!f,
      ),
      caseId: String(c._id),
      caseNumber: c.caseNumber,
      from,
      to,
    });
  }

  emit(name: DomainEventName, payload: DomainEventPayload) {
    this.emitter.emit(name, { ...payload, facilities: [...new Set(payload.facilities)], at: new Date().toISOString() });
  }

  timeline(caseId: Types.ObjectId) {
    return this.events.find({ caseId }).sort({ createdAt: 1, _id: 1 }).lean();
  }
}

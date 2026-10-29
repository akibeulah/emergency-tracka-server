import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BedCategoryName } from '../../capacity/schemas/bed-category.schema';
import { CASE_STAGES, CaseStage } from '../state-machine';

export type CaseDocument = HydratedDocument<Case>;

export const CASE_PRIORITIES = ['critical', 'urgent'] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

/** What the patient needs. Drives the hard checks (App. A, 4-2). */
export interface CaseRequirements {
  bedCategory: BedCategoryName;
  oxygen: boolean;
  /** Shown to the receiver, not hard-checked. */
  ventilator?: boolean;
  specialists: string[];
  /** Ignored by matching while the blood flag is off (G2). */
  blood?: { group: string; rh: 'pos' | 'neg'; component: string; units: number };
}

/** De-identified quick brief (4-1, G3). Identity lives in case_identities. */
export interface CaseBrief {
  ageBand: string;
  sex: 'male' | 'female' | 'unknown';
  chiefComplaint: string;
  freeText?: string;
  vitals?: Record<string, string | number>;
  consciousness?: 'alert' | 'voice' | 'pain' | 'unresponsive';
  priority: CasePriority;
  requirements: CaseRequirements;
}

export interface CaseRouting {
  wave: number;
  /** Written alongside the BullMQ job so the reconciliation sweep can recover a lost timer. */
  waveDeadline: Date | null;
  offeredFacilities: string[];
  declinedFacilities: string[];
  /** Sender chose below the top rank (4-5, §15 T15). */
  belowTopRankReason?: string;
}

/** A nurse's accept waiting on a Matron (4-11). Holds the case so no one else can take it. */
export interface CaseClaim {
  offerId: Types.ObjectId;
  facilityCode: string;
  userId: Types.ObjectId;
  approvalDeadline: Date;
}

export interface BedHold {
  facilityCode: string;
  category: BedCategoryName;
  heldAt: Date;
  /** ETA + 20% (18-2). */
  expiresAt: Date;
  /** 80% of ETA. */
  warnAt: Date;
  warned: boolean;
  status: 'held' | 'fulfilled' | 'released';
  /** Whether accepting actually took a bed off the count; only then does release give one back. */
  counted: boolean;
}

@Schema({ collection: 'cases', timestamps: true })
export class Case {
  @Prop({ required: true, unique: true })
  caseNumber: string;

  @Prop({ required: true })
  senderFacility: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: String, required: true, enum: CASE_STAGES, default: 'draft' })
  stage: CaseStage;

  @Prop({ type: Object, required: true })
  brief: CaseBrief;

  @Prop({ type: Object, default: () => ({ wave: 0, waveDeadline: null, offeredFacilities: [], declinedFacilities: [] }) })
  routing: CaseRouting;

  @Prop({ type: Object, default: null })
  claim: CaseClaim | null;

  /** facility_code; set only by the atomic conditional update (first-accept-wins, 4-6). */
  @Prop({ type: String, default: null })
  acceptedBy: string | null;

  @Prop({ type: Types.ObjectId, default: null })
  acceptedOfferId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  escortNurseId?: Types.ObjectId;

  /** Names copied at creation so the receiving facility can see who is coming without reading another facility's staff. */
  @Prop()
  escortNurseName?: string;

  @Prop()
  createdByName?: string;

  /** Locked at accept: { packageId, packageName, price, ambulanceFee, total } in kobo. */
  @Prop({ type: Object })
  pricingSnapshot?: {
    packageId?: Types.ObjectId;
    packageName?: string;
    price: number;
    ambulanceFee: number;
    total: number;
  };

  @Prop()
  hmoPolicyNumber?: string;

  @Prop({ type: Object })
  transport?: Record<string, unknown>;

  @Prop({ type: Object })
  handover?: Record<string, unknown>;

  @Prop({ type: Object, default: null })
  bedHold: BedHold | null;

  /**
   * Runs alongside care, never in front of it (NHA 2014 §20). Nothing in the
   * stage machine reads this.
   */
  @Prop({ type: Object, default: () => ({ status: 'none' }) })
  payment: { status: 'none' | 'pending' | 'paid'; reference?: string; paidAt?: Date };

  @Prop()
  closedReason?: string;

  /** Offline-queue idempotency key (12-3); unique per sender facility. */
  @Prop()
  clientRef?: string;

  @Prop()
  clientTimestamp?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const CaseSchema = SchemaFactory.createForClass(Case);
CaseSchema.index({ senderFacility: 1, createdAt: -1 });
CaseSchema.index({ senderFacility: 1, clientRef: 1 }, { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } } });
CaseSchema.index({ acceptedBy: 1, stage: 1 });
CaseSchema.index({ stage: 1, 'routing.waveDeadline': 1 });
CaseSchema.index({ 'bedHold.status': 1, 'bedHold.expiresAt': 1 });

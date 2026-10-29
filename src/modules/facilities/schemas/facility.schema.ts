import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FacilityDocument = HydratedDocument<Facility>;

export const FACILITY_TYPES = ['hospital', 'clinic', 'blood_bank', 'ambulance_operator'] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];
export const FACILITY_STATUSES = ['unclaimed', 'claim_pending', 'verified', 'suspended'] as const;
export type FacilityStatus = (typeof FACILITY_STATUSES)[number];

export const OXYGEN_STATES = ['available', 'low', 'none'] as const;
export type OxygenState = (typeof OXYGEN_STATES)[number];
export const SPECIALIST_AVAILABILITY = ['on_site', 'on_call', 'unavailable'] as const;
export type SpecialistAvailability = (typeof SPECIALIST_AVAILABILITY)[number];

export interface ClaimApproval {
  adminId: Types.ObjectId;
  at: Date;
}

export interface FacilityClaim {
  submittedBy: Types.ObjectId;
  /** Becomes the first facility_admin account on approval. */
  contactEmail: string;
  contactPhone?: string;
  legalName: string;
  licenceNumber: string;
  documents: string[];
  submittedAt: Date;
  /** Two-person rule (1-4, §15 T18): two distinct platform admins. */
  approvals: ClaimApproval[];
  decision?: 'approved' | 'rejected';
  reason?: string;
  decidedAt?: Date;
}

export interface LiveStatus {
  oxygen?: { state: OxygenState; source?: string; updatedAt: Date; by: Types.ObjectId; device?: string };
  specialists?: {
    specialty: string;
    availability: SpecialistAvailability;
    etaMinutes?: number;
    updatedAt: Date;
    by: Types.ObjectId;
  }[];
  secondaryMarkers?: { name: string; available: boolean; updatedAt: Date; by: Types.ObjectId }[];
}

@Schema({ collection: 'facilities', timestamps: true })
export class Facility {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop()
  address?: string;

  @Prop()
  lga?: string;

  @Prop({ type: String, required: true, enum: FACILITY_TYPES })
  type: FacilityType;

  @Prop({ type: String, enum: ['general', 'private', 'mission', 'other'], default: 'other' })
  ownership: string;

  /**
   * Map pin. Not in the §5 table but matching needs distance (App. A ETA
   * ranking); captured at claim time (1-2).
   */
  @Prop({ type: { lat: Number, lng: Number, _id: false } })
  location?: { lat: number; lng: number };

  /** HEFAMAA (or demo) registry row this record was seeded from (1-1). */
  @Prop({ type: Object })
  registrySource?: { name: string; recordId: string; importedAt: Date };

  @Prop({ type: String, enum: FACILITY_STATUSES, default: 'unclaimed' })
  status: FacilityStatus;

  /** Login code ('0142'). Set only on verification; partial unique index. G4. */
  @Prop()
  facilityCode?: string;

  /** Display badge 'ET-HOS-LAG-0142-7'. G4. */
  @Prop()
  displayCode?: string;

  @Prop({ type: Object })
  claim?: FacilityClaim;

  @Prop({ type: Object, default: {} })
  profile: {
    departments?: string[];
    oxygen?: { source?: string; reserveHrs?: number };
    specialists?: string[];
    bloodDesignation?: string;
  };

  @Prop({ type: Object, default: {} })
  liveStatus: LiveStatus;

  /** Payout details (G1). accountNo must be stored encrypted. */
  @Prop({ type: Object })
  payoutAccount?: {
    bankName: string;
    accountNoEnc: string;
    paystackRecipientCode?: string;
    changeHoldUntil?: Date;
  };

  @Prop({ type: Object, default: { score: null, badge: 'verified' } })
  reliability: { score: number | null; badge: 'verified' | 'reliable' | 'under_review'; updatedAt?: Date };

  /** Duty line for tap-to-call when a referral stalls (4-8, 12-2). */
  @Prop()
  dutyPhone?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const FacilitySchema = SchemaFactory.createForClass(Facility);
FacilitySchema.index(
  { facilityCode: 1 },
  { unique: true, partialFilterExpression: { facilityCode: { $type: 'string' } } },
);
FacilitySchema.index({ status: 1, type: 1 });
FacilitySchema.index({ name: 'text', address: 'text', lga: 'text' });

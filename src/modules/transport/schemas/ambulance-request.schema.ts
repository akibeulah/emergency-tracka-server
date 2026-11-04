import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { VEHICLE_CLASSES, VehicleClass } from '../fares';

export type AmbulanceRequestDocument = HydratedDocument<AmbulanceRequest>;

export const REQUEST_STATUSES = ['requested', 'accepted', 'completed', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** The crew's steps once an ambulance is on the job, in order. */
export const JOB_STEPS = ['assigned', 'en_route', 'at_pickup', 'patient_on_board', 'arrived'] as const;
export type JobStep = (typeof JOB_STEPS)[number];

export interface JobPlace {
  facilityCode: string;
  name: string;
  address?: string;
  location?: { lat: number; lng: number };
  dutyPhone?: string;
}

/**
 * One ambulance ride for one case (1 Nov 2026 minute).
 *
 * - receiving_first: the receiving facility said its ambulance is available when it accepted.
 * - open: it said no. The request goes to every facility that has not opted out of
 *   ambulance rides and has an ambulance available, third-party operators included, and
 *   the first to accept takes it.
 *
 * Copies what the crew needs (places, a de-identified brief) so a third-party operator
 * never reads the case itself.
 */
@Schema({ collection: 'ambulance_requests', timestamps: { createdAt: true, updatedAt: true } })
export class AmbulanceRequest {
  @Prop({ type: Types.ObjectId, ref: 'Case', required: true })
  caseId: Types.ObjectId;

  @Prop({ required: true })
  caseNumber: string;

  @Prop({ type: String, required: true, enum: ['receiving_first', 'open'] })
  tier: 'receiving_first' | 'open';

  @Prop({ type: String, enum: REQUEST_STATUSES, default: 'requested' })
  status: RequestStatus;

  @Prop({ type: String, enum: JOB_STEPS })
  step?: JobStep;

  @Prop({ type: String, enum: VEHICLE_CLASSES, required: true })
  vehicleClass: VehicleClass;

  @Prop({ type: Object, required: true })
  pickup: JobPlace;

  @Prop({ type: Object, required: true })
  dropoff: JobPlace;

  @Prop({ type: Object, required: true })
  patient: { ageBand: string; sex: string; chiefComplaint: string; priority: string; impression?: string };

  @Prop()
  escortNurseName?: string;

  /** Facility whose ambulance took the job. */
  @Prop({ type: String, default: null })
  providerFacility: string | null;

  @Prop()
  providerName?: string;

  @Prop({ type: Types.ObjectId, ref: 'Ambulance', default: null })
  acceptedAmbulance: Types.ObjectId | null;

  @Prop()
  ambulanceLabel?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  driverUserId?: Types.ObjectId;

  @Prop()
  driverName?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  acceptedBy?: Types.ObjectId;

  @Prop()
  acceptedAt?: Date;

  /** Kobo. Fixed tier by sending-to-receiving distance. */
  @Prop({ required: true })
  feeQuoted: number;

  @Prop()
  routeKm?: number;

  /** Facilities told when it went out. Anyone eligible later can still take it. */
  @Prop({ type: [String], default: [] })
  notified: string[];

  @Prop({ type: [Object], default: [] })
  history: { step: string; at: Date; by?: Types.ObjectId }[];

  @Prop()
  cancelReason?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const AmbulanceRequestSchema = SchemaFactory.createForClass(AmbulanceRequest);
AmbulanceRequestSchema.index({ caseId: 1 });
AmbulanceRequestSchema.index({ status: 1, createdAt: -1 });
AmbulanceRequestSchema.index({ providerFacility: 1, status: 1 });

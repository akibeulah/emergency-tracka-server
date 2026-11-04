import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { VEHICLE_CLASSES, VehicleClass } from '../fares';

export type AmbulanceDocument = HydratedDocument<Ambulance>;

export const AMBULANCE_STATUSES = ['available', 'busy', 'offline'] as const;
export type AmbulanceStatus = (typeof AMBULANCE_STATUSES)[number];

@Schema({ collection: 'ambulances', timestamps: { createdAt: true, updatedAt: true } })
export class Ambulance {
  @Prop({ required: true })
  ownerFacility: string;

  /** Plate or fleet number, unique within the owner. */
  @Prop({ required: true, trim: true })
  label: string;

  /** Clinical level of the crew and kit. */
  @Prop({ type: String, required: true, enum: ['bls', 'als'] })
  level: 'bls' | 'als';

  /** Fare tier the vehicle runs at: regular, air-conditioned or premium. */
  @Prop({ type: String, enum: VEHICLE_CLASSES, default: 'regular' })
  vehicleClass: VehicleClass;

  /**
   * Staff toggle this. 'busy' is set by the system while the ambulance is on a
   * job and cannot be toggled by hand.
   */
  @Prop({ type: String, enum: AMBULANCE_STATUSES, default: 'offline' })
  status: AmbulanceStatus;

  /** The driver usually on this vehicle; their jobs show first in the driver view. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  driverUserId?: Types.ObjectId;

  @Prop()
  driverName?: string;

  /** The job it is on while busy. */
  @Prop({ type: Types.ObjectId, ref: 'AmbulanceRequest', default: null })
  currentRequestId?: Types.ObjectId | null;

  /** Manual check-in first (§8.11); live GPS later. */
  @Prop({ type: { lat: Number, lng: Number, updatedAt: Date, _id: false } })
  location?: { lat: number; lng: number; updatedAt: Date };

  @Prop({ type: Types.ObjectId, ref: 'User' })
  registeredBy?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  statusChangedBy?: Types.ObjectId;

  @Prop()
  statusChangedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const AmbulanceSchema = SchemaFactory.createForClass(Ambulance);
AmbulanceSchema.index({ ownerFacility: 1, label: 1 }, { unique: true });
AmbulanceSchema.index({ status: 1, vehicleClass: 1 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AmbulanceDocument = HydratedDocument<Ambulance>;

@Schema({ collection: 'ambulances', timestamps: { createdAt: true, updatedAt: true } })
export class Ambulance {
  @Prop({ required: true })
  ownerFacility: string;

  /** Plate or fleet number, unique within the owner. */
  @Prop({ required: true, trim: true })
  label: string;

  @Prop({ type: String, required: true, enum: ['bls', 'als'] })
  level: 'bls' | 'als';

  @Prop({ type: String, enum: ['available', 'busy', 'offline'], default: 'offline' })
  status: 'available' | 'busy' | 'offline';

  /** Manual check-in first (§8.11); live GPS later. */
  @Prop({ type: { lat: Number, lng: Number, updatedAt: Date, _id: false } })
  location?: { lat: number; lng: number; updatedAt: Date };

  @Prop({ type: Types.ObjectId, ref: 'User' })
  registeredBy?: Types.ObjectId;

  createdAt?: Date;
  updatedAt?: Date;
}

export const AmbulanceSchema = SchemaFactory.createForClass(Ambulance);
AmbulanceSchema.index({ ownerFacility: 1, label: 1 }, { unique: true });
AmbulanceSchema.index({ status: 1, level: 1 });

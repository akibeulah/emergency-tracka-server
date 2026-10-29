import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Permission } from '../../../common/permissions';

export type DutyRosterDocument = HydratedDocument<DutyRoster>;

export interface RosterEntry {
  userId: Types.ObjectId;
  permission: Permission;
  onDutyFrom: Date;
  onDutyTo: Date;
}

/** The week's roster. Gates actions (send/accept), never login or viewing (2-11). */
@Schema({ collection: 'duty_rosters', timestamps: { createdAt: true, updatedAt: true } })
export class DutyRoster {
  @Prop({ required: true })
  facilityCode: string;

  /** Monday 00:00 Africa/Lagos, stored as UTC. */
  @Prop({ required: true })
  weekStart: Date;

  @Prop({
    type: [
      {
        userId: { type: Types.ObjectId, ref: 'User', required: true },
        permission: { type: String, required: true },
        onDutyFrom: { type: Date, required: true },
        onDutyTo: { type: Date, required: true },
        _id: false,
      },
    ],
    default: [],
  })
  entries: RosterEntry[];

  @Prop({ type: Types.ObjectId, ref: 'User' })
  setBy?: Types.ObjectId;
}

export const DutyRosterSchema = SchemaFactory.createForClass(DutyRoster);
DutyRosterSchema.index({ facilityCode: 1, weekStart: 1 }, { unique: true });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PERMISSIONS, Permission, Role, ROLES } from '../../../common/permissions';

export type UserDocument = HydratedDocument<User>;

/**
 * One account per (facilityCode, email). The same email can hold accounts at
 * several facilities plus the reserved `PUBLIC` one (2-2).
 */
@Schema({ collection: 'users', timestamps: true })
export class User {
  @Prop({ required: true, lowercase: true, trim: true })
  email: string;

  /** A facility code, or reserved 'PUBLIC' / 'PLATFORM'. */
  @Prop({ required: true, trim: true })
  facilityCode: string;

  @Prop()
  name?: string;

  @Prop({ type: String, required: true, enum: ROLES })
  role: Role;

  @Prop({ type: [String], enum: PERMISSIONS, default: [] })
  permissions: Permission[];

  @Prop()
  phone?: string;

  /** argon2 hash for the shared-ward-device PIN switch (2-8). Not wired yet. */
  @Prop({ select: false })
  pinHash?: string;

  @Prop({ type: String, enum: ['active', 'suspended', 'deactivated'], default: 'active' })
  status: 'active' | 'suspended' | 'deactivated';

  createdAt?: Date;
  updatedAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.index({ facilityCode: 1, email: 1 }, { unique: true });
UserSchema.index({ email: 1 });

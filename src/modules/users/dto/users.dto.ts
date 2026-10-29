import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEmail,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PERMISSIONS, Permission, Role, ROLES } from '../../../common/permissions';

const STAFF_ROLES = ROLES.filter((r) => r !== 'platform_admin' && r !== 'donor');

export class InviteStaffDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsIn(STAFF_ROLES)
  role: Role;

  /** E.164, e.g. +2348012345678. The OTP goes here. */
  @Matches(/^\+\d{10,15}$/, { message: 'phone must be in international format, e.g. +2348012345678' })
  phone: string;

  /** Defaults to the role's permission set when left out. */
  @IsOptional()
  @IsArray()
  @IsIn(PERMISSIONS, { each: true })
  permissions?: Permission[];
}

export class SetPermissionsDto {
  @IsArray()
  @IsIn(PERMISSIONS, { each: true })
  permissions: Permission[];
}

export class SetStatusDto {
  @IsIn(['active', 'suspended', 'deactivated'])
  status: 'active' | 'suspended' | 'deactivated';
}

export class RosterEntryDto {
  @IsMongoId()
  userId: string;

  @IsIn(PERMISSIONS)
  permission: Permission;

  @Type(() => Date)
  @IsDate()
  onDutyFrom: Date;

  @Type(() => Date)
  @IsDate()
  onDutyTo: Date;
}

export class SetRosterDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => RosterEntryDto)
  entries: RosterEntryDto[];
}

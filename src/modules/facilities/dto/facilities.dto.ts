import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CARE_LEVELS, CareLevel, FACILITY_PLANS, FACILITY_TYPES, FacilityPlan, FacilityType } from '../schemas/facility.schema';

const lowerTrim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class LocationDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;
}

export class RegistrySearchDto {
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  q: string;
}

/** 1-2: what a facility admin submits to claim a registry record. */
export class SubmitClaimDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  licenceNumber: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  contactEmail: string;

  @Matches(/^\+\d{10,15}$/, { message: 'contactPhone must be in international format, e.g. +2348012345678' })
  contactPhone: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;

  /** Storage keys of uploaded documents. Upload itself is not wired yet. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  documents?: string[];
}

export class ReasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class ContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Matches(/^\+\d{10,15}$/, { message: 'phone must be in international format, e.g. +2348012345678' })
  phone?: string;

  @IsOptional()
  @Transform(lowerTrim)
  @IsEmail()
  email?: string;
}

export class ContactsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ContactDto)
  it?: ContactDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContactDto)
  nursing?: ContactDto;
}

/** Opt out of being considered for referrals or ambulance rides. */
export class UpdateSettingsDto {
  @IsOptional()
  @IsBoolean()
  acceptReferrals?: boolean;

  @IsOptional()
  @IsBoolean()
  acceptAmbulanceRequests?: boolean;
}

export class AdminListFacilitiesDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @IsOptional()
  @IsIn(['unclaimed', 'claim_pending', 'verified', 'suspended'])
  status?: string;

  @IsOptional()
  @IsIn(CARE_LEVELS)
  level?: CareLevel;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class AdminUpdateFacilityDto {
  @IsOptional()
  @IsIn(CARE_LEVELS)
  level?: CareLevel;

  @IsOptional()
  @IsIn(FACILITY_PLANS)
  plan?: FacilityPlan;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  planNote?: string;
}

/** One row of a registry import (HEFAMAA or similar). Unclaimed until a facility claims it. */
export class RegistryRowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  recordId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsIn(FACILITY_TYPES)
  type: FacilityType;

  @IsOptional()
  @IsIn(['general', 'private', 'mission', 'other'])
  ownership?: string;

  @IsOptional()
  @IsIn(CARE_LEVELS)
  level?: CareLevel;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  lga?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;
}

export class ImportRegistryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  source: string;

  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => RegistryRowDto)
  rows: RegistryRowDto[];
}

export class UpdateProfileDto {
  @IsOptional()
  @IsIn(CARE_LEVELS)
  level?: CareLevel;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContactsDto)
  contacts?: ContactsDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  maxAmbulances?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  departments?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specialists?: string[];

  @IsOptional()
  @IsString()
  oxygenSource?: string;

  @IsOptional()
  @Matches(/^\+\d{10,15}$/)
  dutyPhone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;
}

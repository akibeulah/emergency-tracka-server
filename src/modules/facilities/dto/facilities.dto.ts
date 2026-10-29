import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

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

export class UpdateProfileDto {
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

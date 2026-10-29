import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { OXYGEN_STATES, OxygenState, SPECIALIST_AVAILABILITY, SpecialistAvailability } from '../../facilities/schemas/facility.schema';

export class ConfigureBedCategoryDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  maxSpaces: number;

  @IsInt()
  @Min(0)
  limitedThreshold: number;
}

export class SetOccupancyDto {
  @IsInt()
  @Min(0)
  occupied: number;
}

export class SetOxygenDto {
  @IsIn(OXYGEN_STATES)
  state: OxygenState;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  source?: string;
}

export class SpecialistStatusDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  specialty: string;

  @IsIn(SPECIALIST_AVAILABILITY)
  availability: SpecialistAvailability;

  @IsOptional()
  @IsInt()
  @Min(0)
  etaMinutes?: number;
}

export class SetSpecialistsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SpecialistStatusDto)
  specialists: SpecialistStatusDto[];
}

export class SetSecondaryMarkerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name: string;

  @IsBoolean()
  available: boolean;
}

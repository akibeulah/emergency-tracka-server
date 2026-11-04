import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BED_CATEGORY_NAMES, BedCategoryName } from '../../capacity/schemas/bed-category.schema';
import { CARE_LEVELS, CareLevel } from '../../facilities/schemas/facility.schema';
import { VEHICLE_CLASSES, VehicleClass } from '../../transport/fares';
import { CASE_PRIORITIES, CasePriority } from '../schemas/case.schema';
import { DECLINE_REASONS, DeclineReason } from '../schemas/offer.schema';

export class BloodRequirementDto {
  @IsIn(['A', 'B', 'AB', 'O'])
  group: string;

  @IsIn(['pos', 'neg'])
  rh: 'pos' | 'neg';

  @IsIn(['whole', 'prbc', 'ffp', 'platelets'])
  component: string;

  @IsInt()
  @Min(1)
  units: number;
}

export class RequirementsDto {
  @IsIn(BED_CATEGORY_NAMES)
  bedCategory: BedCategoryName;

  @IsBoolean()
  oxygen: boolean;

  /** A secondary marker: shown to the receiver, never hard-checked by matching. */
  @IsOptional()
  @IsBoolean()
  ventilator?: boolean;

  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  specialists: string[];

  /** Pathway: primary, secondary or tertiary. Facilities below it are left out. */
  @IsOptional()
  @IsIn(CARE_LEVELS)
  minCareLevel?: CareLevel;

  @IsOptional()
  @ValidateNested()
  @Type(() => BloodRequirementDto)
  blood?: BloodRequirementDto;
}

/** The ~30-second quick brief (4-1). De-identified: no name, no NIN, no DOB (G3). */
/** Sliders on the form; each one is sent only if the clinician switched it on. */
export class VitalsDto {
  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(100)
  spo2?: number;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(15)
  gcs?: number;

  @IsOptional()
  @IsNumber()
  @Min(30)
  @Max(45)
  tempC?: number;
}

export class TransportRequestDto {
  @IsBoolean()
  needed: boolean;

  @IsOptional()
  @IsIn(VEHICLE_CLASSES)
  vehicleClass?: VehicleClass;
}

export class CreateCaseDto {
  @Matches(/^(0-11m|1-4|5-12|13-17|18-39|40-64|65\+|unknown)$/, {
    message: 'ageBand must be one of 0-11m, 1-4, 5-12, 13-17, 18-39, 40-64, 65+, unknown',
  })
  ageBand: string;

  @IsIn(['male', 'female', 'unknown'])
  sex: 'male' | 'female' | 'unknown';

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  chiefComplaint: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  freeText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  impression?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  investigations?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VitalsDto)
  vitals?: VitalsDto;

  /** Left out: an ambulance is needed, regular tier. */
  @IsOptional()
  @ValidateNested()
  @Type(() => TransportRequestDto)
  transport?: TransportRequestDto;

  @IsOptional()
  @IsIn(['alert', 'voice', 'pain', 'unresponsive'])
  consciousness?: 'alert' | 'voice' | 'pain' | 'unresponsive';

  @IsIn(CASE_PRIORITIES)
  priority: CasePriority;

  @ValidateNested()
  @Type(() => RequirementsDto)
  requirements: RequirementsDto;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  hmoPolicyNumber?: string;

  /** G7: the nurse travelling with the patient. */
  @IsOptional()
  @IsMongoId()
  escortNurseId?: string;

  /** Idempotency key from the offline queue (12-3): the same ref twice is one case. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientRef?: string;

  /** When the draft was made on the device, kept for later-timestamp-wins (12-3). */
  @IsOptional()
  @IsISO8601()
  clientTimestamp?: string;
}

export class ReceivedDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  clinicianName: string;
}

export class SendCaseDto {
  /** Up to three hand-picked facilities. Left out: the top three ranked go. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  facilityCodes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  belowTopRankReason?: string;
}

export class AcceptDto {
  /** "Is your ambulance available?" Left out counts as no: the ride goes to everyone. */
  @IsOptional()
  @IsBoolean()
  ambulanceAvailable?: boolean;
}

export class VerifyHandoverDto {
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'The handover code is six digits.' })
  code?: string;

  /** What the QR carries after the case id. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  token?: string;
}

export class DeclineDto {
  @IsIn(DECLINE_REASONS.filter((r) => r !== 'matron_rejected'))
  reason: DeclineReason;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class ReasonNoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;
}

export class OptionalNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export const ADVANCEABLE_STAGES = ['in_transit', 'arrived', 'handed_over', 'closed'] as const;
export type AdvanceableStage = (typeof ADVANCEABLE_STAGES)[number];

export class AdvanceStageDto {
  @IsIn(ADVANCEABLE_STAGES)
  to: AdvanceableStage;
}

export class ListCasesDto {
  @IsOptional()
  @IsIn(['outgoing', 'incoming', 'accepted'])
  direction?: 'outgoing' | 'incoming' | 'accepted';
}

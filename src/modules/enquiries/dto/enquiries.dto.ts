import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ENQUIRY_REASONS, ENQUIRY_STATUSES, EnquiryReason, EnquiryStatus } from '../schemas/enquiry.schema';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** The website contact form. Public: no sign-in. */
export class SubmitEnquiryDto {
  @IsIn(ENQUIRY_REASONS)
  reason: EnquiryReason;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  facilityName?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  message: string;

  /** Honeypot. Hidden from people; only an automated form-filler sends it. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;
}

export class EnquiryStatusDto {
  @IsIn(ENQUIRY_STATUSES)
  status: EnquiryStatus;
}

export class EnquiryListDto {
  @IsOptional()
  @IsIn(ENQUIRY_STATUSES)
  status?: EnquiryStatus;
}

import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

const trimUpper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Facility code is optional (2-1): left out, the login is for the PUBLIC
 * account. The code is not a secret (G4) — the OTP does the security work.
 */
export class RequestOtpDto {
  @IsOptional()
  @Transform(trimUpper)
  @Matches(/^(\d{4,6}|PUBLIC|PLATFORM)$/, { message: 'facilityCode must be a facility code like 0142' })
  facilityCode?: string;

  @Transform(trimLower)
  @IsEmail()
  email: string;
}

export class VerifyOtpDto extends RequestOtpDto {
  @IsString()
  @Length(6, 6)
  code: string;

  /** Stable per-install id from the client; sessions are bound to it (2-12). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  deviceId: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

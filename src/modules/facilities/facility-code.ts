import { Model } from 'mongoose';
import { CounterDocument } from './schemas/counter.schema';
import { FacilityType } from './schemas/facility.schema';

export const FACILITY_CODE_COUNTER = 'facility_code';

/**
 * G4: the login code is short and sequential ('0142'); the full
 * 'ET-HOS-LAG-0142-7' is a display badge only. Neither is a secret.
 */
export async function nextFacilityCode(counters: Model<CounterDocument>): Promise<string> {
  const counter = await counters.findOneAndUpdate(
    { _id: FACILITY_CODE_COUNTER },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return String(counter!.seq).padStart(4, '0');
}

const TYPE_PREFIX: Record<FacilityType, string> = {
  hospital: 'HOS',
  clinic: 'CLN',
  blood_bank: 'BBK',
  ambulance_operator: 'AMB',
};

/** Luhn check digit over the code's digits, so a mistyped badge is caught on sight. */
export function luhnCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function displayCode(type: FacilityType, code: string, state = 'LAG'): string {
  return `ET-${TYPE_PREFIX[type]}-${state}-${code}-${luhnCheckDigit(code)}`;
}

import { displayCode, luhnCheckDigit } from './facility-code';

describe('facility code (G4)', () => {
  it('computes a Luhn check digit', () => {
    expect(luhnCheckDigit('7992739871')).toBe(3); // the textbook example
  });

  it('builds the display badge from type and login code', () => {
    expect(displayCode('hospital', '0142')).toMatch(/^ET-HOS-LAG-0142-\d$/);
    expect(displayCode('blood_bank', '0007')).toMatch(/^ET-BBK-LAG-0007-\d$/);
  });

  it('catches a single mistyped digit', () => {
    const d = luhnCheckDigit('0142');
    expect(luhnCheckDigit('0143')).not.toBe(d);
    expect(luhnCheckDigit('0242')).not.toBe(d);
  });
});

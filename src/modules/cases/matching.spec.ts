import { CandidateFacility, matchFacilities, MatchInput, nextWave, validateSelection } from './matching';

const NOW = new Date('2026-10-28T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const ORIGIN = { lat: 6.6018, lng: 3.3515 };

function facility(code: string, over: Partial<CandidateFacility> = {}): CandidateFacility {
  return {
    facilityCode: code,
    name: `Facility ${code}`,
    location: { lat: 6.6, lng: 3.36 },
    reliabilityBadge: 'verified',
    oxygen: { state: 'available', updatedAt: minsAgo(10) },
    specialists: [{ specialty: 'general surgery', availability: 'on_site' }],
    beds: [{ name: 'icu', maxSpaces: 10, limitedThreshold: 2, occupied: 2, updatedAt: minsAgo(10) }],
    ...over,
  };
}

function input(candidates: CandidateFacility[], over: Partial<MatchInput> = {}): MatchInput {
  return {
    requirements: { bedCategory: 'icu', oxygen: true, specialists: ['general surgery'] },
    origin: ORIGIN,
    candidates,
    exclude: new Set(),
    now: NOW,
    bloodEnabled: false,
    ...over,
  };
}

const codes = (r: { facilityCode: string }[]) => r.map((x) => x.facilityCode);

describe('matchFacilities — hard checks (App. A, 4-2)', () => {
  it('passes a facility that meets every requirement', () => {
    const { ranked, excluded } = matchFacilities(input([facility('0001')]));
    expect(codes(ranked)).toEqual(['0001']);
    expect(excluded).toEqual([]);
    expect(ranked[0].markers).toMatchObject({ bed: 'ok', freshness: 'ok', oxygen: 'ok', specialists: 'ok', blood: 'not_checked' });
  });

  it('excludes a full bed category and one without the category at all', () => {
    const full = facility('0001', { beds: [{ name: 'icu', maxSpaces: 4, limitedThreshold: 1, occupied: 4, updatedAt: minsAgo(5) }] });
    const none = facility('0002', { beds: [{ name: 'hdu', maxSpaces: 4, limitedThreshold: 1, occupied: 0, updatedAt: minsAgo(5) }] });
    const { ranked, excluded } = matchFacilities(input([full, none]));
    expect(ranked).toEqual([]);
    expect(excluded.find((e) => e.facilityCode === '0001')!.reasons).toContain('beds_full');
    expect(excluded.find((e) => e.facilityCode === '0002')!.reasons).toContain('no_icu_beds');
  });

  it('never auto-matches data older than 4 hours, but warns on 2–4 hours (3-7)', () => {
    const stale = facility('0001', { beds: [{ name: 'icu', maxSpaces: 10, limitedThreshold: 2, occupied: 0, updatedAt: minsAgo(4 * 60 + 1) }] });
    const ageing = facility('0002', { beds: [{ name: 'icu', maxSpaces: 10, limitedThreshold: 2, occupied: 0, updatedAt: minsAgo(3 * 60) }] });
    const { ranked, excluded } = matchFacilities(input([stale, ageing]));
    expect(excluded[0]).toMatchObject({ facilityCode: '0001', reasons: ['stale_data'] });
    expect(ranked[0]).toMatchObject({ facilityCode: '0002', markers: { freshness: 'warn' } });
  });

  it('fails oxygen when none, unknown or stale; warns when low', () => {
    const none = facility('0001', { oxygen: { state: 'none', updatedAt: minsAgo(1) } });
    const unknown = facility('0002', { oxygen: undefined });
    const stale = facility('0003', { oxygen: { state: 'available', updatedAt: minsAgo(300) } });
    const low = facility('0004', { oxygen: { state: 'low', updatedAt: minsAgo(1) } });
    const { ranked, excluded } = matchFacilities(input([none, unknown, stale, low]));
    expect(codes(ranked)).toEqual(['0004']);
    expect(ranked[0].markers.oxygen).toBe('warn');
    expect(Object.fromEntries(excluded.map((e) => [e.facilityCode, e.reasons]))).toEqual({
      '0001': ['no_oxygen'],
      '0002': ['oxygen_unknown'],
      '0003': ['oxygen_stale'],
    });
  });

  it('ignores oxygen when the patient does not need it', () => {
    const { ranked } = matchFacilities(
      input([facility('0001', { oxygen: undefined })], {
        requirements: { bedCategory: 'icu', oxygen: false, specialists: ['general surgery'] },
      }),
    );
    expect(ranked[0].markers.oxygen).toBe('not_checked');
  });

  it('needs every required specialist on site (✓) or on call (!)', () => {
    const onCall = facility('0001', { specialists: [{ specialty: 'general surgery', availability: 'on_call' }] });
    const away = facility('0002', { specialists: [{ specialty: 'general surgery', availability: 'unavailable' }] });
    const missing = facility('0003', { specialists: [] });
    const { ranked, excluded } = matchFacilities(input([onCall, away, missing]));
    expect(ranked.map((r) => [r.facilityCode, r.markers.specialists])).toEqual([['0001', 'warn']]);
    expect(codes(excluded)).toEqual(['0002', '0003']);
  });

  it('matches specialties case-insensitively', () => {
    const { ranked } = matchFacilities(
      input([facility('0001')], { requirements: { bedCategory: 'icu', oxygen: true, specialists: ['  General Surgery '] } }),
    );
    expect(codes(ranked)).toEqual(['0001']);
  });

  it('skips the blood check entirely while the flag is off (G2), and enforces it when on', () => {
    const req = { bedCategory: 'icu' as const, oxygen: false, specialists: [], blood: { group: 'O', rh: 'neg' as const, component: 'prbc', units: 2 } };
    const noBlood = facility('0001', { bloodUnits: {} });
    expect(codes(matchFacilities(input([noBlood], { requirements: req })).ranked)).toEqual(['0001']);
    const on = matchFacilities(input([noBlood, facility('0002', { bloodUnits: { 'Oneg:prbc': 3 } })], { requirements: req, bloodEnabled: true }));
    expect(codes(on.ranked)).toEqual(['0002']);
    expect(on.excluded[0].reasons).toEqual(['blood_unavailable']);
  });

  it('never offers to the sender or a facility that already declined', () => {
    const { ranked, excluded } = matchFacilities(input([facility('0001'), facility('0002'), facility('0003')], { exclude: new Set(['0001', '0003']) }));
    expect(codes(ranked)).toEqual(['0002']);
    expect(excluded).toEqual([]);
  });
});

describe('matchFacilities — ranking: confidence → ETA → cost (4-3)', () => {
  it('puts capability confidence ahead of distance', () => {
    const nearButShaky = facility('0001', { location: ORIGIN, oxygen: { state: 'low', updatedAt: minsAgo(1) } });
    const farButSolid = facility('0002', { location: { lat: 6.45, lng: 3.47 } });
    expect(codes(matchFacilities(input([nearButShaky, farButSolid])).ranked)).toEqual(['0002', '0001']);
  });

  it('breaks equal confidence by ETA', () => {
    const far = facility('0001', { location: { lat: 6.45, lng: 3.47 } });
    const near = facility('0002', { location: { lat: 6.6, lng: 3.355 } });
    const { ranked } = matchFacilities(input([far, near]));
    expect(codes(ranked)).toEqual(['0002', '0001']);
    expect(ranked[0].etaMinutes!).toBeLessThan(ranked[1].etaMinutes!);
  });

  it('uses cost only as the last tie-break — a cheaper weaker facility never outranks', () => {
    const cheapWeak = facility('0001', { packagePrice: 10_000, specialists: [{ specialty: 'general surgery', availability: 'on_call' }] });
    const dearStrong = facility('0002', { packagePrice: 900_000 });
    const sameButCheaper = facility('0003', { packagePrice: 50_000 });
    expect(codes(matchFacilities(input([cheapWeak, dearStrong, sameButCheaper])).ranked)).toEqual(['0003', '0002', '0001']);
  });

  it('ranks a reliable badge above verified above under review at equal markers', () => {
    const r = matchFacilities(
      input([
        facility('0001', { reliabilityBadge: 'under_review' }),
        facility('0002', { reliabilityBadge: 'verified' }),
        facility('0003', { reliabilityBadge: 'reliable' }),
      ]),
    );
    expect(codes(r.ranked)).toEqual(['0003', '0002', '0001']);
  });

  it('numbers ranks from 1 and puts unknown ETA last', () => {
    const { ranked } = matchFacilities(input([facility('0001', { location: undefined }), facility('0002')]));
    expect(ranked.map((r) => [r.facilityCode, r.rank])).toEqual([
      ['0002', 1],
      ['0001', 2],
    ]);
    expect(ranked[1].etaMinutes).toBeNull();
  });
});

describe('waves of three (4-6, G6)', () => {
  const { ranked } = matchFacilities(input(['0001', '0002', '0003', '0004', '0005'].map((c) => facility(c))));

  it('offers the top three first, then the next best not yet asked', () => {
    const w1 = nextWave(ranked, new Set());
    expect(w1).toHaveLength(3);
    const w2 = nextWave(ranked, new Set(codes(w1)));
    expect(codes(w2)).toEqual(codes(ranked).slice(3));
    expect(nextWave(ranked, new Set(codes(ranked)))).toEqual([]);
  });
});

describe('validateSelection (4-5)', () => {
  const { ranked } = matchFacilities(input(['0001', '0002', '0003', '0004'].map((c) => facility(c))));
  const fourth = ranked[3].facilityCode;

  it('accepts up to three eligible picks from the top three without a reason', () => {
    expect(validateSelection(ranked, codes(ranked).slice(0, 3))).toMatchObject({ ok: true });
  });

  it('demands a reason for a pick below the top three', () => {
    expect(validateSelection(ranked, [fourth])).toEqual({ ok: false, problem: 'reason_required' });
    expect(validateSelection(ranked, [fourth], 'family preference')).toMatchObject({ ok: true });
  });

  it('refuses ineligible, duplicate, empty and over-long selections', () => {
    expect(validateSelection(ranked, ['9999'])).toEqual({ ok: false, problem: 'not_eligible', facilityCode: '9999' });
    expect(validateSelection(ranked, ['0001', '0001'])).toEqual({ ok: false, problem: 'duplicate' });
    expect(validateSelection(ranked, [])).toEqual({ ok: false, problem: 'empty' });
    expect(validateSelection(ranked, codes(ranked))).toEqual({ ok: false, problem: 'too_many' });
  });
});

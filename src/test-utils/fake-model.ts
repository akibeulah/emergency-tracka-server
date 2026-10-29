import { Types } from 'mongoose';

/**
 * A tiny in-memory stand-in for a Mongoose model, enough for the engine's
 * conditional updates. Each operation yields to the event loop first, then
 * matches and writes in one synchronous step — the same atomicity a single
 * MongoDB document update gives, so concurrent callers genuinely interleave.
 */
type Doc = Record<string, any>;

const tick = () => new Promise<void>((r) => setImmediate(r));
/** Deep copy that keeps ObjectIds and Dates as themselves (structuredClone does not). */
function clone<T>(v: T): T {
  if (v instanceof Types.ObjectId || v instanceof Date || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone) as T;
  return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, clone(x)])) as T;
}

function get(doc: Doc, path: string): unknown {
  return path.split('.').reduce<any>((v, k) => (v == null ? undefined : v[k]), doc);
}

function set(doc: Doc, path: string, value: unknown) {
  const keys = path.split('.');
  let cur = doc;
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
  cur[keys[keys.length - 1]] = value;
}

const same = (a: unknown, b: unknown) =>
  a instanceof Types.ObjectId || b instanceof Types.ObjectId ? String(a) === String(b) : a === b;

function matchesValue(actual: unknown, cond: unknown): boolean {
  if (cond && typeof cond === 'object' && !(cond instanceof Types.ObjectId) && !(cond instanceof Date)) {
    const c = cond as Record<string, unknown>;
    if ('$in' in c) return (c.$in as unknown[]).some((v) => same(actual, v));
    if ('$ne' in c) return !same(actual, c.$ne) && !(c.$ne === null && actual === undefined);
    if ('$lte' in c) return actual instanceof Date && actual <= (c.$lte as Date);
    if ('$exists' in c) return (actual !== undefined) === c.$exists;
  }
  if (cond === null) return actual === null || actual === undefined;
  return same(actual, cond);
}

export function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '_id') return matchesValue(doc._id, v);
    const actual = get(doc, k);
    // Mongo semantics: { 'arr.field': x } matches if any element matches.
    const [head, ...rest] = k.split('.');
    if (Array.isArray(doc[head]) && rest.length) return doc[head].some((el: Doc) => matchesValue(get(el, rest.join('.')), v));
    return matchesValue(actual, v);
  });
}

function apply(doc: Doc, update: Doc) {
  for (const [k, v] of Object.entries(update.$set ?? {})) set(doc, k, clone(v));
  for (const [k, v] of Object.entries(update.$inc ?? {})) set(doc, k, ((get(doc, k) as number) ?? 0) + (v as number));
  for (const [k, v] of Object.entries(update.$addToSet ?? {})) {
    const arr = ((get(doc, k) as unknown[]) ?? []).slice();
    const items = v && typeof v === 'object' && '$each' in (v as Doc) ? (v as Doc).$each : [v];
    for (const item of items) if (!arr.some((x) => same(x, item))) arr.push(item);
    set(doc, k, arr);
  }
  for (const [k, v] of Object.entries(update.$push ?? {})) set(doc, k, [...((get(doc, k) as unknown[]) ?? []), v]);
}

/** Thenable with .lean()/.sort()/.limit()/.select() so `await model.find(...).lean()` works. */
function query<T>(run: () => Promise<T>) {
  const q: any = {
    lean: () => q,
    sort: () => q,
    limit: () => q,
    select: () => q,
    then: (res: any, rej: any) => run().then(res, rej),
  };
  return q;
}

export class FakeModel {
  docs: Doc[] = [];
  readonly calls: { op: string; filter: Doc; update?: Doc }[] = [];

  constructor(seed: Doc[] = []) {
    this.docs = seed.map((d) => ({ _id: new Types.ObjectId(), ...clone(d) }));
  }

  findOne(filter: Doc) {
    return query(async () => {
      await tick();
      const d = this.docs.find((x) => matches(x, filter));
      return d ? clone(d) : null;
    });
  }

  findById(id: unknown) {
    return this.findOne({ _id: id });
  }

  find(filter: Doc = {}) {
    return query(async () => {
      await tick();
      return this.docs.filter((x) => matches(x, filter)).map(clone);
    });
  }

  exists(filter: Doc) {
    return query(async () => {
      await tick();
      const d = this.docs.find((x) => matches(x, filter));
      return d ? { _id: d._id } : null;
    });
  }

  findOneAndUpdate(filter: Doc, update: Doc, opts: { new?: boolean; upsert?: boolean } = {}) {
    this.calls.push({ op: 'findOneAndUpdate', filter, update });
    return query(async () => {
      await tick();
      const d = this.docs.find((x) => matches(x, filter));
      if (!d) return null;
      const before = clone(d);
      apply(d, update);
      return opts.new ? clone(d) : before;
    });
  }

  updateOne(filter: Doc, update: Doc, opts: { upsert?: boolean } = {}) {
    this.calls.push({ op: 'updateOne', filter, update });
    return query(async () => {
      await tick();
      const d = this.docs.find((x) => matches(x, filter));
      if (d) apply(d, update);
      else if (opts.upsert) {
        const inserted: Doc = { _id: new Types.ObjectId(), ...clone(update.$setOnInsert ?? {}) };
        apply(inserted, update);
        this.docs.push(inserted);
      }
      return { modifiedCount: d ? 1 : 0, matchedCount: d ? 1 : 0, upsertedCount: !d && opts.upsert ? 1 : 0 };
    });
  }

  updateMany(filter: Doc, update: Doc) {
    this.calls.push({ op: 'updateMany', filter, update });
    return query(async () => {
      await tick();
      const hit = this.docs.filter((x) => matches(x, filter));
      hit.forEach((d) => apply(d, update));
      return { modifiedCount: hit.length };
    });
  }

  async create(doc: Doc) {
    await tick();
    const d = { _id: new Types.ObjectId(), ...clone(doc) };
    this.docs.push(d);
    return { ...clone(d), toObject: () => clone(d) };
  }

  async insertMany(docs: Doc[]) {
    return Promise.all(docs.map((d) => this.create(d)));
  }
}

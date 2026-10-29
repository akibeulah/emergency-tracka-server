import { Schema } from 'mongoose';

const MUTATIONS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'replaceOne',
  'deleteOne',
  'deleteMany',
] as const;

/**
 * Refuses every update and delete issued through Mongoose. The collection is
 * written with `create`/`insertMany` and never changed afterwards. (A DB user
 * with insert-only rights is the production-grade version of this.)
 */
export function appendOnly(schema: Schema, collection: string): void {
  for (const op of MUTATIONS) {
    schema.pre(op, function () {
      throw new Error(`${collection} is append-only: ${op} is not allowed`);
    });
  }
  schema.pre('save', function () {
    if (!this.isNew) throw new Error(`${collection} is append-only: documents cannot be re-saved`);
  });
}

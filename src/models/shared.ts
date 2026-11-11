import type { SchemaOptions } from 'mongoose';

/**
 * Shared serialisation: expose `id` instead of `_id`, drop `__v`.
 * Sensitive fields are removed per-model (see User.model.ts).
 */
export function jsonTransform(
  _doc: unknown,
  ret: Record<string, unknown>,
): Record<string, unknown> {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  return ret;
}

export const baseSchemaOptions = {
  timestamps: true,
  // Indexes are declared explicitly with schema.index(); never on fields.
  // Only JSON output is transformed; toObject() stays raw for internal use.
  toJSON: { transform: jsonTransform },
} satisfies SchemaOptions;

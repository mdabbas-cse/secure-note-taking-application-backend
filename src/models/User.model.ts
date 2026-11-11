import bcrypt from 'bcrypt';
import { Schema, model, type HydratedDocument, type Model } from 'mongoose';
import { env } from '../config/env.js';
import { jsonTransform } from './shared.js';

export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface IUser {
  name: string;
  email: string;
  password: string;
  role: Role;
  interests: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface IUserMethods {
  comparePassword(candidate: string): Promise<boolean>;
}

export type UserModel = Model<IUser, object, IUserMethods>;
export type UserDocument = HydratedDocument<IUser, IUserMethods>;

function userJsonTransform(doc: unknown, ret: Record<string, unknown>): Record<string, unknown> {
  // The hash must never leave the API, even if a query explicitly selected it.
  delete ret.password;
  return jsonTransform(doc, ret);
}

const userSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
    // Normalised on write (trim + lowercase); lookups normalise the same way.
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    // Excluded from every query by default; login opts in with .select('+password').
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, default: 'user' },
    interests: { type: [String], default: [] },
  },
  {
    timestamps: true,
    toJSON: { transform: userJsonTransform },
  },
);

/* ------------------------------------------------------------------ *
 * Indexes (the _id index is created automatically by MongoDB)
 * ------------------------------------------------------------------ */

// email_1 (unique)
// Queries: User.findOne({ email }) on login (POST /api/auth/login).
// Constraint: one account per normalised email. Registration / admin create /
// admin email change rely on the E11000 error from this index instead of a
// racy "check then insert" query. A single unique index serves both purposes,
// so no extra non-unique email index is declared.
userSchema.index({ email: 1 }, { unique: true });

// interests_1 (multikey)
// Queries: GET /api/users/aggregation/interests?interests=a,b — the pipeline
// starts with { $match: { interests: { $in: [...] } } } which uses an IXSCAN on
// this index (verified in tests/indexes.test.ts). The unfiltered grouping
// visits every user by definition, so it is a COLLSCAN regardless of indexes.
userSchema.index({ interests: 1 });

/* ------------------------------------------------------------------ */

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, env.bcryptSaltRounds);
});

userSchema.method(
  'comparePassword',
  function comparePassword(this: UserDocument, candidate: string) {
    return bcrypt.compare(candidate, this.password);
  },
);

export const User = model<IUser, UserModel>('User', userSchema);

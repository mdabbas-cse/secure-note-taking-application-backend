import { z } from 'zod';
import {
  emailSchema,
  interestsSchema,
  nameSchema,
  passwordSchema,
} from '../../utils/validators.js';

// strictObject: unknown keys (e.g. "role": "admin") are rejected with 400, so a
// client can never self-assign a role at registration.
export const registerSchema = z.strictObject({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  interests: interestsSchema.optional(),
});

export const loginSchema = z.strictObject({
  email: emailSchema,
  // No strength rules on login: they would leak policy and add no security.
  password: z.string().min(1).max(256),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

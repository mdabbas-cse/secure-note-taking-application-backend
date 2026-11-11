/**
 * Creates the first admin (registration can only create normal users).
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:seed-admin
 *
 * It never promotes an existing account: anyone can self-register, so an
 * attacker could pre-register ADMIN_EMAIL with their own password and be
 * promoted. If the email exists, the script stops and explains what to do.
 */
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectDatabase } from '../src/config/database.js';
import { User } from '../src/models/User.model.js';
import { emailSchema, nameSchema, passwordSchema } from '../src/utils/validators.js';

const input = z
  .object({
    ADMIN_NAME: nameSchema.default('Admin'),
    ADMIN_EMAIL: emailSchema,
    ADMIN_PASSWORD: passwordSchema,
  })
  .parse(process.env);

async function main(): Promise<void> {
  await connectDatabase();
  await User.init();

  const existing = await User.findOne({ email: input.ADMIN_EMAIL }).lean();
  if (existing) {
    console.error(
      `An account with ${input.ADMIN_EMAIL} already exists (role: ${existing.role}). ` +
        'Refusing to promote an account whose password this script did not set. ' +
        'Choose another ADMIN_EMAIL, or have an existing admin change the role via PATCH /api/users/:id.',
    );
    process.exitCode = 1;
  } else {
    const admin = await User.create({
      name: input.ADMIN_NAME,
      email: input.ADMIN_EMAIL,
      password: input.ADMIN_PASSWORD,
      role: 'admin',
    });
    console.info(`Created admin ${admin.email}`);
  }
  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

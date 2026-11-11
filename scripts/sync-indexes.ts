/**
 * Reconciles MongoDB indexes with the schema.index() declarations.
 *
 *   npm run db:indexes            # dry run: show what would be created/dropped
 *   npm run db:indexes -- --apply # create missing indexes, drop undeclared ones
 *
 * Production runs with autoIndex disabled; this is the explicit, reviewable step
 * that builds indexes (and removes redundant ones) instead of doing it on boot.
 */
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/database.js';
import { Note } from '../src/models/Note.model.js';
import { Post } from '../src/models/Post.model.js';
import { User } from '../src/models/User.model.js';

const apply = process.argv.includes('--apply');
const models = [User, Note, Post] as const;

async function main(): Promise<void> {
  // No index verification here: this script is what creates the indexes.
  await connectDatabase(undefined, { autoIndex: false }, { verifyIndexes: false });

  for (const model of models) {
    const name = model.collection.collectionName;
    if (apply) {
      const dropped = await model.syncIndexes();
      console.info(`${name}: synced${dropped.length ? `, dropped ${dropped.join(', ')}` : ''}`);
    } else {
      const { toCreate, toDrop } = await model.diffIndexes();
      console.info(
        `${name}: toCreate=${JSON.stringify(toCreate)} toDrop=${JSON.stringify(toDrop)}`,
      );
    }
    const indexes = await model.collection.indexes().catch(() => []);
    for (const index of indexes) {
      console.info(
        `  - ${index.name} ${JSON.stringify(index.key)}${index.unique ? ' unique' : ''}`,
      );
    }
  }

  if (!apply) console.info('\nDry run only. Re-run with --apply to change indexes.');
  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

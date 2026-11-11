/**
 * Runs explain('executionStats') on every important API query and prints a report.
 *
 *   npm run db:explain                 # in-memory MongoDB with a seeded data set
 *   npm run db:explain -- --uri=<uri>  # against an existing database (read-only)
 *
 * Queries come from scripts/lib/queryCatalog.ts, which uses the same builders as
 * the services, so the plans shown are the plans of the real API queries.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Types } from 'mongoose';
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/database.js';
import { Note } from '../src/models/Note.model.js';
import { Post } from '../src/models/Post.model.js';
import { User } from '../src/models/User.model.js';
import { summarizeExplain } from './lib/explainSummary.js';
import { queryCatalog, type CatalogContext } from './lib/queryCatalog.js';

const INTERESTS = [
  'chess',
  'reading',
  'football',
  'music',
  'travel',
  'cooking',
  'hiking',
  'gaming',
  'photography',
  'painting',
  'running',
  'cycling',
  'movies',
  'yoga',
  'coding',
];

const USERS = 1_000;
const NOTES = 30_000;
const POSTS = 10_000;

async function seed(): Promise<void> {
  // A single pre-computed hash keeps seeding fast; these accounts are never used to log in.
  const passwordHash = '$2b$04$abcdefghijklmnopqrstuuJ5dPZ4Oq5Q2y3oVv1gDqM8ZGzv1y6W2';
  const users = await User.insertMany(
    Array.from({ length: USERS }, (_, i) => ({
      name: `User ${i}`,
      email: `user${i}@example.com`,
      password: passwordHash,
      role: i === 0 ? 'admin' : 'user',
      // 20% of users have no interests; others have 1-3.
      interests:
        i % 5 === 0
          ? []
          : Array.from(
              { length: (i % 3) + 1 },
              (_, k) => INTERESTS[(i * 7 + k * 5) % INTERESTS.length]!,
            ),
    })),
    { lean: true },
  );

  const now = Date.now();
  // Skewed ownership: user 1 owns 10% of notes/posts, the rest spread evenly.
  const ownerFor = (i: number) => (i % 10 === 0 ? users[1]! : users[(i % (USERS - 1)) + 1]!)._id;
  await Note.insertMany(
    Array.from({ length: NOTES }, (_, i) => {
      const createdAt = new Date(now - (NOTES - i) * 60_000);
      return {
        title: `Note ${i}`,
        content: 'Lorem ipsum',
        user: ownerFor(i),
        createdAt,
        updatedAt: createdAt,
      };
    }),
    { lean: true },
  );
  await Post.insertMany(
    Array.from({ length: POSTS }, (_, i) => {
      const createdAt = new Date(now - (POSTS - i) * 60_000);
      return {
        title: `Post ${i}`,
        content: 'Lorem ipsum',
        user: ownerFor(i),
        createdAt,
        updatedAt: createdAt,
      };
    }),
    { lean: true },
  );
}

async function buildContext(): Promise<CatalogContext> {
  // Owner with the most notes (exercises the index the hardest).
  const [top] = await Note.aggregate<{ _id: Types.ObjectId }>([
    { $group: { _id: '$user', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]);
  if (!top) throw new Error('No notes found: seed data first or use the in-memory mode');
  const note = await Note.findOne({ user: top._id }).lean();
  const user = await User.findOne({}).lean();
  const [interest] = await User.aggregate<{ _id: string }>([
    { $unwind: '$interests' },
    { $group: { _id: '$interests', count: { $sum: 1 } } },
    { $sort: { count: 1 } },
    { $limit: 1 },
  ]);
  return {
    ownerId: top._id,
    noteId: note!._id,
    email: user!.email,
    interest: interest?._id ?? 'chess',
  };
}

async function main(): Promise<void> {
  const uriArg = process.argv.find((arg) => arg.startsWith('--uri='))?.slice('--uri='.length);
  const mongod = uriArg ? undefined : await MongoMemoryServer.create();
  await connectDatabase(uriArg ?? mongod!.getUri(), {
    ...(uriArg ? {} : { dbName: 'explain_demo' }),
    monitorCommands: true, // needed to capture the countDocuments pipeline
  });
  await Promise.all([User.init(), Note.init(), Post.init()]);

  if (mongod) {
    console.info(`Seeding ${USERS} users, ${NOTES} notes, ${POSTS} posts...`);
    await seed();
  }

  const { version } = await mongoose.connection.db!.admin().serverInfo();
  const counts = await Promise.all([
    User.estimatedDocumentCount(),
    Note.estimatedDocumentCount(),
    Post.estimatedDocumentCount(),
  ]);
  const ctx = await buildContext();
  console.info(`MongoDB ${version} — users=${counts[0]} notes=${counts[1]} posts=${counts[2]}\n`);

  const rows: string[] = [
    '| Query | Endpoint | Plan stages | Index | $lookup index | Keys examined | Docs examined | Returned | OK |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  let failures = 0;

  for (const entry of queryCatalog) {
    const summary = summarizeExplain(await entry.explain(ctx));
    const usedExpected =
      entry.expected === 'COLLSCAN'
        ? summary.stages.includes('COLLSCAN')
        : summary.indexNames.includes(entry.expected);
    const forbidden = (entry.forbiddenStages ?? []).filter((stage) =>
      summary.stages.includes(stage),
    );
    const lookupOk =
      !entry.expectedLookupIndex || summary.lookupIndexesUsed.includes(entry.expectedLookupIndex);
    const ok = usedExpected && forbidden.length === 0 && lookupOk;
    if (!ok) failures += 1;

    rows.push(
      [
        entry.name,
        `\`${entry.endpoint}\``,
        summary.stages.filter((stage) => stage === stage.toUpperCase()).join(' > '),
        summary.indexNames.join(', ') || '—',
        summary.lookupIndexesUsed.join(', ') || '—',
        summary.totalKeysExamined,
        summary.totalDocsExamined,
        summary.nReturned,
        ok
          ? 'yes'
          : `NO (expected ${entry.expected}${forbidden.length ? `, saw ${forbidden.join('/')}` : ''})`,
      ]
        .join(' | ')
        .replace(/^/, '| ')
        .concat(' |'),
    );
  }

  console.info(rows.join('\n'));
  await mongoose.disconnect();
  await mongod?.stop();
  if (failures > 0) {
    console.error(
      `\n${failures} quer${failures === 1 ? 'y' : 'ies'} did not use the expected index`,
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

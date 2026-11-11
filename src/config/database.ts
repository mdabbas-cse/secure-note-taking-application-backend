import { attachDatabasePool } from '@vercel/functions';
import mongoose, { type ConnectOptions } from 'mongoose';
import { Note } from '../models/Note.model.js';
import { Post } from '../models/Post.model.js';
import { User } from '../models/User.model.js';
import { env } from './env.js';

// Throw on filters that reference paths not in the schema. The default (or
// `true`) silently DROPS such paths, so a typo like { usr: id } in an ownership
// filter would turn a scoped deleteMany into a delete of the whole collection.
mongoose.set('strictQuery', 'throw');

export type DatabaseFailureReason = 'unreachable' | 'indexes_missing';

/** Raised when the API cannot use the database. Its message never contains the URI. */
export class DatabaseUnavailableError extends Error {
  readonly reason: DatabaseFailureReason;

  constructor(reason: DatabaseFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseUnavailableError';
    this.reason = reason;
  }
}

/**
 * Single-flight connection cache. Concurrent callers share one in-flight
 * connect(); a success is reused for the life of the process (a warm Vercel
 * Fluid instance serves many requests); a failure is NOT cached, so the next
 * request retries instead of the instance staying broken.
 */
export function createConnectionCache<A extends unknown[], T>(
  open: (...args: A) => Promise<T>,
  cache: { promise?: Promise<T> | undefined } = {},
) {
  return {
    connect(...args: A): Promise<T> {
      cache.promise ??= open(...args).catch((error: unknown) => {
        cache.promise = undefined;
        throw error;
      });
      return cache.promise;
    },
    reset(): void {
      cache.promise = undefined;
    },
  };
}

interface IndexedModel {
  collection: { collectionName: string };
  diffIndexes(): Promise<{ toCreate: unknown[]; toDrop: unknown[] }>;
}

/**
 * With autoIndex disabled (production), refuse to serve if declared indexes are
 * missing: without the unique email_1 index duplicate accounts could be created.
 * Build them with `npm run db:indexes -- --apply`.
 */
export async function assertIndexesInSync(models: readonly IndexedModel[]): Promise<void> {
  const missing: string[] = [];
  for (const model of models) {
    const { toCreate, toDrop } = await model.diffIndexes();
    const name = model.collection.collectionName;
    missing.push(...toCreate.map((index) => `${name} ${JSON.stringify(index)}`));
    if (toDrop.length > 0) {
      console.warn(
        `Undeclared indexes on ${name}: ${JSON.stringify(toDrop)} (see npm run db:indexes)`,
      );
    }
  }
  if (missing.length > 0) {
    throw new DatabaseUnavailableError(
      'indexes_missing',
      `Missing indexes: ${missing.join('; ')}. Run "npm run db:indexes -- --apply" first.`,
    );
  }
}

export interface ConnectBehaviour {
  /** Verify declared indexes exist when autoIndex is off (default). Disabled by the index tool itself. */
  verifyIndexes?: boolean;
}

async function openConnection(
  uri: string,
  options: ConnectOptions,
  behaviour: ConnectBehaviour,
): Promise<typeof mongoose> {
  const autoIndex = options.autoIndex ?? env.mongoAutoIndex;
  let instance: typeof mongoose;
  try {
    instance = await mongoose.connect(uri, {
      autoIndex,
      // Small pool per function instance: Fluid compute runs many instances, and
      // Atlas tiers cap total connections (M0: 500).
      maxPoolSize: env.mongoMaxPoolSize,
      // Lets idle sockets close; attachDatabasePool keeps the instance alive just
      // long enough for that before it suspends.
      maxIdleTimeMS: 10_000,
      serverSelectionTimeoutMS: 10_000,
      ...options,
    });
  } catch (error) {
    throw new DatabaseUnavailableError('unreachable', 'Could not connect to MongoDB', {
      cause: error,
    });
  }

  // Vercel Fluid compute: release idle pooled connections before the instance
  // suspends. A no-op outside Vercel (it checks VERCEL_URL / VERCEL_REGION).
  attachDatabasePool(instance.connection.getClient());

  if (!autoIndex && behaviour.verifyIndexes !== false) {
    try {
      await assertIndexesInSync([User, Note, Post]);
    } catch (error) {
      await mongoose.disconnect().catch(() => undefined);
      throw error;
    }
  }
  return instance;
}

// Kept on globalThis so a re-evaluated module (dev reloads, test isolation)
// still sees the existing connection instead of opening another one.
const globalCache = globalThis as typeof globalThis & {
  __secureNotesMongo?: { promise?: Promise<typeof mongoose> };
};
const connection = createConnectionCache(openConnection, (globalCache.__secureNotesMongo ??= {}));

/** Returns the shared connection, opening it on first use (cold start). */
export function connectDatabase(
  uri: string = env.mongoUri,
  options: ConnectOptions = {},
  behaviour: ConnectBehaviour = {},
): Promise<typeof mongoose> {
  return connection.connect(uri, options, behaviour);
}

export async function disconnectDatabase(): Promise<void> {
  connection.reset();
  await mongoose.disconnect();
}

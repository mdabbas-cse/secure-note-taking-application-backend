import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, inject } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Note } from '../src/models/Note.model.js';
import { Post } from '../src/models/Post.model.js';
import { User } from '../src/models/User.model.js';

beforeAll(async () => {
  await connectDatabase(inject('mongoUri'), {
    dbName: `test_${randomUUID().replaceAll('-', '')}`,
    // Emits commandStarted events so tests can count real DB round trips.
    monitorCommands: true,
  });
  // Wait for schema indexes to be built before any test runs.
  await Promise.all([User.init(), Note.init(), Post.init()]);
});

afterEach(async () => {
  await Promise.all([User.deleteMany({}), Note.deleteMany({}), Post.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

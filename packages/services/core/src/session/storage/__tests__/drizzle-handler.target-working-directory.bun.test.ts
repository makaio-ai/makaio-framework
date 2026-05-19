/**
 * Tests for targetWorkingDirectory field persistence in Drizzle handler.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from '../namespace.js';
import { createSession, createTestDb } from './shared.js';

describe('registerDrizzleSessionStorage - targetWorkingDirectory', () => {
  let cleanup: (() => void) | undefined;

  beforeEach(async () => {
    const ctx = await createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('should persist and retrieve targetWorkingDirectory', async () => {
    const session = createSession({
      sessionId: 'cwd-test',
      targetWorkingDirectory: '/home/user/project',
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'cwd-test',
    });

    expect(retrieved.session?.targetWorkingDirectory).toBe('/home/user/project');
  });

  it('should handle undefined targetWorkingDirectory', async () => {
    const session = createSession({
      sessionId: 'no-cwd-test',
      targetWorkingDirectory: undefined,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'no-cwd-test',
    });

    expect(retrieved.session?.targetWorkingDirectory).toBeUndefined();
  });
});

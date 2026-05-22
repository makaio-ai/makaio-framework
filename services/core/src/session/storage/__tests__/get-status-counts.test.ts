/**
 * Tests for getStatusCounts handler.
 */
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from '../namespace.js';
import { useDrizzleTestLifecycle } from './shared.js';

describe('getStatusCounts', () => {
  const ctx = useDrizzleTestLifecycle();

  it('should return zero counts when no sessions exist', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.getStatusCounts, {});

    expect(result).toEqual({
      all: 0,
      active: 0,
      closed: 0,
      archived: 0,
      discovered: 0,
    });
  });

  it('should count sessions by status', async () => {
    // Create 3 active, 2 closed, and 1 archived sessions
    await ctx.db.run(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status)
      VALUES
        ('active-1', 1000, 1000, 'active'),
        ('active-2', 2000, 2000, 'active'),
        ('active-3', 3000, 3000, 'active'),
        ('closed-1', 4000, 4000, 'closed'),
        ('closed-2', 5000, 5000, 'closed'),
        ('archived-1', 6000, 6000, 'archived')
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.getStatusCounts, {});

    expect(result).toEqual({
      all: 6,
      active: 3,
      closed: 2,
      archived: 1,
      discovered: 0,
    });
  });

  it('should handle all active sessions', async () => {
    await ctx.db.run(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status)
      VALUES
        ('active-1', 1000, 1000, 'active'),
        ('active-2', 2000, 2000, 'active')
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.getStatusCounts, {});

    expect(result).toEqual({
      all: 2,
      active: 2,
      closed: 0,
      archived: 0,
      discovered: 0,
    });
  });

  it('should handle all closed sessions', async () => {
    await ctx.db.run(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status)
      VALUES
        ('closed-1', 1000, 1000, 'closed'),
        ('closed-2', 2000, 2000, 'closed')
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.getStatusCounts, {});

    expect(result).toEqual({
      all: 2,
      active: 0,
      closed: 2,
      archived: 0,
      discovered: 0,
    });
  });
});

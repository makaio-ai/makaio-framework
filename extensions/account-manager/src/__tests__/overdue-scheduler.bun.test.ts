import { describe, it, expect } from 'bun:test';
import { OverdueScheduler, type SchedulableTarget } from '../utils/overdue-scheduler.js';

const MIN = 60_000;
const FIFTEEN_MIN = 15 * MIN;

/**
 * Builds a schedulable target with defaults so tests stay focused on the
 * fields that matter for each case.
 * @param over - Per-field overrides.
 * @returns A populated {@link SchedulableTarget} for `string` keys.
 */
function target(over: Partial<SchedulableTarget<string>> & { key: string }): SchedulableTarget<string> {
  return {
    key: over.key,
    lastFetchAt: over.lastFetchAt ?? 0,
    targetIntervalMs: over.targetIntervalMs ?? MIN,
    priority: over.priority,
  };
}

describe('OverdueScheduler', () => {
  it('returns null when nothing is due', () => {
    const scheduler = new OverdueScheduler();
    const now = 10 * MIN;
    const chosen = scheduler.pick([target({ key: 'a', lastFetchAt: now - 30_000, targetIntervalMs: MIN })], now);
    expect(chosen).toBeNull();
  });

  it('picks the most overdue target when multiple are due', () => {
    const scheduler = new OverdueScheduler();
    const now = 10 * MIN;
    const chosen = scheduler.pick(
      [
        target({ key: 'a', lastFetchAt: now - MIN, targetIntervalMs: MIN }), // score 1.0
        target({ key: 'b', lastFetchAt: now - 2 * MIN, targetIntervalMs: MIN }), // score 2.0
      ],
      now,
    );
    expect(chosen?.key).toBe('b');
  });

  it('prefers active over inactive when they are equally overdue', () => {
    const scheduler = new OverdueScheduler();
    const now = 20 * MIN;
    // Active (60s target) due exactly once; inactive (15min target) due exactly once — same score 1.0.
    const chosen = scheduler.pick(
      [
        target({ key: 'inactive', lastFetchAt: now - FIFTEEN_MIN, targetIntervalMs: FIFTEEN_MIN, priority: 1 }),
        target({ key: 'active', lastFetchAt: now - MIN, targetIntervalMs: MIN, priority: 2 }),
      ],
      now,
    );
    expect(chosen?.key).toBe('active');
  });

  it('falls back to oldest lastFetchAt on score + priority ties', () => {
    const scheduler = new OverdueScheduler();
    // Picking a now that makes both equally overdue in absolute ms terms is
    // impossible with differing lastFetchAt *and* equal scores, so we force
    // the score tie via different target intervals: older lastFetchAt with a
    // longer interval produces the same 1.0x score as newer lastFetchAt with
    // a shorter interval.
    const now = 30 * MIN;
    const chosen = scheduler.pick(
      [
        target({ key: 'newer', lastFetchAt: now - MIN, targetIntervalMs: MIN, priority: 2 }),
        target({ key: 'older', lastFetchAt: now - FIFTEEN_MIN, targetIntervalMs: FIFTEEN_MIN, priority: 2 }),
      ],
      now,
    );
    expect(chosen?.key).toBe('older');
  });

  it('lets inactive steal a slot once it is further overdue than active', () => {
    const scheduler = new OverdueScheduler();
    // Minute 17 in the user's worked example: active scored 1.0, inactive scored 17/15 ≈ 1.13.
    const now = 17 * MIN;
    const chosen = scheduler.pick(
      [
        target({ key: 'active', lastFetchAt: now - MIN, targetIntervalMs: MIN, priority: 2 }),
        target({ key: 'inactive', lastFetchAt: 0, targetIntervalMs: FIFTEEN_MIN, priority: 1 }),
      ],
      now,
    );
    expect(chosen?.key).toBe('inactive');
  });

  it('treats never-fetched targets as most overdue', () => {
    const scheduler = new OverdueScheduler();
    const now = 5 * MIN;
    const chosen = scheduler.pick(
      [
        target({ key: 'fresh', lastFetchAt: now - 2 * MIN, targetIntervalMs: MIN }),
        target({ key: 'cold', lastFetchAt: 0, targetIntervalMs: MIN }),
      ],
      now,
    );
    expect(chosen?.key).toBe('cold');
  });
});

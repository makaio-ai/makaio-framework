import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAutomationCronScheduler } from '../local-cron-scheduler.js';

/** Canonical binding key of a once-per-minute UTC cron binding. */
const EVERY_MINUTE_KEY = 'makaio.cron:{"schedule":"* * * * *","timezone":"UTC"}';

describe('LocalAutomationCronScheduler', () => {
  let scheduler: LocalAutomationCronScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new LocalAutomationCronScheduler();
  });

  afterEach(async () => {
    await scheduler.shutdown();
    vi.useRealTimers();
  });

  it('fires the schedule and stops firing after cleanup', async () => {
    const onFire = vi.fn(async () => {});

    const cleanup = await scheduler.schedule({
      bindingKey: EVERY_MINUTE_KEY,
      schedule: '* * * * *',
      timezone: 'UTC',
      emit: onFire,
    });
    expect(scheduler.activeScheduleCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFire).toHaveBeenCalledWith({ scheduledFor: expect.any(Number) });

    await cleanup();
    expect(scheduler.activeScheduleCount()).toBe(0);

    const firingsBeforeAdvance = onFire.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onFire.mock.calls.length).toBe(firingsBeforeAdvance);
  });

  it('reports the scheduled occurrence, not the moment the firing was served', async () => {
    // The clock jumps forward while the job's timer is pending, so the callback
    // runs well past the minute it belongs to — the same shape a saturated event
    // loop produces. `scheduledFor` must still name the occurrence, because every
    // consumer of the payload treats it as the moment the schedule was due.
    vi.setSystemTime(new Date('2026-01-01T12:00:30.000Z'));
    const scheduledFor: number[] = [];

    await scheduler.schedule({
      bindingKey: EVERY_MINUTE_KEY,
      schedule: '* * * * *',
      timezone: 'UTC',
      emit: async (payload) => void scheduledFor.push(payload.scheduledFor),
    });

    vi.setSystemTime(new Date('2026-01-01T12:01:07.500Z'));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(scheduledFor.length).toBeGreaterThan(0);
    expect(scheduledFor.map((value) => new Date(value).toISOString())).toEqual(
      scheduledFor.map((_value, index) => `2026-01-01T12:0${index + 1}:00.000Z`),
    );
    // The firing was genuinely late: without that the assertion above would hold
    // for a timestamp read off the clock as well.
    expect(Date.now()).toBeGreaterThan(scheduledFor[scheduledFor.length - 1] + 1_000);
  });

  it('is idempotent on repeated cleanup', async () => {
    const cleanup = await scheduler.schedule({
      bindingKey: EVERY_MINUTE_KEY,
      schedule: '* * * * *',
      timezone: 'UTC',
      emit: async () => {},
    });

    // A second cleanup must neither throw nor cancel a later job that reused the
    // same binding key; the test fails on any thrown error.
    await cleanup();
    await cleanup();
    expect(scheduler.activeScheduleCount()).toBe(0);
  });

  it('rejects an invalid cron expression without registering a job', async () => {
    await expect(
      scheduler.schedule({
        bindingKey: 'makaio.cron:{"schedule":"not-a-cron","timezone":"UTC"}',
        schedule: 'not-a-cron',
        timezone: 'UTC',
        emit: async () => {},
      }),
    ).rejects.toThrow(/not-a-cron/);
    expect(scheduler.activeScheduleCount()).toBe(0);
  });

  it('rejects an unknown timezone without registering a job', async () => {
    const bindingKey = 'makaio.cron:{"schedule":"* * * * *","timezone":"Invalid/Timezone"}';

    // Asserted on the wrapped wording, which names the requesting binding: croner
    // accepts an unknown timezone at construction and only rejects it once an
    // occurrence is resolved, so a validator that stops at construction would let
    // this through and surface a raw croner error from deeper in instead. The raw
    // message also contains the zone name, so matching only on that would pass
    // either way.
    await expect(
      scheduler.schedule({
        bindingKey,
        schedule: '* * * * *',
        timezone: 'Invalid/Timezone',
        emit: async () => {},
      }),
    ).rejects.toThrow(`Invalid cron schedule '* * * * *' in timezone 'Invalid/Timezone' for binding '${bindingKey}'`);
    expect(scheduler.activeScheduleCount()).toBe(0);
  });

  it('keeps both schedules when the same binding key is scheduled twice', async () => {
    // The binding runtime may hold a retiring and a fresh activation of one key
    // at the same time, so the key must not act as a unique index that silently
    // drops — or orphans — one of the two jobs.
    const first = await scheduler.schedule({
      bindingKey: EVERY_MINUTE_KEY,
      schedule: '* * * * *',
      timezone: 'UTC',
      emit: async () => {},
    });
    await scheduler.schedule({
      bindingKey: EVERY_MINUTE_KEY,
      schedule: '* * * * *',
      timezone: 'UTC',
      emit: async () => {},
    });
    expect(scheduler.activeScheduleCount()).toBe(2);

    await first();
    expect(scheduler.activeScheduleCount()).toBe(1);
  });

  it('cancels every schedule on shutdown', async () => {
    const onFire = vi.fn(async () => {});
    await scheduler.schedule({
      bindingKey: EVERY_MINUTE_KEY,
      schedule: '* * * * *',
      timezone: 'UTC',
      emit: onFire,
    });
    await scheduler.schedule({
      bindingKey: 'makaio.cron:{"schedule":"*/2 * * * *","timezone":"UTC"}',
      schedule: '*/2 * * * *',
      timezone: 'UTC',
      emit: onFire,
    });

    await scheduler.shutdown();
    expect(scheduler.activeScheduleCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('logs a failing emit instead of letting it escape the job', async () => {
    const error = new Error('listener exploded');
    const emit = vi.fn(async () => {
      throw error;
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await scheduler.schedule({
        bindingKey: EVERY_MINUTE_KEY,
        schedule: '* * * * *',
        timezone: 'UTC',
        emit,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.stringContaining(EVERY_MINUTE_KEY), error));
      expect(scheduler.activeScheduleCount()).toBe(1);
    } finally {
      logged.mockRestore();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { createJsonlTransport } from '../jsonl-transport.js';
import {
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_EXIT_OBSERVATION_MS,
  DEFAULT_KILL_GRACE_MS,
  processStopBudgetMs,
} from '../stop-budget.js';

describe('processStopBudgetMs', () => {
  it('is the sum of the three bounded phases under the defaults', () => {
    expect(processStopBudgetMs()).toBe(DEFAULT_KILL_GRACE_MS + DEFAULT_EXIT_OBSERVATION_MS + DEFAULT_DRAIN_TIMEOUT_MS);
  });

  it('replaces only the phases the timing names', () => {
    expect(processStopBudgetMs({ killGraceMs: 10_000 })).toBe(
      10_000 + DEFAULT_EXIT_OBSERVATION_MS + DEFAULT_DRAIN_TIMEOUT_MS,
    );
    expect(processStopBudgetMs({ killGraceMs: 10, exitObservationMs: 2, drainTimeoutMs: 3 })).toBe(15);
  });

  it('covers a Windows stop whose taskkill outlasts a short kill grace', () => {
    // taskkill (bounded by the observation time), then the observation, then the drain.
    expect(processStopBudgetMs({ killGraceMs: 1, exitObservationMs: 2, drainTimeoutMs: 3 })).toBe(2 + 2 + 3);
  });

  it('treats an undefined field like an omitted one', () => {
    expect(processStopBudgetMs({ killGraceMs: undefined })).toBe(processStopBudgetMs());
  });

  it('rejects a timing the transport itself would reject', () => {
    expect(() => processStopBudgetMs({ killGraceMs: -1 })).toThrow(RangeError);
    expect(() => processStopBudgetMs({ drainTimeoutMs: Number.NaN })).toThrow(RangeError);
  });

  it('bounds a real stop: a child that ignores SIGTERM ends within the budget', async () => {
    const timing = { killGraceMs: 150, exitObservationMs: 500, drainTimeoutMs: 500 };
    const transport = createJsonlTransport({
      command: process.execPath,
      args: [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('{\"up\":true}\\n'); setInterval(() => {}, 1000);",
      ],
      cwd: process.cwd(),
      onStdoutEnd: 'ignore',
      ...timing,
    });
    await new Promise<void>((resolve) => {
      const off = transport.onMessage(() => {
        off();
        resolve();
      });
    });

    const startedAt = Date.now();
    const end = await transport.close();

    expect(end.cause).toBe('requested');
    expect(Date.now() - startedAt).toBeLessThanOrEqual(processStopBudgetMs(timing));
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createElectrobunRestartHandler } from './restart-handler.js';

describe('createElectrobunRestartHandler', () => {
  it('accepts before scheduling relaunch and shutdown', () => {
    const relaunch = vi.fn();
    const shutdown = vi.fn();
    const order: string[] = [];
    const handler = createElectrobunRestartHandler({
      relaunch,
      shutdown,
      schedule: (task) => {
        order.push('schedule');
        task();
      },
    });

    handler({ setResult: () => order.push('setResult') });

    expect(order).toEqual(['setResult', 'schedule']);
    expect(relaunch).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('schedules relaunch only once for duplicate restart requests', () => {
    const scheduledTasks: (() => void)[] = [];
    const handler = createElectrobunRestartHandler({
      relaunch: vi.fn(),
      shutdown: vi.fn(),
      schedule: (task) => scheduledTasks.push(task),
    });

    handler({ setResult: vi.fn() });
    handler({ setResult: vi.fn() });

    expect(scheduledTasks).toHaveLength(1);
  });
});

import { describe, expect, it, mock } from 'bun:test';
import { createElectrobunRestartHandler } from './restart-handler.js';

describe('createElectrobunRestartHandler', () => {
  it('accepts before scheduling relaunch and shutdown', () => {
    const relaunch = mock();
    const shutdown = mock();
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
      relaunch: mock(),
      shutdown: mock(),
      schedule: (task) => scheduledTasks.push(task),
    });

    handler({ setResult: mock() });
    handler({ setResult: mock() });

    expect(scheduledTasks).toHaveLength(1);
  });
});

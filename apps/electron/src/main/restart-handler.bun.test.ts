import { describe, expect, it, mock } from 'bun:test';
import { createElectronRestartHandler } from './restart-handler.js';

describe('createElectronRestartHandler', () => {
  it('accepts before scheduling relaunch and quit', () => {
    const app = { relaunch: mock(), quit: mock() };
    const order: string[] = [];
    const handler = createElectronRestartHandler({
      app,
      schedule: (task) => {
        order.push('schedule');
        task();
      },
    });

    handler({ setResult: () => order.push('setResult') });

    expect(order).toEqual(['setResult', 'schedule']);
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('schedules relaunch only once for duplicate restart requests', () => {
    const app = { relaunch: mock(), quit: mock() };
    const scheduledTasks: (() => void)[] = [];
    const handler = createElectronRestartHandler({
      app,
      schedule: (task) => scheduledTasks.push(task),
    });

    handler({ setResult: mock() });
    handler({ setResult: mock() });

    expect(scheduledTasks).toHaveLength(1);
  });
});

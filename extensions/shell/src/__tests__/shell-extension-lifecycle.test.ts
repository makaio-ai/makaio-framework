import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ToolRegistry } from '@makaio/services-core/tools';
import { shellToolset, ShellService } from '../index.js';

describe('shell extension lifecycle', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('contributes shell tools and routes execution through the shell service', async () => {
    const registry = new ToolRegistry({ bus: MakaioBus });
    const service = new ShellService(MakaioBus);

    try {
      await service.init();
      await registry.register(shellToolset);
      const exec = await registry.execute('shell_exec', { command: 'node -e "process.exit(0)"', colors: false });
      expect(exec.success).toBe(true);
    } finally {
      await Promise.allSettled([service.destroy(), registry.deregister('shell')]);
    }
  });

  it('destroys running shell processes through the service-owned manager', async () => {
    const registry = new ToolRegistry({ bus: MakaioBus });
    const service = new ShellService(MakaioBus);

    let serviceDestroyed = false;
    try {
      await service.init();
      await registry.register(shellToolset);
      const exec = await registry.execute('shell_exec', {
        command: 'node -e "setTimeout(() => {}, 30000)"',
        colors: false,
      });
      expect(exec.success).toBe(true);

      await service.destroy();
      serviceDestroyed = true;
      const status = await registry.execute('shell_status', {
        shellId: exec.success ? (exec.data as { shellId: string }).shellId : 'missing',
      });
      expect(status.success).toBe(false);
    } finally {
      const cleanup = serviceDestroyed
        ? [registry.deregister('shell')]
        : [service.destroy(), registry.deregister('shell')];
      await Promise.allSettled(cleanup);
    }
  });
});

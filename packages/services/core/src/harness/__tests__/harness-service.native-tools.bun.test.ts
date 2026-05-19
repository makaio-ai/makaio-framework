import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import { HarnessSubjects, AdapterSubjects } from '@makaio/contracts';
import { HarnessService } from '../harness-service.js';
import { createHarness, createTestDb } from './shared.js';

describe('HarnessService – nativeTools validation', () => {
  let service: HarnessService;
  let cleanup: () => void;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    const ctx = await createTestDb();
    cleanup = ctx.cleanup;

    service = new HarnessService(MakaioBus);
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    cleanup();
    MakaioBus.__resetHandlers?.();
  });

  describe('with loaded adapter (codex-app-server)', () => {
    let adapterCleanup: () => void;

    beforeEach(() => {
      adapterCleanup = MakaioBus.on(AdapterSubjects.getCapabilities, (ctx) => {
        ctx.setResult({ capabilities: ['tools'], nativeTools: ['bash', 'patch'] });
      });
    });

    afterEach(() => {
      adapterCleanup();
    });

    it('accepts valid nativeTools names', async () => {
      const { id } = await MakaioBus.request(HarnessSubjects.set, {
        ...createHarness({
          name: 'Valid Tools Harness',
          adapterName: 'codex-app-server',
          nativeTools: { enabled: ['bash', 'patch'], disabled: [] },
        }),
      });

      expect(id).toBeTruthy();
    });

    it('accepts empty nativeTools lists', async () => {
      const { id } = await MakaioBus.request(HarnessSubjects.set, {
        ...createHarness({
          name: 'Empty Tools Harness',
          adapterName: 'codex-app-server',
          nativeTools: { enabled: [], disabled: [] },
        }),
      });

      expect(id).toBeTruthy();
    });

    it('rejects invalid tool name in enabled list with clear error', async () => {
      const error = await MakaioBus.request(HarnessSubjects.set, {
        ...createHarness({
          name: 'Invalid Enabled Harness',
          adapterName: 'codex-app-server',
          nativeTools: { enabled: ['bash', 'nonexistent_tool'], disabled: [] },
        }),
      }).catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(RequestError);
      if (error instanceof RequestError) {
        expect((error.cause as Error).message).toContain("Tool 'nonexistent_tool' not found");
        expect((error.cause as Error).message).toContain("adapter 'codex-app-server'");
        expect((error.cause as Error).message).toContain('bash');
        expect((error.cause as Error).message).toContain('patch');
      }
    });

    it('rejects invalid tool name in disabled list with clear error', async () => {
      const error = await MakaioBus.request(HarnessSubjects.set, {
        ...createHarness({
          name: 'Invalid Disabled Harness',
          adapterName: 'codex-app-server',
          nativeTools: { enabled: [], disabled: ['stale_tool'] },
        }),
      }).catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(RequestError);
      if (error instanceof RequestError) {
        expect((error.cause as Error).message).toContain("Tool 'stale_tool' not found");
        expect((error.cause as Error).message).toContain("adapter 'codex-app-server'");
      }
    });
  });

  describe('without loaded adapter', () => {
    it('skips validation when no adapter capabilities handler is registered', async () => {
      // No adapter.getCapabilities handler registered — requestOptional returns handled: false.
      const { id } = await MakaioBus.request(HarnessSubjects.set, {
        ...createHarness({
          name: 'Offline Adapter Harness',
          adapterName: 'openai-node',
          nativeTools: { enabled: ['imaginary_tool'], disabled: [] },
        }),
      });

      expect(id).toBeTruthy();
    });
  });
});

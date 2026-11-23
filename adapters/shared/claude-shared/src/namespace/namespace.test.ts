import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { busContextOf } from '@makaio/bus-core/kernel-api';
import { createTestCall } from '@makaio/test-utils';
import { createClaudeConnectorNamespace, type SDKMessage } from './index.js';

describe('createClaudeConnectorNamespace', () => {
  beforeEach(() => {
    busContextOf(MakaioBus).namespaceRegistry.__resetNamespaces?.();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts text fields from lenient schema violation samples', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const namespace = createClaudeConnectorNamespace(`adapter:claude-redaction-${crypto.randomUUID()}`);
    const bus = await namespace.scopedBus(MakaioBus);

    const payload: unknown = {
      type: 'unexpected',
      content: 'user prompt that should not be persisted in schema violation artifacts',
    };
    await bus.emit(createTestCall(), namespace.subjects.sdk.event, payload as SDKMessage);

    const warning = warnSpy.mock.calls.find(([message]) => String(message).startsWith('[BUS:VIOLATION]'))?.[0];
    expect(String(warning)).toContain('"content":"[redacted-text]"');
    expect(String(warning)).not.toContain('user prompt that should not be persisted');
  });

  it('allows callers to override validation options', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const namespace = createClaudeConnectorNamespace(`adapter:claude-skip-${crypto.randomUUID()}`, {
      busValidationMode: 'skip',
    });
    const bus = await namespace.scopedBus(MakaioBus);

    const payload: unknown = { type: 'unexpected' };
    await bus.emit(createTestCall(), namespace.subjects.sdk.event, payload as SDKMessage);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

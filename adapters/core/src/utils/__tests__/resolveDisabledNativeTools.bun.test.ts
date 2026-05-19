/// <reference types="bun-types" />
import { describe, expect, it, spyOn } from 'bun:test';
import { HarnessSubjects, type HarnessDefinition } from '@makaio/contracts';
import { resolveDisabledNativeTools, type HarnessRequester } from '../resolveDisabledNativeTools.js';

/**
 * Minimal harness fixture for use in tests.
 * @param overrides - Optional partial harness fields to override defaults
 */
function makeHarness(overrides: Partial<HarnessDefinition> = {}): HarnessDefinition {
  return {
    id: 'h1',
    name: 'Test Harness',
    adapterName: 'gemini-sdk',
    approvalPolicy: 'always-ask',
    nativeTools: { enabled: [], disabled: ['patch', 'bash'] },
    registryTools: { enabled: [], disabled: [] },
    isDefault: true,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Creates a typed mock requester for use in tests.
 * @param responses - Mock responses keyed by subject name
 */
function makeMockRequester(
  responses: Partial<{
    get: { handled: false } | { handled: true; data: HarnessDefinition };
    getDefault: { handled: false } | { handled: true; data: HarnessDefinition };
  }>,
): HarnessRequester {
  const requester: HarnessRequester = {
    requestOptional: async (
      subject: typeof HarnessSubjects.get | typeof HarnessSubjects.getDefault,
      _payload: { id: string } | { adapterName?: string; clientId?: string },
    ) => {
      if (subject === HarnessSubjects.get) {
        return responses.get ?? { handled: false };
      }
      return responses.getDefault ?? { handled: false };
    },
  };
  spyOn(requester, 'requestOptional');
  return requester;
}

describe('resolveDisabledNativeTools', () => {
  it('returns disabled tool names via default harness lookup when no harnessId', async () => {
    const requester = makeMockRequester({
      getDefault: { handled: true, data: makeHarness() },
    });

    const disabled = await resolveDisabledNativeTools(requester, 'gemini-sdk');

    expect(disabled).toEqual(['patch', 'bash']);
    expect(requester.requestOptional).toHaveBeenCalledWith(HarnessSubjects.getDefault, {
      adapterName: 'gemini-sdk',
    });
  });

  it('returns an empty array when harness service is not registered (no harnessId)', async () => {
    const requester = makeMockRequester({ getDefault: { handled: false } });

    const disabled = await resolveDisabledNativeTools(requester, 'codex-app-server');

    expect(disabled).toEqual([]);
    expect(requester.requestOptional).toHaveBeenCalledWith(HarnessSubjects.getDefault, {
      adapterName: 'codex-app-server',
    });
  });

  it('uses explicit harnessId lookup when provided', async () => {
    const requester = makeMockRequester({
      get: { handled: true, data: makeHarness({ nativeTools: { enabled: [], disabled: ['shell'] } }) },
    });

    const disabled = await resolveDisabledNativeTools(requester, 'gemini-sdk', 'h-explicit');

    expect(disabled).toEqual(['shell']);
    expect(requester.requestOptional).toHaveBeenCalledWith(HarnessSubjects.get, { id: 'h-explicit' });
    expect(requester.requestOptional).not.toHaveBeenCalledWith(HarnessSubjects.getDefault, expect.anything());
  });

  it('returns an empty array when harness service is not registered (explicit harnessId)', async () => {
    const requester = makeMockRequester({ get: { handled: false } });

    const disabled = await resolveDisabledNativeTools(requester, 'gemini-sdk', 'h-explicit');

    expect(disabled).toEqual([]);
    expect(requester.requestOptional).toHaveBeenCalledWith(HarnessSubjects.get, { id: 'h-explicit' });
  });

  it('prefers explicit harnessId lookup when both harnessId and clientId are provided', async () => {
    const requester = makeMockRequester({
      get: { handled: true, data: makeHarness({ nativeTools: { enabled: [], disabled: ['shell'] } }) },
      getDefault: { handled: true, data: makeHarness({ nativeTools: { enabled: [], disabled: ['patch'] } }) },
    });

    const disabled = await resolveDisabledNativeTools(requester, 'gemini-sdk', 'h-explicit', 'claude-code');

    expect(disabled).toEqual(['shell']);
    expect(requester.requestOptional).toHaveBeenCalledWith(HarnessSubjects.get, { id: 'h-explicit' });
    expect(requester.requestOptional).not.toHaveBeenCalledWith(HarnessSubjects.getDefault, expect.anything());
  });

  it('passes clientId through the default harness lookup when provided', async () => {
    const requester = makeMockRequester({
      getDefault: { handled: true, data: makeHarness() },
    });

    await resolveDisabledNativeTools(requester, 'gemini-sdk', undefined, 'claude-code');

    expect(requester.requestOptional).toHaveBeenCalledWith(HarnessSubjects.getDefault, {
      adapterName: 'gemini-sdk',
      clientId: 'claude-code',
    });
  });
});

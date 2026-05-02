import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus, RequestError, ValidationError } from '@makaio/bus-core';
import { HarnessSubjects } from '@makaio/contracts';
import { HarnessService } from '../harness-service.js';
import { createHarness, createTestDb } from './shared.js';

describe('HarnessService', () => {
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

  it('resolves default harness for client-backed adapter', async () => {
    const harness = await MakaioBus.request(HarnessSubjects.getDefault, {
      clientId: 'codex',
    });

    expect(harness.clientId).toBe('codex');
    expect(harness.isDefault).toBe(true);
  });

  it('prefers persona harness over profile harness during resolve', async () => {
    const { id: profileHarnessId } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Profile Harness',
        adapterName: 'codex-app-server',
        isDefault: false,
      }),
    });

    const { id: personaHarnessId } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Persona Harness',
        adapterName: 'codex-app-server',
        approvalPolicy: 'full-access',
        isDefault: false,
      }),
    });

    const resolved = await MakaioBus.request(HarnessSubjects.resolve, {
      adapterName: 'codex-app-server',
      personaHarnessId,
      profileHarnessId,
    });

    expect(resolved.id).toBe(personaHarnessId);
    expect(resolved.approvalPolicy).toBe('full-access');
  });

  it('falls back to profile harness, then adapter default', async () => {
    const { id: profileHarnessId } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Profile Only',
        adapterName: 'codex-app-server',
        approvalPolicy: 'reject',
        isDefault: false,
      }),
    });

    const resolvedFromProfile = await MakaioBus.request(HarnessSubjects.resolve, {
      adapterName: 'codex-app-server',
      profileHarnessId,
    });
    expect(resolvedFromProfile.id).toBe(profileHarnessId);

    const resolvedDefault = await MakaioBus.request(HarnessSubjects.resolve, {
      adapterName: 'codex-app-server',
      clientId: 'codex',
    });
    expect(resolvedDefault.isDefault).toBe(true);
  });

  it('rejects resolve when persona harness belongs to a different adapter', async () => {
    const { id: personaHarnessId } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'OpenAI Persona Harness',
        adapterName: 'openai-node',
        isDefault: false,
      }),
    });

    const error = await MakaioBus.request(HarnessSubjects.resolve, {
      adapterName: 'codex-app-server',
      personaHarnessId,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(RequestError);
    if (error instanceof RequestError) {
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toContain('adapter mismatch');
    }
  });

  it('rejects resolve when client-scoped persona harness belongs to a different client', async () => {
    const { id: personaHarnessId } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Codex Client Persona',
        adapterName: undefined,
        clientId: 'codex',
        isDefault: false,
      }),
    });

    const error = await MakaioBus.request(HarnessSubjects.resolve, {
      adapterName: 'claude-code',
      clientId: 'claude-code',
      personaHarnessId,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(RequestError);
    if (error instanceof RequestError) {
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toContain('client mismatch');
    }
  });

  it('accepts resolve when client-scoped persona harness matches the requesting client', async () => {
    const { id: personaHarnessId } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Claude Client Persona',
        adapterName: undefined,
        clientId: 'claude-code',
        isDefault: false,
      }),
    });

    const resolved = await MakaioBus.request(HarnessSubjects.resolve, {
      adapterName: 'claude-code',
      clientId: 'claude-code',
      personaHarnessId,
    });

    expect(resolved.id).toBe(personaHarnessId);
  });

  it('rejects resolve when harness has both adapterName and clientId set but clientId mismatches', async () => {
    // A harness scoped to both adapterName and clientId must validate BOTH fields.
    // This test ensures the adapterName match does not short-circuit the clientId check.
    const { id: personaHarnessId } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Dual-Scope Persona',
        adapterName: 'codex-app-server',
        clientId: 'codex',
        isDefault: false,
      }),
    });

    const error = await MakaioBus.request(HarnessSubjects.resolve, {
      adapterName: 'codex-app-server',
      clientId: 'other-client',
      personaHarnessId,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(RequestError);
    if (error instanceof RequestError) {
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toContain('client mismatch');
    }
  });

  it('accepts resolve of client-scoped harness when caller omits clientId (backward compat)', async () => {
    const { id: personaHarnessId } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Compat Client Persona',
        adapterName: undefined,
        clientId: 'codex',
        isDefault: false,
      }),
    });

    const resolved = await MakaioBus.request(HarnessSubjects.resolve, {
      adapterName: 'codex-app-server',
      personaHarnessId,
    });

    expect(resolved.id).toBe(personaHarnessId);
  });

  it('rejects resolve when explicit persona or profile harness is disabled', async () => {
    const { id: disabledPersonaId } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Disabled Persona Harness',
        adapterName: 'codex-app-server',
        enabled: false,
        isDefault: false,
      }),
    });

    const personaError = await MakaioBus.request(HarnessSubjects.resolve, {
      adapterName: 'codex-app-server',
      personaHarnessId: disabledPersonaId,
    }).catch((failure: unknown) => failure);

    expect(personaError).toBeInstanceOf(RequestError);
    if (personaError instanceof RequestError) {
      expect(personaError.cause).toBeInstanceOf(Error);
      expect((personaError.cause as Error).message).toContain('disabled');
    }

    const { id: disabledProfileId } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Disabled Profile Harness',
        adapterName: 'codex-app-server',
        enabled: false,
        isDefault: false,
      }),
    });

    const profileError = await MakaioBus.request(HarnessSubjects.resolve, {
      adapterName: 'codex-app-server',
      profileHarnessId: disabledProfileId,
    }).catch((failure: unknown) => failure);

    expect(profileError).toBeInstanceOf(RequestError);
    if (profileError instanceof RequestError) {
      expect(profileError.cause).toBeInstanceOf(Error);
      expect((profileError.cause as Error).message).toContain('disabled');
    }
  });

  it('requires adapterName for name-based get lookups', async () => {
    const error = await MakaioBus.request(HarnessSubjects.get, {
      name: 'Codex Native',
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ValidationError);
    if (error instanceof ValidationError) {
      expect(error.message).toContain('adapterName is required');
    }
  });

  it('treats id as authoritative during get lookup', async () => {
    await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Known Harness',
        adapterName: 'codex-app-server',
      }),
    });

    const error = await MakaioBus.request(HarnessSubjects.get, {
      id: 'missing-id',
      name: 'Known Harness',
      adapterName: 'codex-app-server',
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(RequestError);
    if (error instanceof RequestError) {
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toContain('Harness not found');
    }
  });

  it('uses stable ids to avoid concurrent set races for same adapter/name', async () => {
    const payload = {
      ...createHarness({
        name: 'Concurrent Harness',
        adapterName: 'codex-app-server',
        approvalPolicy: 'always-ask',
      }),
    };

    const [first, second] = await Promise.all([
      MakaioBus.request(HarnessSubjects.set, payload),
      MakaioBus.request(HarnessSubjects.set, payload),
    ]);

    expect(first.id).toBe(second.id);

    const { harnesses } = await MakaioBus.request(HarnessSubjects.list, {
      adapterName: 'codex-app-server',
      name: 'Concurrent Harness',
    });
    expect(harnesses).toHaveLength(1);
    expect(harnesses[0]?.id).toBe(first.id);
  });

  it('preserves persisted flags when omitted by set payload', async () => {
    const { id } = await MakaioBus.request(HarnessSubjects.set, {
      ...createHarness({
        name: 'Preserve Flags Harness',
        adapterName: 'codex-app-server',
        approvalPolicy: 'full-access',
        enabled: false,
        isDefault: true,
      }),
    });

    await MakaioBus.request(HarnessSubjects.set, {
      name: 'Preserve Flags Harness',
      description: 'updated description',
      adapterName: 'codex-app-server',
      nativeTools: { enabled: ['bash'], disabled: [] },
      registryTools: { enabled: [], disabled: [] },
    });

    const updated = await MakaioBus.request(HarnessSubjects.get, { id });
    expect(updated.approvalPolicy).toBe('full-access');
    expect(updated.enabled).toBe(false);
    expect(updated.isDefault).toBe(true);
    expect(updated.description).toBe('updated description');
  });
});

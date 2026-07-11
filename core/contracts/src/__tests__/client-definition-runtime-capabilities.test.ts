/**
 * Tests for runtime capability flags in `createClientDefinition()` and
 * `ClientDefinitionSchema`.
 *
 * Verifies that:
 * - All capability flags default to `false` when omitted.
 * - Individual flags can be opted into independently.
 * - The frozen definition still carries the correct flags.
 * - Unrecognised flag keys are stripped (strict schema boundary).
 * - The `hookEvents` refine constraint is enforced (RO-3).
 */
import { describe, expect, it } from 'vitest';
import {
  ClientDefinitionSchema,
  ClientRuntimeCapabilitiesSchema,
  createClientDefinition,
  type ClientDefinitionInput,
} from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeMinimalInput(overrides?: Partial<ClientDefinitionInput>): ClientDefinitionInput {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    version: '0.1.0',
    authMethods: [],
    defaultApprovalPolicy: 'always-ask',
    ...overrides,
  };
}

const MANAGED_INSTALL_DESCRIPTOR = {
  type: 'npm',
  package: '@anthropic-ai/claude-code',
  version: '1.2.3',
} as const;

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe('ClientDefinitionSchema — runtimeCapabilities defaults', () => {
  it('applies false defaults to all capability flags when runtimeCapabilities is omitted', () => {
    const result = ClientDefinitionSchema.parse(makeMinimalInput());

    expect(result.runtimeCapabilities).toEqual({
      supportsHooks: false,
      supportsStatusline: false,
      supportsSupervisorLaunch: false,
      supportsManagedBinary: false,
      hookEvents: [],
    });
  });

  it('applies false defaults to all capability flags when runtimeCapabilities is an empty object', () => {
    const result = ClientDefinitionSchema.parse(makeMinimalInput({ runtimeCapabilities: {} }));

    expect(result.runtimeCapabilities).toEqual({
      supportsHooks: false,
      supportsStatusline: false,
      supportsSupervisorLaunch: false,
      supportsManagedBinary: false,
      hookEvents: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Individual flag opt-in
// ---------------------------------------------------------------------------

describe('ClientDefinitionSchema — individual runtime capability flags', () => {
  it('accepts supportsHooks: true independently', () => {
    const result = ClientDefinitionSchema.parse(makeMinimalInput({ runtimeCapabilities: { supportsHooks: true } }));

    expect(result.runtimeCapabilities.supportsHooks).toBe(true);
    expect(result.runtimeCapabilities.supportsStatusline).toBe(false);
    expect(result.runtimeCapabilities.supportsSupervisorLaunch).toBe(false);
    expect(result.runtimeCapabilities.supportsManagedBinary).toBe(false);
  });

  it('accepts supportsStatusline: true independently', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({ runtimeCapabilities: { supportsStatusline: true } }),
    );

    expect(result.runtimeCapabilities.supportsStatusline).toBe(true);
    expect(result.runtimeCapabilities.supportsHooks).toBe(false);
  });

  it('accepts supportsSupervisorLaunch: true independently', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({ runtimeCapabilities: { supportsSupervisorLaunch: true } }),
    );

    expect(result.runtimeCapabilities.supportsSupervisorLaunch).toBe(true);
    expect(result.runtimeCapabilities.supportsHooks).toBe(false);
  });

  it('accepts supportsManagedBinary: true with a managedInstall descriptor', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: MANAGED_INSTALL_DESCRIPTOR,
        versionCommand: { executable: 'bin/claude', args: ['--version'] },
      }),
    );

    expect(result.runtimeCapabilities.supportsManagedBinary).toBe(true);
    expect(result.runtimeCapabilities.supportsHooks).toBe(false);
  });

  it('accepts all capability flags set to true simultaneously', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: {
          supportsHooks: true,
          supportsStatusline: true,
          supportsSupervisorLaunch: true,
          supportsManagedBinary: true,
        },
        managedInstall: MANAGED_INSTALL_DESCRIPTOR,
        versionCommand: { executable: 'bin/claude', args: ['--version'] },
      }),
    );

    expect(result.runtimeCapabilities).toEqual({
      supportsHooks: true,
      supportsStatusline: true,
      supportsSupervisorLaunch: true,
      supportsManagedBinary: true,
      hookEvents: [],
    });
  });

  it('strips unrecognised flag keys', () => {
    const input: Record<string, unknown> = {
      ...makeMinimalInput(),
      runtimeCapabilities: { supportsHooks: true, unknownFlag: true },
    };
    const result = ClientDefinitionSchema.parse(input);
    expect(result.runtimeCapabilities).not.toHaveProperty('unknownFlag');
    expect(result.runtimeCapabilities.supportsHooks).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createClientDefinition integration
// ---------------------------------------------------------------------------

describe('createClientDefinition — runtime capability flags', () => {
  it('defaults all capability flags to false when runtimeCapabilities is omitted', () => {
    const definition = createClientDefinition({
      id: 'claude-code',
      name: 'Claude Code',
      version: '0.1.0',
      authMethods: [],
      defaultApprovalPolicy: 'always-ask',
    });

    expect(definition.runtimeCapabilities).toEqual({
      supportsHooks: false,
      supportsStatusline: false,
      supportsSupervisorLaunch: false,
      supportsManagedBinary: false,
      hookEvents: [],
    });
  });

  it('correctly sets opted-in capability flags and freezes the nested object', () => {
    const definition = createClientDefinition({
      id: 'claude-code',
      name: 'Claude Code',
      version: '0.1.0',
      authMethods: [],
      defaultApprovalPolicy: 'full-access',
      runtimeCapabilities: {
        supportsHooks: true,
        supportsStatusline: true,
        supportsSupervisorLaunch: true,
        supportsManagedBinary: true,
      },
      managedInstall: MANAGED_INSTALL_DESCRIPTOR,
      versionCommand: { executable: 'bin/claude', args: ['--version'] },
    });

    expect(definition.runtimeCapabilities.supportsHooks).toBe(true);
    expect(definition.runtimeCapabilities.supportsStatusline).toBe(true);
    expect(definition.runtimeCapabilities.supportsSupervisorLaunch).toBe(true);
    expect(definition.runtimeCapabilities.supportsManagedBinary).toBe(true);
    expect(Object.isFrozen(definition.runtimeCapabilities)).toBe(true);
  });

  it('sets only the specified flags and defaults the rest', () => {
    const definition = createClientDefinition({
      id: 'codex',
      name: 'Codex',
      version: '0.1.0',
      authMethods: [],
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: {
        supportsHooks: true,
      },
    });

    expect(definition.runtimeCapabilities.supportsHooks).toBe(true);
    expect(definition.runtimeCapabilities.supportsStatusline).toBe(false);
    expect(definition.runtimeCapabilities.supportsSupervisorLaunch).toBe(false);
    expect(definition.runtimeCapabilities.supportsManagedBinary).toBe(false);
  });

  it('produces a frozen top-level definition with frozen runtimeCapabilities', () => {
    const definition = createClientDefinition(makeMinimalInput());

    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.runtimeCapabilities)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hookEvents refine constraint (RO-3)
// ---------------------------------------------------------------------------

describe('ClientRuntimeCapabilitiesSchema — hookEvents refine constraint (RO-3)', () => {
  it('rejects hookEvents when supportsHooks is false', () => {
    const result = ClientRuntimeCapabilitiesSchema.safeParse({
      supportsHooks: false,
      hookEvents: [{ name: 'PreToolUse' }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('hookEvents must be empty when supportsHooks is false');
    }
  });

  it('rejects hookEvents on a definition where supportsHooks is false (ClientDefinitionSchema)', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: {
          supportsHooks: false,
          hookEvents: [{ name: 'PostToolUse', frameworkSubject: 'client.session.tool.post' }],
        },
      }),
    );

    expect(result.success).toBe(false);
  });

  it('accepts hookEvents when supportsHooks is true', () => {
    const result = ClientRuntimeCapabilitiesSchema.safeParse({
      supportsHooks: true,
      hookEvents: [{ name: 'PreToolUse' }, { name: 'PostToolUse', frameworkSubject: 'client.session.tool.post' }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hookEvents).toHaveLength(2);
      expect(result.data.hookEvents[0].name).toBe('PreToolUse');
      expect(result.data.hookEvents[1].frameworkSubject).toBe('client.session.tool.post');
    }
  });

  it('accepts empty hookEvents when supportsHooks is false', () => {
    const result = ClientRuntimeCapabilitiesSchema.safeParse({
      supportsHooks: false,
      hookEvents: [],
    });

    expect(result.success).toBe(true);
  });

  it('accepts empty hookEvents when supportsHooks is true', () => {
    const result = ClientRuntimeCapabilitiesSchema.safeParse({
      supportsHooks: true,
      hookEvents: [],
    });

    expect(result.success).toBe(true);
  });
});

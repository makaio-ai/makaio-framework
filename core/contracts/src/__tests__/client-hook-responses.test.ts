import { describe, it, expect } from 'vitest';
import {
  createAppendEffect,
  DEFAULT_FAILURE_POLICY,
  isValidContributorId,
  isValidTimeoutMs,
  validateClosedPolicy,
} from '@makaio/contracts/client';
import type {
  CanonicalAppendEffect,
  CapabilitySelector,
  ContributorDefinition,
  ContributorResponse,
  EventNameSelector,
  InteractionSelector,
  ProviderContractCatalogEntry,
  ProviderContributionEnvelope,
  RuntimeOutcome,
  ActivationValidationError,
} from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// 1. Contributor definition validates positive timeoutMs
// ---------------------------------------------------------------------------

describe('ContributorDefinition — timeoutMs validation', () => {
  it('accepts a positive timeoutMs', () => {
    expect(isValidTimeoutMs(5000)).toBe(true);
    expect(isValidTimeoutMs(1)).toBe(true);
    expect(isValidTimeoutMs(0.5)).toBe(true);
  });

  it('rejects zero timeoutMs', () => {
    expect(isValidTimeoutMs(0)).toBe(false);
  });

  it('rejects negative timeoutMs', () => {
    expect(isValidTimeoutMs(-100)).toBe(false);
  });

  it('rejects NaN timeoutMs', () => {
    expect(isValidTimeoutMs(NaN)).toBe(false);
  });

  it('rejects Infinity timeoutMs', () => {
    expect(isValidTimeoutMs(Infinity)).toBe(false);
    expect(isValidTimeoutMs(-Infinity)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Default failure policy is 'open'
// ---------------------------------------------------------------------------

describe('ContributorDefinition — default failure policy', () => {
  it('DEFAULT_FAILURE_POLICY is "open"', () => {
    expect(DEFAULT_FAILURE_POLICY).toBe('open');
  });

  it('a contributor definition without failurePolicy defaults to open', () => {
    const def: ContributorDefinition = {
      lane: 'canonical',
      id: 'test-contributor',
      priority: 10,
      timeoutMs: 5000,
      selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
      respond: () => ({ canonicalEffects: [] }),
    };
    expect(def.failurePolicy ?? DEFAULT_FAILURE_POLICY).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// 3. Canonical context.append produces the right effect shape
// ---------------------------------------------------------------------------

describe('Canonical context.append effect', () => {
  it('createAppendEffect produces a frozen CanonicalAppendEffect', () => {
    const effect = createAppendEffect('hello world');
    expect(effect.kind).toBe('context.append');
    expect(effect.value).toBe('hello world');
    expect(Object.isFrozen(effect)).toBe(true);
  });

  it('produces a valid CanonicalAppendEffect shape', () => {
    const effect: CanonicalAppendEffect = createAppendEffect('test');
    expect(effect).toEqual({ kind: 'context.append', value: 'test' });
  });

  it('handles empty string value', () => {
    const effect = createAppendEffect('');
    expect(effect.kind).toBe('context.append');
    expect(effect.value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 4. Provider contribution envelope requires clientId + contractId
// ---------------------------------------------------------------------------

describe('ProviderContributionEnvelope', () => {
  it('requires clientId and contractId', () => {
    const envelope: ProviderContributionEnvelope = {
      clientId: 'claude-code',
      contractId: 'anthropic.tool-response@1',
      effects: { someEffect: 'value' },
    };
    expect(envelope.clientId).toBe('claude-code');
    expect(envelope.contractId).toBe('anthropic.tool-response@1');
    expect(envelope.effects).toEqual({ someEffect: 'value' });
  });

  it('supports typed effects via generic parameter', () => {
    interface MyEffects extends Record<string, unknown> {
      toolResult: string;
      confidence: number;
    }
    const envelope: ProviderContributionEnvelope<MyEffects> = {
      clientId: 'claude-code',
      contractId: 'anthropic.tool-response@1',
      effects: { toolResult: 'approved', confidence: 0.95 },
    };
    expect(envelope.effects.toolResult).toBe('approved');
    expect(envelope.effects.confidence).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// 5. Provider contract catalog interface shape tests
// ---------------------------------------------------------------------------

describe('ProviderContractCatalogEntry', () => {
  it('carries identity, version, interactions, blockability, and validate', () => {
    const entry: ProviderContractCatalogEntry = {
      clientId: 'claude-code',
      contractId: 'anthropic.tool-response',
      version: '1.0.0',
      supportedInteractions: ['PreToolUse', 'PostToolUse'],
      blockability: [
        { interaction: 'PreToolUse', blockable: true },
        { interaction: 'PostToolUse', blockable: false },
      ],
      validate: (output) => (typeof output === 'object' ? true : 'Output must be an object'),
    };
    expect(entry.clientId).toBe('claude-code');
    expect(entry.contractId).toBe('anthropic.tool-response');
    expect(entry.version).toBe('1.0.0');
    expect(entry.supportedInteractions).toEqual(['PreToolUse', 'PostToolUse']);
    expect(entry.blockability).toHaveLength(2);
    expect(entry.validate({}, {})).toBe(true);
    expect(entry.validate('not-an-object', {})).toBe('Output must be an object');
  });

  it('validate is required and callable', () => {
    const entry: ProviderContractCatalogEntry = {
      clientId: 'claude-code',
      contractId: 'anthropic.tool-response',
      version: '1.0.0',
      supportedInteractions: ['PreToolUse'],
      blockability: [{ interaction: 'PreToolUse', blockable: true }],
      validate: () => true,
    };
    expect(entry.validate({}, {})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Failure policy 'closed' is only valid with blockable interactions
// ---------------------------------------------------------------------------

describe('Failure policy validation', () => {
  const catalog: ProviderContractCatalogEntry = {
    clientId: 'claude-code',
    contractId: 'anthropic.tool-response',
    version: '1.0.0',
    supportedInteractions: ['PreToolUse', 'PostToolUse', 'Stop'],
    blockability: [
      { interaction: 'PreToolUse', blockable: true },
      { interaction: 'PostToolUse', blockable: false },
      { interaction: 'Stop', blockable: false },
    ],
    validate: () => true,
  };

  it('accepts closed policy when all selectors target blockable interactions', () => {
    const selectors: InteractionSelector[] = [{ kind: 'event-name', name: 'PreToolUse' }];
    const errors = validateClosedPolicy(selectors, catalog);
    expect(errors).toEqual([]);
  });

  it('rejects closed policy when a selector targets a non-blockable interaction', () => {
    const selectors: InteractionSelector[] = [{ kind: 'event-name', name: 'PostToolUse' }];
    const errors = validateClosedPolicy(selectors, catalog);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('PostToolUse');
    expect(errors[0]).toContain('not blockable');
  });

  it('rejects closed policy for unsupported interactions', () => {
    const selectors: InteractionSelector[] = [{ kind: 'event-name', name: 'UnknownEvent' }];
    const errors = validateClosedPolicy(selectors, catalog);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('UnknownEvent');
    expect(errors[0]).toContain('not a supported interaction');
  });

  it('returns multiple errors for multiple non-blockable selectors', () => {
    const selectors: InteractionSelector[] = [
      { kind: 'event-name', name: 'PostToolUse' },
      { kind: 'event-name', name: 'Stop' },
    ];
    const errors = validateClosedPolicy(selectors, catalog);
    expect(errors).toHaveLength(2);
  });

  it('validates capability selectors the same way', () => {
    const selectors: InteractionSelector[] = [{ kind: 'capability', capability: 'PostToolUse' }];
    const errors = validateClosedPolicy(selectors, catalog);
    expect(errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Activation error types are distinct from runtime outcomes
// ---------------------------------------------------------------------------

describe('Error modeling — activation vs runtime', () => {
  it('activation errors carry code, message, contributorId, extensionName', () => {
    const error: ActivationValidationError = {
      code: 'invalid-contributor-id',
      message: 'Contributor ID must be non-empty',
      contributorId: '',
      extensionName: 'my-extension',
    };
    expect(error.code).toBe('invalid-contributor-id');
    expect(error.extensionName).toBe('my-extension');
  });

  it('activation error codes cover all validation cases', () => {
    const codes: ActivationValidationError['code'][] = [
      'invalid-contributor-id',
      'invalid-timeout-ms',
      'invalid-priority',
      'invalid-contributor-lane',
      'invalid-selectors',
      'invalid-respond',
      'inactive-provider-contract',
      'unsupported-interaction',
      'closed-policy-on-non-blockable',
    ];
    expect(codes).toHaveLength(9);
    // Each code is a distinct string
    expect(new Set(codes).size).toBe(9);
  });

  it('runtime outcomes cover all execution result cases', () => {
    const outcomes: RuntimeOutcome[] = [
      { code: 'success', contributorId: 'test' },
      { code: 'timeout', contributorId: 'test', durationMs: 5001 },
      { code: 'rejection', contributorId: 'test', detail: 'invalid output' },
      { code: 'closed-failure', contributorId: 'test' },
    ];
    expect(outcomes).toHaveLength(4);
    const codes = outcomes.map((o) => o.code);
    expect(new Set(codes).size).toBe(4);
  });

  it('activation errors and runtime outcomes are structurally distinct', () => {
    const activationError: ActivationValidationError = {
      code: 'invalid-contributor-id',
      message: 'bad id',
      extensionName: 'ext',
    };
    const runtimeOutcome: RuntimeOutcome = {
      code: 'success',
      contributorId: 'test',
    };
    // Activation errors have 'message' and 'extensionName'
    expect('message' in activationError).toBe(true);
    expect('extensionName' in activationError).toBe(true);
    // Runtime outcomes have 'contributorId' and optional 'durationMs'
    expect('contributorId' in runtimeOutcome).toBe(true);
    // They don't share the same code values
    expect(activationError.code).not.toBe(runtimeOutcome.code);
  });
});

// ---------------------------------------------------------------------------
// 8. Contributor identity must be non-empty string
// ---------------------------------------------------------------------------

describe('ContributorDefinition — identity validation', () => {
  it('accepts a non-empty string ID', () => {
    expect(isValidContributorId('my-contributor')).toBe(true);
  });

  it('rejects an empty string ID', () => {
    expect(isValidContributorId('')).toBe(false);
  });

  it('rejects a whitespace-only ID', () => {
    expect(isValidContributorId('   ')).toBe(false);
    expect(isValidContributorId('\t')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Priority is a number
// ---------------------------------------------------------------------------

describe('ContributorDefinition — priority', () => {
  it('accepts integer priorities', () => {
    const def: ContributorDefinition = {
      lane: 'canonical',
      id: 'test',
      priority: 100,
      timeoutMs: 5000,
      selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
      respond: () => ({}),
    };
    expect(def.priority).toBe(100);
  });

  it('accepts negative priorities (lower = later in pipeline)', () => {
    const def: ContributorDefinition = {
      lane: 'canonical',
      id: 'test',
      priority: -10,
      timeoutMs: 5000,
      selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
      respond: () => ({}),
    };
    expect(def.priority).toBe(-10);
  });

  it('accepts zero priority', () => {
    const def: ContributorDefinition = {
      lane: 'canonical',
      id: 'test',
      priority: 0,
      timeoutMs: 5000,
      selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
      respond: () => ({}),
    };
    expect(def.priority).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Interaction selectors match by event name
// ---------------------------------------------------------------------------

describe('Interaction selectors', () => {
  it('EventNameSelector matches by event name', () => {
    const selector: EventNameSelector = {
      kind: 'event-name',
      name: 'PreToolUse',
    };
    expect(selector.kind).toBe('event-name');
    expect(selector.name).toBe('PreToolUse');
  });

  it('CapabilitySelector matches by response capability', () => {
    const selector: CapabilitySelector = {
      kind: 'capability',
      capability: 'context.append',
    };
    expect(selector.kind).toBe('capability');
    expect(selector.capability).toBe('context.append');
  });

  it('InteractionSelector union discriminates on kind', () => {
    const selectors: InteractionSelector[] = [
      { kind: 'event-name', name: 'PreToolUse' },
      { kind: 'capability', capability: 'approve' },
    ];
    for (const s of selectors) {
      if (s.kind === 'event-name') {
        expect(s.name).toBeDefined();
      } else {
        expect(s.capability).toBeDefined();
      }
    }
  });

  it('contributor definition requires at least one selector conceptually', () => {
    const def: ContributorDefinition = {
      lane: 'canonical',
      id: 'test',
      priority: 10,
      timeoutMs: 5000,
      selectors: [{ kind: 'event-name', name: 'Stop' }],
      respond: () => ({}),
    };
    expect(def.selectors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Contributor response shape
// ---------------------------------------------------------------------------

describe('ContributorResponse', () => {
  it('supports canonical-only responses', () => {
    const response: ContributorResponse = {
      canonicalEffects: [createAppendEffect('extra context')],
    };
    expect(response.canonicalEffects).toHaveLength(1);
    expect(response.providerEnvelope).toBeUndefined();
  });

  it('supports provider-only responses', () => {
    const response: ContributorResponse = {
      providerEnvelope: {
        clientId: 'claude-code',
        contractId: 'anthropic.tool-response@1',
        effects: { result: 'approved' },
      },
    };
    expect(response.canonicalEffects).toBeUndefined();
    expect(response.providerEnvelope).toBeDefined();
    expect(response.providerEnvelope!.clientId).toBe('claude-code');
  });

  it('supports mixed canonical + provider responses', () => {
    const response: ContributorResponse = {
      canonicalEffects: [createAppendEffect('context')],
      providerEnvelope: {
        clientId: 'claude-code',
        contractId: 'anthropic.tool-response@1',
        effects: {},
      },
    };
    expect(response.canonicalEffects).toHaveLength(1);
    expect(response.providerEnvelope).toBeDefined();
  });

  it('supports empty no-op response', () => {
    const response: ContributorResponse = {};
    expect(response.canonicalEffects).toBeUndefined();
    expect(response.providerEnvelope).toBeUndefined();
  });
});

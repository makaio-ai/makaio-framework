/**
 * Tests for {@link ClientHookResponseRegistry}.
 *
 * Verifies atomic batch installation, activation-time validation, priority
 * ordering, immutable snapshots, and extension-scoped removal.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type {
  ContributorDefinition,
  ContributorCallbackContext,
  ProviderContractCatalogEntry,
} from '@makaio/contracts/client';
import { ClientHookProviderContractRegistry } from '../client-hook-provider-contract-registry.js';
import { ClientHookResponseRegistry } from '../client-hook-response-registry.js';

type CanonicalContributorDefinition = Extract<ContributorDefinition, { lane: 'canonical' }>;
type ProviderContributorDefinition = Extract<ContributorDefinition, { lane: 'provider' }>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG: ProviderContractCatalogEntry = {
  clientId: 'claude-code',
  contractId: 'anthropic.tool-response',
  version: '1.0.0',
  supportedInteractions: ['PreToolUse', 'PostToolUse'],
  blockability: [
    { interaction: 'PreToolUse', blockable: true },
    { interaction: 'PostToolUse', blockable: false },
  ],
  validate: () => true,
};

/**
 * No-op respond callback for test contributors.
 * @param _ctx - Ignored callback context.
 */
const noopRespond = (_ctx: ContributorCallbackContext) => ({});

/**
 * Create a valid contributor definition with sensible defaults.
 * @param overrides - Partial overrides for the contributor definition.
 * @returns A complete contributor definition.
 */
function createContributor(
  overrides: Partial<CanonicalContributorDefinition> & { id: string; lane?: 'canonical' },
): CanonicalContributorDefinition;
function createContributor(
  overrides: Partial<ProviderContributorDefinition> &
    Pick<ProviderContributorDefinition, 'id' | 'lane' | 'clientId' | 'contractId'>,
): ProviderContributorDefinition;
function createContributor(
  overrides:
    | (Partial<CanonicalContributorDefinition> & { id: string; lane?: 'canonical' })
    | (Partial<ProviderContributorDefinition> &
        Pick<ProviderContributorDefinition, 'id' | 'lane' | 'clientId' | 'contractId'>),
): ContributorDefinition {
  if (overrides.lane === 'provider') {
    return {
      priority: 100,
      timeoutMs: 5000,
      selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
      respond: noopRespond,
      ...overrides,
    };
  }
  return {
    lane: 'canonical',
    priority: 100,
    timeoutMs: 5000,
    selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
    respond: noopRespond,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientHookResponseRegistry', () => {
  let contractRegistry: ClientHookProviderContractRegistry;
  let registry: ClientHookResponseRegistry;

  beforeEach(() => {
    contractRegistry = new ClientHookProviderContractRegistry();
    contractRegistry.registerProviderContract('ext-provider', CATALOG);
    registry = new ClientHookResponseRegistry(contractRegistry);
  });

  // -------------------------------------------------------------------------
  // Successful installation
  // -------------------------------------------------------------------------

  describe('installContributors — success', () => {
    it('installs a single contributor with no errors', () => {
      const result = registry.installContributors('ext-a', [createContributor({ id: 'contrib-1' })]);

      expect(result.errors).toHaveLength(0);
    });

    it('installs multiple contributors atomically', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({ id: 'contrib-1', priority: 200 }),
        createContributor({ id: 'contrib-2', priority: 100 }),
      ]);

      expect(result.errors).toHaveLength(0);
      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      expect(snap).toHaveLength(2);
    });

    it('assigns stable insertion ordinals in batch order', () => {
      registry.installContributors('ext-a', [
        createContributor({ id: 'first', priority: 100 }),
        createContributor({ id: 'second', priority: 100 }),
      ]);

      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      // Same priority — ordinal determines order (first registered first).
      expect(snap[0].namespacedId).toBe('ext-a/first');
      expect(snap[1].namespacedId).toBe('ext-a/second');
      expect(snap[0].ordinal).toBeLessThan(snap[1].ordinal);
    });

    it('namespaces contributor IDs by extension', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'contrib' })]);

      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      expect(snap[0].namespacedId).toBe('ext-a/contrib');
      expect(snap[0].extensionId).toBe('ext-a');
    });
  });

  describe('installContributors — runtime shape validation', () => {
    it('rejects malformed definitions atomically before installing valid siblings', () => {
      const malformed = createContributor({ id: 'bad' });
      Object.defineProperties(malformed, {
        priority: { value: Number.NaN, enumerable: true },
        respond: { value: 'not-a-function', enumerable: true },
      });

      const result = registry.installContributors('ext-a', [createContributor({ id: 'valid' }), malformed]);

      expect(result.errors.map((error) => error.code)).toContain('invalid-priority');
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);
    });

    it('rejects a non-object definition without throwing or mutating the registry', () => {
      const definitions: ContributorDefinition[] = [createContributor({ id: 'placeholder' })];
      Object.defineProperty(definitions, 0, { value: null });

      const result = registry.installContributors('ext-a', definitions);

      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'invalid-contributor-lane', extensionName: 'ext-a' }),
      ]);
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Validation — contributor ID
  // -------------------------------------------------------------------------

  describe('installContributors — invalid contributor ID', () => {
    it('rejects empty contributor ID', () => {
      const result = registry.installContributors('ext-a', [createContributor({ id: '' })]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('invalid-contributor-id');
    });

    it('rejects whitespace-only contributor ID', () => {
      const result = registry.installContributors('ext-a', [createContributor({ id: '   ' })]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('invalid-contributor-id');
    });

    it('does not install any contributors when one has an invalid ID (atomic)', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({ id: 'valid' }),
        createContributor({ id: '' }),
      ]);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Validation — duplicate IDs
  // -------------------------------------------------------------------------

  describe('installContributors — duplicate IDs', () => {
    it('rejects duplicate IDs within the same batch', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({ id: 'contrib' }),
        createContributor({ id: 'contrib' }),
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('invalid-contributor-id');
      expect(result.errors[0].message).toMatch(/Duplicate contributor ID/);
    });

    it('rejects IDs that collide with contributors from a different extension', () => {
      // Namespaced IDs are extensionId/contributorId, so same contributor
      // ID from different extensions should NOT collide.
      registry.installContributors('ext-a', [createContributor({ id: 'contrib' })]);

      const result = registry.installContributors('ext-b', [createContributor({ id: 'contrib' })]);

      // Different extensions — namespaced IDs differ, so no collision.
      expect(result.errors).toHaveLength(0);
    });

    it('rejects IDs that collide with own existing contributors', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'contrib' })]);

      // Same extension, same ID — collision with existing.
      const result = registry.installContributors('ext-a', [createContributor({ id: 'contrib' })]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('invalid-contributor-id');
    });
  });

  // -------------------------------------------------------------------------
  // Validation — timeout
  // -------------------------------------------------------------------------

  describe('installContributors — invalid timeout', () => {
    it('rejects zero timeout with invalid-timeout-ms code', () => {
      const result = registry.installContributors('ext-a', [createContributor({ id: 'contrib', timeoutMs: 0 })]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('invalid-timeout-ms');
      expect(result.errors[0].message).toMatch(/invalid timeoutMs/);
    });

    it('rejects negative timeout with invalid-timeout-ms code', () => {
      const result = registry.installContributors('ext-a', [createContributor({ id: 'contrib', timeoutMs: -1 })]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('invalid-timeout-ms');
    });

    it('rejects Infinity timeout with invalid-timeout-ms code', () => {
      const result = registry.installContributors('ext-a', [createContributor({ id: 'contrib', timeoutMs: Infinity })]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('invalid-timeout-ms');
    });
  });

  // -------------------------------------------------------------------------
  // Validation — unsupported interactions
  // -------------------------------------------------------------------------

  describe('installContributors — unsupported interactions', () => {
    it('rejects capability selectors for unknown interactions', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          selectors: [{ kind: 'capability', capability: 'NonexistentCapability' }],
        }),
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('unsupported-interaction');
      expect(result.errors[0].message).toMatch(/NonexistentCapability/);
    });

    it('accepts capability selectors for supported interactions', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          selectors: [{ kind: 'capability', capability: 'PreToolUse' }],
        }),
      ]);

      expect(result.errors).toHaveLength(0);
    });

    it('accepts event-name selectors regardless of contract support', () => {
      // Event-name selectors match hook events directly — they don't
      // require a provider contract to support the interaction.
      const result = registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          selectors: [{ kind: 'event-name', name: 'ArbitraryHookEvent' }],
        }),
      ]);

      expect(result.errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Validation — closed policy on non-blockable
  // -------------------------------------------------------------------------

  describe('installContributors — closed policy validation', () => {
    it('rejects closed policy for non-blockable capability interaction', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          failurePolicy: 'closed',
          selectors: [{ kind: 'capability', capability: 'PostToolUse' }],
        }),
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('closed-policy-on-non-blockable');
    });

    it('accepts closed policy for blockable capability interaction', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          failurePolicy: 'closed',
          selectors: [{ kind: 'capability', capability: 'PreToolUse' }],
        }),
      ]);

      expect(result.errors).toHaveLength(0);
    });

    it('rejects closed policy for non-blockable event-name interaction when contract exists', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          failurePolicy: 'closed',
          selectors: [{ kind: 'event-name', name: 'PostToolUse' }],
        }),
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('closed-policy-on-non-blockable');
    });

    it('accepts closed policy for blockable event-name interaction', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          failurePolicy: 'closed',
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        }),
      ]);

      expect(result.errors).toHaveLength(0);
    });

    it('rejects closed policy for event-name with no matching contract', () => {
      // Closed failure policy requires positive blockability proof from
      // a provider contract. Without a contract, the policy is rejected.
      const result = registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          failurePolicy: 'closed',
          selectors: [{ kind: 'event-name', name: 'ArbitraryHookEvent' }],
        }),
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('closed-policy-on-non-blockable');
      expect(result.errors[0].message).toMatch(/no contract declares it/);
    });

    it('defaults to open policy when failurePolicy is omitted', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          // No failurePolicy specified — defaults to 'open'.
          selectors: [{ kind: 'capability', capability: 'PostToolUse' }],
        }),
      ]);

      expect(result.errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Atomicity
  // -------------------------------------------------------------------------

  describe('installContributors — atomicity', () => {
    it('does not install any contributors when the batch has errors', () => {
      const result = registry.installContributors('ext-a', [
        createContributor({ id: 'valid-contrib' }),
        createContributor({ id: '' }), // Invalid
      ]);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);
    });

    it('preserves existing contributors when a new batch fails', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'existing' })]);

      const result = registry.installContributors('ext-b', [
        createContributor({ id: '' }), // Invalid
      ]);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(1);
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')[0].namespacedId).toBe(
        'ext-a/existing',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot ordering
  // -------------------------------------------------------------------------

  describe('snapshot — ordering', () => {
    it('orders by priority descending', () => {
      registry.installContributors('ext-a', [
        createContributor({ id: 'low', priority: 10 }),
        createContributor({ id: 'high', priority: 200 }),
        createContributor({ id: 'mid', priority: 100 }),
      ]);

      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      expect(snap.map((c) => c.namespacedId)).toEqual(['ext-a/high', 'ext-a/mid', 'ext-a/low']);
    });

    it('orders by insertion ordinal ascending for same priority', () => {
      registry.installContributors('ext-a', [
        createContributor({ id: 'first', priority: 100 }),
        createContributor({ id: 'second', priority: 100 }),
      ]);
      registry.installContributors('ext-b', [createContributor({ id: 'third', priority: 100 })]);

      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      expect(snap.map((c) => c.namespacedId)).toEqual(['ext-a/first', 'ext-a/second', 'ext-b/third']);
    });

    it('combines priority and ordinal sorting correctly', () => {
      registry.installContributors('ext-a', [
        createContributor({ id: 'a-low', priority: 50 }),
        createContributor({ id: 'a-high', priority: 200 }),
      ]);
      registry.installContributors('ext-b', [
        createContributor({ id: 'b-mid', priority: 100 }),
        createContributor({ id: 'b-high', priority: 200 }),
      ]);

      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      expect(snap.map((c) => c.namespacedId)).toEqual([
        'ext-a/a-high', // priority 200, ordinal 2
        'ext-b/b-high', // priority 200, ordinal 4
        'ext-b/b-mid', // priority 100, ordinal 3
        'ext-a/a-low', // priority 50, ordinal 1
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot immutability
  // -------------------------------------------------------------------------

  describe('snapshot — immutability', () => {
    it('returns a frozen array', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'contrib' })]);

      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      expect(Object.isFrozen(snap)).toBe(true);
    });

    it('is not affected by subsequent installations', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'first' })]);

      const snapBefore = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');

      registry.installContributors('ext-b', [createContributor({ id: 'second' })]);

      expect(snapBefore).toHaveLength(1);
      expect(snapBefore[0].namespacedId).toBe('ext-a/first');
    });

    it('is not affected by subsequent removals', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'contrib' })]);

      const snapBefore = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');

      registry.removeContributors('ext-a');

      expect(snapBefore).toHaveLength(1);
      expect(snapBefore[0].namespacedId).toBe('ext-a/contrib');
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot filtering
  // -------------------------------------------------------------------------

  describe('snapshot — filtering', () => {
    it('filters by event name matching event-name selectors', () => {
      registry.installContributors('ext-a', [
        createContributor({
          id: 'pre',
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        }),
        createContributor({
          id: 'post',
          selectors: [{ kind: 'event-name', name: 'PostToolUse' }],
        }),
      ]);

      const preSnap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      expect(preSnap).toHaveLength(1);
      expect(preSnap[0].namespacedId).toBe('ext-a/pre');

      const postSnap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PostToolUse');
      expect(postSnap).toHaveLength(1);
      expect(postSnap[0].namespacedId).toBe('ext-a/post');
    });

    it('filters by event capabilities matching capability selectors', () => {
      // 'PreToolUse' is both a supported interaction in the test catalog
      // and used here as the capability to match against.
      registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          selectors: [{ kind: 'capability', capability: 'PreToolUse' }],
        }),
      ]);

      // Matches when the event declares the capability.
      expect(
        registry.snapshot('claude-code', 'anthropic.tool-response', 'SomeEvent', ['PreToolUse', 'approve']),
      ).toHaveLength(1);
      // Does not match when the event lacks the capability.
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'SomeEvent', ['approve'])).toHaveLength(0);
      // Does not match when no capabilities are provided (default).
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'SomeEvent')).toHaveLength(0);
    });

    it('matches when any selector matches the event name', () => {
      registry.installContributors('ext-a', [
        createContributor({
          id: 'multi',
          selectors: [
            { kind: 'event-name', name: 'PreToolUse' },
            { kind: 'event-name', name: 'PostToolUse' },
          ],
        }),
      ]);

      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(1);
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PostToolUse')).toHaveLength(1);
    });

    it('returns empty array when no contributors match', () => {
      registry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        }),
      ]);

      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'UnknownEvent')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Removal
  // -------------------------------------------------------------------------

  describe('removeContributors', () => {
    it('removes all contributors for the given extension', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'a1' }), createContributor({ id: 'a2' })]);

      registry.removeContributors('ext-a');

      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);
    });

    it('does not remove contributors from other extensions', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'a1' })]);
      registry.installContributors('ext-b', [createContributor({ id: 'b1' })]);

      registry.removeContributors('ext-a');

      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      expect(snap).toHaveLength(1);
      expect(snap[0].namespacedId).toBe('ext-b/b1');
    });

    it('is a no-op when the extension has no contributors', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'a1' })]);

      registry.removeContributors('ext-nonexistent');

      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(1);
    });

    it('allows re-installation after removal', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'contrib' })]);

      registry.removeContributors('ext-a');

      const result = registry.installContributors('ext-a', [createContributor({ id: 'contrib' })]);

      expect(result.errors).toHaveLength(0);
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    it('removes all contributors and resets ordinal counter', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'a1' })]);
      registry.installContributors('ext-b', [createContributor({ id: 'b1' })]);

      registry.clear();

      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);

      // After clear, ordinals restart — first installed contributor
      // gets ordinal 1.
      registry.installContributors('ext-c', [createContributor({ id: 'c1' })]);
      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      expect(snap).toHaveLength(1);
      expect(snap[0].ordinal).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Edge: no provider contracts registered
  // -------------------------------------------------------------------------

  describe('installContributors — no provider contracts', () => {
    it('rejects capability selectors when no contracts are registered', () => {
      const emptyContractRegistry = new ClientHookProviderContractRegistry();
      const emptyRegistry = new ClientHookResponseRegistry(emptyContractRegistry);

      const result = emptyRegistry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          selectors: [{ kind: 'capability', capability: 'PreToolUse' }],
        }),
      ]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('unsupported-interaction');
    });

    it('accepts event-name selectors when no contracts are registered', () => {
      const emptyContractRegistry = new ClientHookProviderContractRegistry();
      const emptyRegistry = new ClientHookResponseRegistry(emptyContractRegistry);

      const result = emptyRegistry.installContributors('ext-a', [
        createContributor({
          id: 'contrib',
          selectors: [{ kind: 'event-name', name: 'PreToolUse' }],
        }),
      ]);

      expect(result.errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge: registered contributor definition is preserved by reference
  // -------------------------------------------------------------------------

  describe('installContributors — definition immutability', () => {
    it('freezes the stored definition so it is immutable', () => {
      const definition = createContributor({ id: 'contrib' });
      registry.installContributors('ext-a', [definition]);

      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      expect(Object.isFrozen(snap[0].definition)).toBe(true);
      expect(Object.isFrozen(snap[0].definition.selectors)).toBe(true);
    });

    it('clones the definition so external mutation does not affect snapshots', () => {
      const selectors: [{ kind: 'event-name'; name: string }] = [{ kind: 'event-name', name: 'PreToolUse' }];
      const definition = createContributor({
        id: 'contrib',
        selectors,
      });
      registry.installContributors('ext-a', [definition]);

      // Mutate the original selectors array externally.
      (selectors as unknown as { kind: string; name: string }[]).push({
        kind: 'event-name',
        name: 'PostToolUse',
      });

      const snap = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse');
      // The stored definition should still have only the original selector.
      expect(snap[0].definition.selectors).toHaveLength(1);
      expect(snap[0].definition.selectors[0]).toEqual({
        kind: 'event-name',
        name: 'PreToolUse',
      });
    });

    it('freezes registered entry records exposed by snapshots', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'contrib' })]);

      const entry = registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')[0];
      expect(Object.isFrozen(entry)).toBe(true);
      expect(() => {
        Object.assign(entry, { ordinal: 999 });
      }).toThrow();
      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')[0].ordinal).not.toBe(999);
    });
  });

  describe('client targeting', () => {
    it('does not include provider contributors for another client', () => {
      registry.installContributors('ext-a', [
        createContributor({
          id: 'provider',
          lane: 'provider',
          clientId: 'claude-code',
          contractId: 'anthropic.tool-response',
        }),
      ]);

      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(1);
      expect(registry.snapshot('codex', 'codex.hook-response', 'PreToolUse')).toHaveLength(0);
      expect(registry.snapshot('claude-code', 'other.contract', 'PreToolUse')).toHaveLength(0);
    });

    it('filters canonical contributors by their optional client list', () => {
      registry.installContributors('ext-a', [createContributor({ id: 'canonical', clientIds: ['codex'] })]);

      expect(registry.snapshot('claude-code', 'anthropic.tool-response', 'PreToolUse')).toHaveLength(0);
      expect(registry.snapshot('codex', 'codex.hook-response', 'PreToolUse')).toHaveLength(1);
    });

    it('rejects canonical closed policy when any eligible contract is non-blockable', () => {
      contractRegistry.registerProviderContract('ext-codex', {
        ...CATALOG,
        clientId: 'codex',
        contractId: 'codex.hook-response',
        supportedInteractions: ['PreToolUse'],
        blockability: [{ interaction: 'PreToolUse', blockable: false }],
      });

      const result = registry.installContributors('ext-a', [
        createContributor({ id: 'closed', failurePolicy: 'closed' }),
      ]);

      expect(result.errors.map((error) => error.code)).toContain('closed-policy-on-non-blockable');
    });
  });
});

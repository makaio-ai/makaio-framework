/**
 * Contract test suite for `changeReasoningInPlace` on stream-based connectors.
 *
 * The behaviour is fully implemented in {@link BaseStreamConnector} and is
 * identical across every stream-based adapter (Anthropic SDK, OpenAI Node,
 * etc.). Extracting the assertions here eliminates duplication and guarantees
 * every adapter that extends the base class is verified against the same
 * invariants.
 *
 * Usage — call {@link describeChangeReasoningInPlaceContract} inside the
 * adapter's own test file, passing a factory that constructs a fresh connector
 * instance for each test:
 *
 * ```ts
 * import { describeChangeReasoningInPlaceContract } from '@makaio/ai-adapters-stream-session/testing';
 *
 * describeChangeReasoningInPlaceContract('AnthropicSdkConnector', async () => {
 *   const bus = await AnthropicSdkConnectorNamespace.scopedBus();
 *   return new AnthropicSdkConnector({ bus, ... });
 * });
 * ```
 */
import { describe, expect, it, vi } from 'vitest';
import type { AIReasoningLevel } from '@makaio/contracts';

/**
 * Minimal public surface required from the connector under test.
 *
 * Intentionally narrow: the contract only exercises `changeReasoningInPlace`
 * and the read-only `currentReasoningEffort` snapshot, keeping the helper
 * decoupled from any concrete connector class.
 */
export interface ChangeReasoningConnector {
  /** Attempt an in-place reasoning level change; returns `true` on success. */
  changeReasoningInPlace(level: AIReasoningLevel): Promise<boolean>;
  /** Current reasoning effort level managed by the caller, never mutated in-place. */
  readonly currentReasoningEffort: AIReasoningLevel | undefined;
}

/**
 * Register the shared `changeReasoningInPlace` contract suite for a
 * stream-based connector.
 *
 * Each test creates a fresh connector via `makeConnector()` to guarantee
 * isolation — the factory must return a pre-start connector with no active
 * session.
 * @param connectorName - Display name used in the outer `describe` block
 * @param makeConnector - Async factory that returns a fresh connector instance
 */
export function describeChangeReasoningInPlaceContract(
  connectorName: string,
  makeConnector: () => Promise<ChangeReasoningConnector>,
): void {
  describe(`${connectorName}.changeReasoningInPlace()`, () => {
    it('always returns true (stream-based adapters apply reasoning per-request)', async () => {
      const connector = await makeConnector();

      expect(await connector.changeReasoningInPlace('medium')).toBe(true);
    });

    it('returns true for every canonical reasoning level', async () => {
      const connector = await makeConnector();
      const levels = ['none', 'low', 'medium', 'high', 'extra-high'] as const;

      for (const level of levels) {
        expect(await connector.changeReasoningInPlace(level)).toBe(true);
      }
    });

    it('does NOT mutate connector.currentReasoningEffort (mutation contract — caller is responsible)', async () => {
      const connector = await makeConnector();
      const effortBefore = connector.currentReasoningEffort;

      await connector.changeReasoningInPlace('high');

      expect(connector.currentReasoningEffort).toBe(effortBefore);
    });

    it('calls session.updateReasoning with the requested level when a session is active', async () => {
      const connector = await makeConnector();
      const mockUpdateReasoning = vi.fn();
      Reflect.set(connector, 'session', { updateReasoning: mockUpdateReasoning });

      await connector.changeReasoningInPlace('high');

      expect(mockUpdateReasoning).toHaveBeenCalledOnce();
      expect(mockUpdateReasoning).toHaveBeenCalledWith('high');
    });

    it('does not throw and returns true when no session exists (pre-start state)', async () => {
      const connector = await makeConnector();
      // No session has been created yet — session is undefined.

      const result = await connector.changeReasoningInPlace('medium');

      expect(result).toBe(true);
    });

    it('returns true and does not throw when session is null (optional-chain guard)', async () => {
      const connector = await makeConnector();
      // Inject null — distinct from undefined — to verify `session?.updateReasoning?.()`
      // does not throw when the session reference itself is null.
      Reflect.set(connector, 'session', null);

      const result = await connector.changeReasoningInPlace('medium');

      expect(result).toBe(true);
    });
  });
}

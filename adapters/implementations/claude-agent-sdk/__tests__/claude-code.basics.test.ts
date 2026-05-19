/**
 * Claude Code Adapter - Basic Functionality Tests
 *
 * Tests session handling and prompt caching behavior.
 * Uses a shared connector where possible to minimize API calls and cost.
 *
 * Test structure:
 * - First call (beforeAll): establishes baseline for both session and caching tests
 * - Second call: verifies cache hit + different session ID per turn
 * - Separate connector test: verifies different connectors get different session IDs
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ClaudeCodeAdapterName,
  ClaudeCodeConnectorNamespace,
  ClaudeCodeConnectorSubjects,
  ClaudeSdkConnector,
} from '../src';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeMessageInput } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import { EventContext } from '@makaio/core';
import type { SDKMessage } from '@makaio/client-claude-code';
import { createSessionAccountObservationRequester } from '../src/account-observation-requester.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

type SdkEvent = EventContext<SDKMessage>;

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup
// ─────────────────────────────────────────────────────────────────────────────

const scopedBus = await ClaudeCodeConnectorNamespace.scopedBus();

/**
 * Unique temp directory for this test run.
 * Using a fresh directory ensures the Claude Code SDK creates a new session
 * rather than resuming an existing one (SDK keys sessions by cwd).
 */
const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cache-test-'));

/**
 * Large system prompt to ensure caching behavior is testable.
 * Prepended with timestamp to avoid cross-test-run cache hits.
 */
const systemPromptBase = fs.readFileSync(path.join(import.meta.dirname, './fixtures/README.md'), 'utf8');
const systemPrompt = `${Date.now().toString()} ${systemPromptBase}`;

/**
 * Creates a connector with test configuration
 * @param options - Optional configuration for the connector
 */
function createTestConnector(options?: { useSystemPrompt?: boolean; agentId?: string }): ClaudeSdkConnector {
  return new ClaudeSdkConnector({
    bus: scopedBus,
    agentId: options?.agentId ?? crypto.randomUUID(),
    adapterId: 'test-adapter',
    adapterName: ClaudeCodeAdapterName,
    model: 'haiku',
    cwd: testCwd,
    clientId: claudeClientDefinition.id,
    providerConfig: {
      queryOptions: {
        systemPrompt: options?.useSystemPrompt ? systemPrompt : '',
        extraArgs: { tools: '' },
      },
    },
    requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.sequential
  .todo('Claude Code Basics', () => {
    // Shared state across tests
    let connector: ClaudeSdkConnector;
    let agentId: string;
    let unsubscribe: () => void;

    // Collected from first call - used by both session and caching tests
    let firstTurnSessionId: string;
    const firstTurnEvents: SdkEvent[] = [];
    let firstTurnUsage: Usage | undefined;

    // Collected from second call
    // NOTE: With Session persistence, second turn uses SAME session ID (for prompt cache)
    let secondTurnSessionId: string;
    const secondTurnEvents: SdkEvent[] = [];
    let secondTurnUsage: Usage | undefined;

    // Track which turn we're collecting events for
    let collectingSecondTurn = false;

    beforeAll(async () => {
      // Use large system prompt for caching tests
      agentId = crypto.randomUUID();
      connector = createTestConnector({ useSystemPrompt: true, agentId });

      // Subscribe BEFORE start() to capture all events
      // Events are now emitted synchronously in the consumption loop
      unsubscribe = MakaioBus.on(ClaudeCodeConnectorSubjects.sdk.event, (ctx) => {
        const event = ctx as SdkEvent;
        if (event.payload.agentId !== agentId) return;

        // Route based on which turn we're collecting
        if (!collectingSecondTurn) {
          firstTurnEvents.push(event);
          if (event.payload.type === 'result') {
            firstTurnUsage = event.payload.usage;
          }
        } else {
          secondTurnEvents.push(event);
          if (event.payload.type === 'result') {
            secondTurnUsage = event.payload.usage;
          }
        }
      });

      // ─────────────────────────────────────────────────────────────────────────
      // First call: establishes session and creates cache
      // ─────────────────────────────────────────────────────────────────────────
      const firstCallResult = await connector.start(normalizeMessageInput('Reply with OK only.'));
      firstTurnSessionId = firstCallResult.adapterSessionId;

      await firstCallResult.messageHandle.waitForCompletion();
      await connector.complete();

      // Switch to collecting second turn events
      collectingSecondTurn = true;

      // ─────────────────────────────────────────────────────────────────────────
      // Second call: should hit cache
      // NOTE: With Session persistence, uses SAME session ID (for prompt cache preservation)
      // ─────────────────────────────────────────────────────────────────────────
      const secondCallHandle = await connector.sendMessage(
        normalizeMessageInput('Remind me: What was my first prompt?'),
      );
      // waitForAdapterSessionId() resolves when processing starts - safe to call before completion
      secondTurnSessionId = await secondCallHandle.waitForAdapterSessionId();
      await secondCallHandle.waitForCompletion();
      await connector.complete();
    }, 30_000);

    afterAll(() => {
      unsubscribe?.();
      fs.rmSync(testCwd, { recursive: true, force: true });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // Session Handling Tests
    // ───────────────────────────────────────────────────────────────────────────

    describe('Session Handling', () => {
      it('returns adapterSessionId from start()', () => {
        expect(firstTurnSessionId).toBeDefined();
        expect(typeof firstTurnSessionId).toBe('string');
      });

      it('uses consistent sessionId for all events within a turn', () => {
        expect(firstTurnEvents.length).toBeGreaterThan(0);

        for (const event of firstTurnEvents) {
          expect.soft(event.payload.session_id).toBe(firstTurnSessionId);
        }
      });

      it('preserves sessionId across turns for prompt cache', () => {
        // Session persistence: same session ID across turns for cache preservation
        expect(secondTurnSessionId).toBeDefined();
        expect(secondTurnSessionId).toBe(firstTurnSessionId);
      });

      it('getAdapterSessionId() matches event session IDs for second turn', () => {
        expect(secondTurnEvents.length).toBeGreaterThan(0);

        // Second turn events should also have the persistent session ID
        for (const event of secondTurnEvents) {
          expect.soft(event.payload.session_id).toBe(secondTurnSessionId);
        }
      });

      it('uses different sessionId for different connectors', async () => {
        const otherConnector = createTestConnector();

        const result = await otherConnector.start(normalizeMessageInput('Reply with OK only.'));
        const otherSessionId = result.adapterSessionId;

        await result.messageHandle.waitForCompletion();
        await otherConnector.complete();

        // Should be unique from both existing sessions
        expect(otherSessionId).not.toBe(firstTurnSessionId);
        expect(otherSessionId).not.toBe(secondTurnSessionId);
      }, 30_000);
    });

    // ───────────────────────────────────────────────────────────────────────────
    // Prompt Caching Tests
    // ───────────────────────────────────────────────────────────────────────────

    describe('Prompt Caching', () => {
      it('creates cache on first call', () => {
        expect(firstTurnUsage).toBeDefined();
        // Large system prompt should result in substantial cache creation
        expect(firstTurnUsage!.cache_creation_input_tokens).toBeGreaterThanOrEqual(8000);
      });

      it('reads from cache on subsequent calls', () => {
        expect(secondTurnUsage).toBeDefined();
        // Second call should mostly read from cache, minimal new creation
        // Allow up to 500 tokens for conversation context/memory instruction/user message
        expect(secondTurnUsage!.cache_creation_input_tokens).toBeLessThanOrEqual(500);
        // Cache read should be approximately equal to cache creation (allow small tokenization variance)
        const cacheReadTokens = secondTurnUsage!.cache_read_input_tokens;
        const cacheCreatedTokens = firstTurnUsage!.cache_creation_input_tokens;
        expect(cacheReadTokens).toBeGreaterThanOrEqual(cacheCreatedTokens * 0.95);
        expect(cacheReadTokens).toBeLessThanOrEqual(cacheCreatedTokens * 1.05);
      });
    });
  }, 60_000);

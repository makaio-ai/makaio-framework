import { describe, it, expect } from 'vitest';
import type { SessionMessage } from '@makaio/contracts';
import { applySegmentTransforms } from '../get-full-conversation.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a minimal SessionMessage for testing.
 * @param id - Unique message ID
 * @param role - Message role
 * @param overrides - Optional field overrides
 */
function makeMessage(
  id: string,
  role: 'user' | 'assistant' = 'user',
  overrides?: Partial<SessionMessage>,
): SessionMessage {
  return {
    messageId: id,
    turnId: null,
    sessionId: 'test-session',
    role,
    contentText: `Message ${id}`,
    blocks: [{ type: 'text', content: `Message ${id}` }],
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Builds a SessionMessage with a reasoning block prepended.
 * @param id - Unique message ID
 */
function makeMessageWithReasoning(id: string): SessionMessage {
  return makeMessage(id, 'assistant', {
    blocks: [
      { type: 'reasoning', content: `Reasoning for ${id}` },
      { type: 'text', content: `Message ${id}` },
    ],
  });
}

/**
 * Builds a SessionMessage with a tool_output block appended.
 * @param id - Unique message ID
 * @param output - Tool output string
 */
function makeMessageWithToolOutput(id: string, output: string): SessionMessage {
  return makeMessage(id, 'assistant', {
    blocks: [
      { type: 'tool_call', toolCallId: `tc-${id}`, name: 'bash', args: {} },
      { type: 'tool_output', toolCallId: `tc-${id}`, output },
    ],
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('applySegmentTransforms', () => {
  describe('single verbatim segment', () => {
    it('passes messages through unchanged', () => {
      const messages = [makeMessage('m1'), makeMessage('m2'), makeMessage('m3')];

      const result = applySegmentTransforms(messages, [{ fromMessageId: 'm1', toMessageId: 'm3', policy: 'verbatim' }]);

      expect(result.map((m) => m.messageId)).toEqual(['m1', 'm2', 'm3']);
      expect(result[0].contentText).toBe('Message m1');
    });
  });

  describe('single exclude segment', () => {
    it('removes all messages in the segment', () => {
      const messages = [makeMessage('m1'), makeMessage('m2'), makeMessage('m3')];

      const result = applySegmentTransforms(messages, [{ fromMessageId: 'm1', toMessageId: 'm3', policy: 'exclude' }]);

      expect(result).toHaveLength(0);
    });
  });

  describe('single summarize segment', () => {
    it('replaces messages with a synthetic summary message when summaryText is present', () => {
      const messages = [
        makeMessage('m1', 'user', { timestamp: 1000 }),
        makeMessage('m2', 'assistant', { timestamp: 2000 }),
        makeMessage('m3', 'user', { timestamp: 3000 }),
      ];

      const result = applySegmentTransforms(messages, [
        { fromMessageId: 'm1', toMessageId: 'm3', policy: 'summarize', summaryText: 'A brief summary.' },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe('summary-m1-m3');
      expect(result[0].role).toBe('assistant');
      expect(result[0].contentText).toBe('A brief summary.');
      expect(result[0].blocks).toEqual([{ type: 'text', content: 'A brief summary.' }]);
      expect(result[0].turnId).toBeNull();
      expect(result[0].sessionId).toBe('test-session');
      expect(result[0].timestamp).toBe(3000);
    });

    it('falls back to verbatim when summaryText is absent (preview-pending state)', () => {
      const messages = [makeMessage('m1'), makeMessage('m2')];

      const result = applySegmentTransforms(messages, [
        { fromMessageId: 'm1', toMessageId: 'm2', policy: 'summarize' },
      ]);

      expect(result.map((m) => m.messageId)).toEqual(['m1', 'm2']);
    });
  });

  describe('multiple segments', () => {
    it('verbatim + exclude + verbatim produces the correct output', () => {
      const messages = [makeMessage('m1'), makeMessage('m2'), makeMessage('m3'), makeMessage('m4'), makeMessage('m5')];

      const result = applySegmentTransforms(messages, [
        { fromMessageId: 'm1', toMessageId: 'm2', policy: 'verbatim' },
        { fromMessageId: 'm3', toMessageId: 'm3', policy: 'exclude' },
        { fromMessageId: 'm4', toMessageId: 'm5', policy: 'verbatim' },
      ]);

      expect(result.map((m) => m.messageId)).toEqual(['m1', 'm2', 'm4', 'm5']);
    });
  });

  describe('strip flags', () => {
    it('stripReasoning removes reasoning blocks from messages in the segment', () => {
      const messages = [makeMessageWithReasoning('m1'), makeMessageWithReasoning('m2')];

      const result = applySegmentTransforms(messages, [
        { fromMessageId: 'm1', toMessageId: 'm2', policy: 'verbatim', stripReasoning: true },
      ]);

      expect(result).toHaveLength(2);
      for (const msg of result) {
        expect(msg.blocks.every((b) => b.type !== 'reasoning')).toBe(true);
      }
      // Text block should survive
      expect(result[0].blocks).toHaveLength(1);
      expect(result[0].blocks[0].type).toBe('text');
    });

    it('stripToolOutputs replaces tool_output.output with a placeholder', () => {
      const messages = [makeMessageWithToolOutput('m1', 'sensitive output content')];

      const result = applySegmentTransforms(messages, [
        { fromMessageId: 'm1', toMessageId: 'm1', policy: 'verbatim', stripToolOutputs: true },
      ]);

      expect(result).toHaveLength(1);
      const toolOutput = result[0].blocks.find((b) => b.type === 'tool_output');
      expect(toolOutput?.output).toMatch(/^\[output removed - \d+ chars\]$/);
    });

    it('stripReasoning and stripToolOutputs are independent per segment', () => {
      const messages = [makeMessageWithReasoning('m1'), makeMessageWithToolOutput('m2', 'big output')];

      // Only strip reasoning in the first segment, only strip tool outputs in the second
      const result = applySegmentTransforms(messages, [
        { fromMessageId: 'm1', toMessageId: 'm1', policy: 'verbatim', stripReasoning: true },
        { fromMessageId: 'm2', toMessageId: 'm2', policy: 'verbatim', stripToolOutputs: true },
      ]);

      // m1 should have no reasoning
      const m1 = result.find((m) => m.messageId === 'm1');
      expect(m1?.blocks.some((b) => b.type === 'reasoning')).toBe(false);

      // m2 tool output should be stripped
      const m2 = result.find((m) => m.messageId === 'm2');
      const toolOutput = m2?.blocks.find((b) => b.type === 'tool_output');
      expect(toolOutput?.output).toMatch(/^\[output removed - \d+ chars\]$/);
    });
  });

  describe('per-message overrides', () => {
    it('excludes individual messages within a verbatim segment', () => {
      const messages = [makeMessage('m1'), makeMessage('m2'), makeMessage('m3'), makeMessage('m4')];

      const result = applySegmentTransforms(messages, [
        {
          fromMessageId: 'm1',
          toMessageId: 'm4',
          policy: 'verbatim',
          overrides: { m2: 'exclude', m4: 'exclude' },
        },
      ]);

      expect(result.map((m) => m.messageId)).toEqual(['m1', 'm3']);
    });

    it('overrides do not affect messages outside the segment', () => {
      const messages = [makeMessage('m1'), makeMessage('m2'), makeMessage('m3')];

      // Segment only covers m1–m2; override for m3 should have no effect
      const result = applySegmentTransforms(messages, [
        {
          fromMessageId: 'm1',
          toMessageId: 'm2',
          policy: 'verbatim',
          overrides: { m3: 'exclude' },
        },
        { fromMessageId: 'm3', toMessageId: 'm3', policy: 'verbatim' },
      ]);

      expect(result.map((m) => m.messageId)).toEqual(['m1', 'm2', 'm3']);
    });
  });

  describe('legacy path (no segments)', () => {
    it('is not exercised by applySegmentTransforms — segments array must be non-empty to call this function', () => {
      // applySegmentTransforms always receives a non-empty segments array.
      // The empty array case produces an empty result (no segments to process).
      const messages = [makeMessage('m1'), makeMessage('m2')];
      const result = applySegmentTransforms(messages, []);
      expect(result).toHaveLength(0);
    });
  });

  describe('segments take precedence', () => {
    it('correctly processes only the segment range even when other messages exist outside it', () => {
      // Simulates the real scenario: ancestor messages span a wider range than the declared segments.
      // The segment should only project the declared range and ignore the rest.
      const messages = [
        makeMessage('m1'),
        makeMessage('m2'),
        makeMessage('m3'), // Only m2-m3 covered by segment
      ];

      const result = applySegmentTransforms(messages, [{ fromMessageId: 'm2', toMessageId: 'm3', policy: 'verbatim' }]);

      // m1 is not covered by any segment — it is implicitly excluded
      expect(result.map((m) => m.messageId)).toEqual(['m2', 'm3']);
    });
  });

  describe('unknown message IDs', () => {
    it('silently skips segments whose boundary IDs are not found in the message array', () => {
      const messages = [makeMessage('m1'), makeMessage('m2')];

      const result = applySegmentTransforms(messages, [
        { fromMessageId: 'unknown-start', toMessageId: 'unknown-end', policy: 'verbatim' },
        { fromMessageId: 'm1', toMessageId: 'm2', policy: 'verbatim' },
      ]);

      expect(result.map((m) => m.messageId)).toEqual(['m1', 'm2']);
    });
  });
});

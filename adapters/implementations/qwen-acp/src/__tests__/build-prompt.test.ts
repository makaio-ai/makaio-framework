/**
 * Tests for buildPromptContent utility
 *
 * Verifies that ACP ContentBlock arrays are assembled correctly from
 * normalized user messages. System prompt injection is handled via the
 * QWEN_SYSTEM_MD environment variable (written by the connector) and is
 * therefore not part of this utility's responsibilities.
 */

import { describe, it, expect } from 'vitest';
import { buildPromptContent } from '../utils/build-prompt.js';
import type { NormalizedMessageInput } from '@makaio/ai-adapters-core';

/**
 * Minimal NormalizedMessageInput for a text message.
 * @param text - The text content of the message
 */
function makeMessage(text: string): NormalizedMessageInput {
  return {
    role: 'user',
    blocks: [{ type: 'text', content: text }],
    message: text,
  };
}

/** Minimal NormalizedMessageInput representing an empty message. */
function makeEmptyMessage(): NormalizedMessageInput {
  return {
    role: 'user',
    blocks: [],
    message: undefined,
  };
}

/**
 * Extract text from a ContentBlock, asserting it is a text block.
 * @param block - The content block to extract text from
 * @returns The text content
 */
function blockText(block: unknown): string {
  expect(block).toMatchObject({ type: 'text' });
  return (block as { text: string }).text;
}

describe('buildPromptContent', () => {
  describe('basic message', () => {
    it('returns a single text block for a plain message', () => {
      const blocks = buildPromptContent(makeMessage('Hello'));

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ type: 'text', text: 'Hello' });
    });
  });

  describe('messageHistory', () => {
    it('injects conversation history as transcript block before user message', () => {
      const history = [
        { role: 'user' as const, blocks: [{ type: 'text' as const, content: 'Hi' }] },
        { role: 'assistant' as const, blocks: [{ type: 'text' as const, content: 'Hello!' }] },
      ];
      const blocks = buildPromptContent(makeMessage('Follow-up'), history);

      expect(blocks).toHaveLength(2);
      expect(blockText(blocks[0])).toContain('[CONVERSATION HISTORY]');
      expect(blockText(blocks[0])).toContain('User: Hi');
      expect(blockText(blocks[0])).toContain('Assistant: Hello!');
      expect(blockText(blocks[0])).toContain('[END CONVERSATION HISTORY]');
      expect(blocks[1]).toMatchObject({ type: 'text', text: 'Follow-up' });
    });

    it('does not inject a history block when messageHistory is empty', () => {
      const blocks = buildPromptContent(makeMessage('Hello'), []);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ type: 'text', text: 'Hello' });
    });
  });

  describe('turnContext', () => {
    it('injects turn context as XML-tagged blocks before user message', () => {
      const turnContext = { cwd: '/home/user/project' };
      const blocks = buildPromptContent(makeMessage('Do something'), undefined, turnContext);

      expect(blocks).toHaveLength(2);
      expect(blockText(blocks[0])).toContain('<cwd>');
      expect(blockText(blocks[0])).toContain('/home/user/project');
      expect(blocks[1]).toMatchObject({ type: 'text', text: 'Do something' });
    });

    it('places turn context after history and before user message', () => {
      const history = [{ role: 'user' as const, blocks: [{ type: 'text' as const, content: 'Prior' }] }];
      const turnContext = { cwd: '/tmp' };
      const blocks = buildPromptContent(makeMessage('Now'), history, turnContext);

      expect(blocks).toHaveLength(3);
      expect(blockText(blocks[0])).toContain('[CONVERSATION HISTORY]');
      expect(blockText(blocks[1])).toContain('<cwd>');
      expect(blocks[2]).toMatchObject({ type: 'text', text: 'Now' });
    });
  });

  describe('mergedContent', () => {
    it('places merged context between history and turn context before the user message', () => {
      const history = [{ role: 'user' as const, blocks: [{ type: 'text' as const, content: 'Prior' }] }];
      const turnContext = { cwd: '/tmp' };
      const blocks = buildPromptContent(makeMessage('Now'), history, turnContext, ['Queued A', 'Queued B']);

      expect(blocks).toHaveLength(4);
      expect(blockText(blocks[0])).toContain('[CONVERSATION HISTORY]');
      expect(blockText(blocks[1])).toContain('<merged_context>');
      expect(blockText(blocks[1])).toContain('Queued A');
      expect(blockText(blocks[1])).toContain('Queued B');
      expect(blockText(blocks[2])).toContain('<cwd>');
      expect(blocks[3]).toMatchObject({ type: 'text', text: 'Now' });
    });
  });

  describe('empty message', () => {
    it('returns at least one content block even when message is empty', () => {
      const blocks = buildPromptContent(makeEmptyMessage());

      expect(blocks.length).toBeGreaterThanOrEqual(1);
    });

    it('returns a single empty text block as ACP fallback for empty messages', () => {
      const blocks = buildPromptContent(makeEmptyMessage());

      expect(blocks).toEqual([{ type: 'text', text: '' }]);
    });
  });
});

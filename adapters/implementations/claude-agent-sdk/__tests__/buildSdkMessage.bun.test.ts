/**
 * Unit tests for buildSdkMessage turnContext handling.
 *
 * Tests the utility functions used by ClaudeConnectorSession.buildSdkMessage:
 * - prependContextBlock: Prepends context blocks with XML-style tags
 * - safeJsonStringify: Safely serializes values for injection
 *
 * These utilities implement the turnContext serialization logic:
 * - skills: Formatted as markdown sections ("## name\\ncontent")
 * - other keys: Serialized as JSON via safeJsonStringify
 *
 * Note: These tests verify the utility functions used by buildSdkMessage.
 * The actual buildSdkMessage method is private and tested indirectly via
 * integration tests. If the method's logic drifts from these utilities,
 * integration tests should catch the regression.
 * @packageDocumentation
 */

import { describe, it, expect } from 'bun:test';
import type { SDKUserMessage } from '@makaio/client-claude-code';
import { prependContextBlock, sdkUserMessageFromNormalized } from '@makaio/ai-adapters-claude-shared';
import { safeJsonStringify, serializeTurnContext } from '@makaio/ai-adapters-core';
import type { JsonValue } from '@makaio/contracts';

/**
 * Create a minimal SDK user message for testing.
 * @param text - The text content for the message
 * @returns SDK user message
 */
function createTestMessage(text: string): SDKUserMessage {
  return sdkUserMessageFromNormalized('test-msg-id', 'test-session-id', 'test-agent-id', {
    role: 'user',
    blocks: [{ type: 'text', content: text }],
    message: text,
  });
}

/**
 * Extract all text content from an SDK message.
 * @param msg - The SDK message to extract text from
 * @returns Array of text strings
 */
function extractTextContent(msg: SDKUserMessage): string[] {
  const content = msg.message.content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text);
  }
  return [content as string];
}

describe('prependContextBlock', () => {
  it('should prepend context block with XML-style tags', () => {
    const baseMessage = createTestMessage('Hello, world!');
    const result = prependContextBlock(baseMessage, 'test_tag', 'test content');

    const textBlocks = extractTextContent(result);
    expect(textBlocks[0]).toBe('<test_tag>\ntest content\n</test_tag>');
    expect(textBlocks[1]).toBe('Hello, world!');
  });

  it('should set isSynthetic to true', () => {
    const baseMessage = createTestMessage('Hello');
    expect(baseMessage.isSynthetic).toBe(false);

    const result = prependContextBlock(baseMessage, 'tag', 'content');
    expect(result.isSynthetic).toBe(true);
  });

  it('should preserve original message properties', () => {
    const baseMessage = createTestMessage('Hello');
    const result = prependContextBlock(baseMessage, 'tag', 'content');

    expect(result.uuid).toBe(baseMessage.uuid);
    expect(result.session_id).toBe(baseMessage.session_id);
    expect(result.type).toBe('user');
  });

  it('should handle multiple prepends in correct order', () => {
    const baseMessage = createTestMessage('Original');
    const withFirst = prependContextBlock(baseMessage, 'first', 'First content');
    const withBoth = prependContextBlock(withFirst, 'second', 'Second content');

    const textBlocks = extractTextContent(withBoth);
    // Most recently prepended should be first
    expect(textBlocks[0]).toContain('<second>');
    expect(textBlocks[1]).toContain('<first>');
    expect(textBlocks[2]).toBe('Original');
  });

  it('should sanitize tag and escape XML-sensitive content', () => {
    const baseMessage = createTestMessage('Hello');
    const result = prependContextBlock(baseMessage, 'bad<tag>', `a & b < c > d "e" 'f'`);

    const textBlocks = extractTextContent(result);
    expect(textBlocks[0]).toBe('<bad_tag_>\na &amp; b &lt; c &gt; d "e" &apos;f&apos;\n</bad_tag_>');
  });
});

describe('safeJsonStringify', () => {
  it('should serialize objects as formatted JSON', () => {
    const obj = { key: 'value', nested: { a: 1 } };
    const result = safeJsonStringify(obj);

    expect(result).toBe(JSON.stringify(obj, null, 2));
  });

  it('should serialize arrays', () => {
    const arr = [1, 2, { name: 'test' }];
    const result = safeJsonStringify(arr);

    expect(result).toBe(JSON.stringify(arr, null, 2));
  });

  it('should handle primitive values', () => {
    expect(safeJsonStringify('string')).toBe('"string"');
    expect(safeJsonStringify(42)).toBe('42');
    expect(safeJsonStringify(true)).toBe('true');
    expect(safeJsonStringify(null)).toBe('null');
  });

  it('should handle circular references gracefully', () => {
    const circular: Record<string, unknown> = { name: 'test' };
    circular.self = circular;

    const result = safeJsonStringify(circular);
    expect(result).toContain('[Circular]');
    expect(result).toContain('"name": "test"');
  });
});

describe('buildSdkMessage turnContext behavior', () => {
  /**
   * Simulates the turnContext handling from ClaudeConnectorSession.buildSdkMessage.
   * This tests the actual serialization logic without needing the full Session infrastructure.
   * @param baseMessage - The base SDK message
   * @param turnContext - Context to inject
   * @returns Modified SDK message with injected context
   */
  function applyTurnContext(
    baseMessage: SDKUserMessage,
    turnContext: Record<string, JsonValue | undefined>,
  ): SDKUserMessage {
    let result = baseMessage;
    const blocks = serializeTurnContext(turnContext);
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      result = prependContextBlock(result, block.tag, block.content);
    }

    return result;
  }

  it('should prepend skills as markdown sections', () => {
    const baseMessage = createTestMessage('User query');
    const turnContext = {
      skills: [
        { name: 'Code Style', content: 'Use TypeScript strict mode' },
        { name: 'Testing', content: 'Write unit tests for all public functions' },
      ],
    };

    const result = applyTurnContext(baseMessage, turnContext);
    const textBlocks = extractTextContent(result);

    expect(textBlocks[0]).toContain('<skills>');
    expect(textBlocks[0]).toContain('## Code Style\nUse TypeScript strict mode');
    expect(textBlocks[0]).toContain('## Testing\nWrite unit tests for all public functions');
    expect(textBlocks[0]).toContain('</skills>');
  });

  it('should serialize predictedTools as JSON', () => {
    const baseMessage = createTestMessage('User query');
    const turnContext = {
      predictedTools: ['read_file', 'write_file', 'run_command'],
    };

    const result = applyTurnContext(baseMessage, turnContext);
    const textBlocks = extractTextContent(result);

    expect(textBlocks[0]).toContain('<predictedTools>');
    expect(textBlocks[0]).toContain('"read_file"');
    expect(textBlocks[0]).toContain('"write_file"');
    expect(textBlocks[0]).toContain('"run_command"');
    expect(textBlocks[0]).toContain('</predictedTools>');
  });

  it('should handle multiple turnContext keys', () => {
    const baseMessage = createTestMessage('User query');
    const turnContext = {
      skills: [{ name: 'Guide1', content: 'Content1' }],
      predictedTools: ['tool1'],
      customKey: { data: 'value' },
    };

    const result = applyTurnContext(baseMessage, turnContext);
    const textBlocks = extractTextContent(result);

    // Ordering is deterministic: serializeTurnContext places skills first, then remaining keys alphabetically.
    expect(textBlocks).toHaveLength(4);
    expect(textBlocks[0]).toContain('<skills>');
    expect(textBlocks[1]).toContain('<customKey>');
    expect(textBlocks[2]).toContain('<predictedTools>');
    expect(textBlocks[3]).toBe('User query');
  });

  it('should filter out invalid skills', () => {
    const baseMessage = createTestMessage('User query');
    const turnContext: Record<string, JsonValue | undefined> = {
      skills: [
        { name: 'Valid', content: 'Valid content' } as Record<string, JsonValue>,
        { invalid: 'object' } as Record<string, JsonValue>, // Missing name/content
        'string not object',
        null,
        { name: 'Also Valid', content: 'More content' } as Record<string, JsonValue>,
      ] as JsonValue[],
    };

    const result = applyTurnContext(baseMessage, turnContext);
    const textBlocks = extractTextContent(result);

    expect(textBlocks[0]).toContain('## Valid\nValid content');
    expect(textBlocks[0]).toContain('## Also Valid\nMore content');
    expect(textBlocks[0]).not.toContain('invalid');
    expect(textBlocks[0]).not.toContain('string not object');
  });

  it('should skip undefined and null values', () => {
    const baseMessage = createTestMessage('User query');
    const turnContext = {
      validKey: 'valid',
      undefinedKey: undefined,
      nullKey: null,
    };

    const result = applyTurnContext(baseMessage, turnContext);
    const textBlocks = extractTextContent(result);
    const fullText = textBlocks.join('\n');

    expect(fullText).toContain('<validKey>');
    expect(fullText).not.toContain('<undefinedKey>');
    expect(fullText).not.toContain('<nullKey>');
  });

  it('should handle empty skills array', () => {
    const baseMessage = createTestMessage('User query');
    const turnContext = {
      skills: [],
    };

    const result = applyTurnContext(baseMessage, turnContext);
    const textBlocks = extractTextContent(result);

    // Empty skills should not add a skills block
    expect(textBlocks.join('\n')).not.toContain('<skills>');
  });
});

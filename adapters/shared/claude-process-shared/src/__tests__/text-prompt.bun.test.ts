import { describe, expect, it } from 'bun:test';
import { MessageHandle } from '@makaio/ai-adapters-core';
import { buildTextPrompt, extractMessageText } from '../text-prompt.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal NormalizedMessageInput for testing.
 * @param text - Text content for the single text block
 * @returns Minimal normalized message input
 */
function makeMessage(text: string) {
  return {
    role: 'user' as const,
    blocks: [{ type: 'text' as const, content: text }],
    message: text,
  };
}

/**
 * Build a MessageHandle with the given text and optional context.
 * @param text - User message text
 * @param options - Optional turn context and message history
 * @returns A minimal MessageHandle ready for prompt assembly
 */
function makeHandle(
  text: string,
  options: {
    turnContext?: Record<string, unknown>;
    messageHistory?: Array<{ role: 'user' | 'assistant'; blocks: Array<{ type: 'text'; content: string }> }>;
  } = {},
): MessageHandle {
  return new MessageHandle(
    'test-message-id',
    makeMessage(text),
    'enqueue',
    options.messageHistory as MessageHandle['messageHistory'],
    options.turnContext as MessageHandle['turnContext'],
  );
}

// ---------------------------------------------------------------------------
// extractMessageText
// ---------------------------------------------------------------------------

describe('extractMessageText', () => {
  it('returns text block content for a single text block', () => {
    const message = makeMessage('hello world');
    expect(extractMessageText(message)).toBe('hello world');
  });

  it('joins multiple text blocks with newline', () => {
    const message = {
      role: 'user' as const,
      blocks: [
        { type: 'text' as const, content: 'line one' },
        { type: 'text' as const, content: 'line two' },
      ],
      message: 'line one',
    };
    expect(extractMessageText(message)).toBe('line one\nline two');
  });

  it('falls back to message field when no text blocks are present', () => {
    const message = {
      role: 'user' as const,
      blocks: [
        {
          type: 'image' as const,
          source: { type: 'url' as const, url: 'http://example.com/img.png' },
        },
      ],
      message: 'fallback text',
    };
    expect(extractMessageText(message)).toBe('fallback text');
  });

  it('returns empty string when blocks are empty and message is absent', () => {
    const message = {
      role: 'user' as const,
      blocks: [] as Array<{ type: 'text'; content: string }>,
      message: undefined,
    };
    expect(extractMessageText(message)).toBe('');
  });

  it('silently skips non-text blocks and includes only text blocks', () => {
    const message = {
      role: 'user' as const,
      blocks: [
        {
          type: 'image' as const,
          source: { type: 'url' as const, url: 'http://example.com/img.png' },
        },
        { type: 'text' as const, content: 'actual text' },
      ],
      message: 'fallback',
    };
    expect(extractMessageText(message)).toBe('actual text');
  });
});

// ---------------------------------------------------------------------------
// buildTextPrompt
// ---------------------------------------------------------------------------

describe('buildTextPrompt', () => {
  it('returns just the user text when there is no context, history or merged content', () => {
    const handle = makeHandle('plain user message');
    expect(buildTextPrompt(handle)).toBe('plain user message');
  });

  it('prepends merged_context block when mergedContent is provided', () => {
    const handle = makeHandle('user text');
    const result = buildTextPrompt(handle, ['merged payload']);
    expect(result).toMatch(/^<merged_context>/);
    expect(result).toContain('merged payload');
    expect(result).toContain('user text');
  });

  it('joins multiple mergedContent entries with newline inside the block', () => {
    const handle = makeHandle('user text');
    const result = buildTextPrompt(handle, ['part one', 'part two']);
    expect(result).toContain('part one\npart two');
  });

  it('includes message_history block when handle has history', () => {
    const handle = makeHandle('new question', {
      messageHistory: [
        { role: 'user', blocks: [{ type: 'text', content: 'first question' }] },
        { role: 'assistant', blocks: [{ type: 'text', content: 'first answer' }] },
      ],
    });
    const result = buildTextPrompt(handle);
    expect(result).toContain('<message_history>');
    expect(result).toContain('User: first question');
    expect(result).toContain('Assistant: first answer');
    expect(result).toContain('new question');
  });

  it('produces the canonical segment order: merged_context → turn_context → message_history → user text', () => {
    const handle = makeHandle('user text', {
      turnContext: { cwd: '/workspace' },
      messageHistory: [{ role: 'user', blocks: [{ type: 'text', content: 'earlier message' }] }],
    });
    const result = buildTextPrompt(handle, ['merged payload']);

    const mergedPos = result.indexOf('<merged_context>');
    const cwdPos = result.indexOf('<cwd>');
    const historyPos = result.indexOf('<message_history>');
    const userTextPos = result.lastIndexOf('user text');

    expect(mergedPos).toBeLessThan(cwdPos);
    expect(cwdPos).toBeLessThan(historyPos);
    expect(historyPos).toBeLessThan(userTextPos);
  });

  it('omits merged_context when mergedContent is an empty array', () => {
    const handle = makeHandle('user text');
    const result = buildTextPrompt(handle, []);
    expect(result).not.toContain('<merged_context>');
    expect(result).toBe('user text');
  });

  it('omits merged_context when mergedContent is undefined', () => {
    const handle = makeHandle('user text');
    const result = buildTextPrompt(handle);
    expect(result).not.toContain('<merged_context>');
  });

  it('separates segments with double newlines', () => {
    const handle = makeHandle('user text', {
      messageHistory: [{ role: 'user', blocks: [{ type: 'text', content: 'prev' }] }],
    });
    const result = buildTextPrompt(handle);
    expect(result).toContain('\n\n');
    // No triple newlines between segments
    expect(result).not.toContain('\n\n\n');
  });
});

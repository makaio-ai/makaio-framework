import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../buildSystemPrompt.js';

describe('buildSystemPrompt', () => {
  it('replaces the provider prompt when runtime instructions are a string', () => {
    const result = buildSystemPrompt('Base prompt', 'Replacement prompt');

    expect(result).toBe('Replacement prompt');
  });

  it('appends runtime instructions to a string provider prompt', () => {
    const result = buildSystemPrompt('Base prompt', {
      mode: 'append',
      content: 'Appended content',
    });

    expect(result).toBe('Base prompt Appended content');
  });

  it('uses runtime append content when the provider prompt is undefined', () => {
    const result = buildSystemPrompt(undefined, {
      mode: 'append',
      content: 'Only content',
    });

    expect(result).toBe('Only content');
  });

  it('preserves Claude SDK prompt arrays when appending runtime instructions', () => {
    const result = buildSystemPrompt(['Static instructions', 'Dynamic boundary'], {
      mode: 'append',
      content: 'Runtime append',
    });

    expect(result).toEqual(['Static instructions', 'Dynamic boundary', 'Runtime append']);
  });

  it('preserves preset prompt metadata while appending runtime instructions', () => {
    const result = buildSystemPrompt(
      {
        type: 'preset',
        preset: 'claude_code',
        excludeDynamicSections: true,
      },
      {
        mode: 'append',
        content: 'Runtime append',
      },
    );

    expect(result).toEqual({
      type: 'preset',
      preset: 'claude_code',
      excludeDynamicSections: true,
      append: 'Runtime append',
    });
  });

  it('adds the continuation instruction without collapsing preset prompts to plain strings', () => {
    const result = buildSystemPrompt(
      {
        type: 'preset',
        preset: 'claude_code',
        append: 'Base append',
      },
      undefined,
    );

    expect(result).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Base append You are naturally continuing a conversation with user.',
    });
  });
});

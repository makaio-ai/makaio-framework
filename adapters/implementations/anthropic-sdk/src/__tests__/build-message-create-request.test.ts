/**
 * Tests for buildMessageCreateRequest.
 *
 * Exercises the assembly of Anthropic messages.create() parameters from
 * Makaio-level inputs.  Pure function, no I/O.
 */

import { describe, it, expect } from 'vitest';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { buildMessageCreateRequest } from '../utils/buildMessageCreateRequest.js';

/** Minimal user messages array for building request params. */
const MESSAGES: MessageParam[] = [{ role: 'user', content: 'Hello' }];

describe('buildMessageCreateRequest', () => {
  describe('defaults', () => {
    it('sets max_tokens to 32000 when not overridden', () => {
      const result = buildMessageCreateRequest({ model: 'claude-sonnet-4-20250514', messages: MESSAGES });

      expect(result.max_tokens).toBe(32_000);
    });

    it('always sets stream to true', () => {
      const result = buildMessageCreateRequest({ model: 'claude-sonnet-4-20250514', messages: MESSAGES });

      expect(result.stream).toBe(true);
    });

    it('passes through model and messages unchanged', () => {
      const result = buildMessageCreateRequest({ model: 'claude-opus-4-20250514', messages: MESSAGES });

      expect(result.model).toBe('claude-opus-4-20250514');
      expect(result.messages).toBe(MESSAGES);
    });
  });

  describe('system prompt', () => {
    it('omits system field when no systemPrompt is provided', () => {
      const result = buildMessageCreateRequest({ model: 'claude-sonnet-4-20250514', messages: MESSAGES });

      expect(result).not.toHaveProperty('system');
    });

    it('sets system as a TextBlockParam array with ephemeral cache_control', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        systemPrompt: 'You are a helpful assistant.',
      });

      expect(result.system).toEqual([
        {
          type: 'text',
          text: 'You are a helpful assistant.',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('omits system field when systemPrompt is an empty string', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        systemPrompt: '',
      });

      expect(result).not.toHaveProperty('system');
    });
  });

  describe('tools', () => {
    it('omits tools field when tools array is empty', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        tools: [],
      });

      expect(result).not.toHaveProperty('tools');
    });

    it('omits tools field when tools is undefined', () => {
      const result = buildMessageCreateRequest({ model: 'claude-sonnet-4-20250514', messages: MESSAGES });

      expect(result).not.toHaveProperty('tools');
    });

    it('includes tools field when a non-empty tools array is provided', () => {
      const tools: Tool[] = [
        {
          name: 'bash',
          description: 'Execute a shell command',
          input_schema: { type: 'object', properties: {}, required: [] },
        },
      ];

      const result = buildMessageCreateRequest({ model: 'claude-sonnet-4-20250514', messages: MESSAGES, tools });

      expect(result.tools).toEqual(tools);
    });
  });

  describe('maxTokens', () => {
    it('uses provided maxTokens when specified', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        maxTokens: 8_000,
      });

      expect(result.max_tokens).toBe(8_000);
    });

    it('caps thinking budget_tokens below provided maxTokens', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        reasoningEffort: 'high',
        supportsReasoningEffort: true,
        maxTokens: 10_000,
      });

      expect(result.max_tokens).toBe(10_000);
      // reasoningEffort 'high' = 16000 budget, but must be < maxTokens (10000), so capped at 9999
      expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 9_999 });
    });
  });

  describe('responseSchema', () => {
    it('adds output_config for response schema descriptors', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        responseSchema: { schema: { type: 'object' }, name: 'object_schema' },
      });

      expect(result.output_config).toEqual({ format: { type: 'json_schema', schema: { type: 'object' } } });
    });

    it('omits output_config when responseSchema is not provided', () => {
      const result = buildMessageCreateRequest({ model: 'claude-sonnet-4-20250514', messages: MESSAGES });

      expect(result).not.toHaveProperty('output_config');
    });
  });

  describe('thinking config', () => {
    it('omits thinking field when reasoningEffort is undefined', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        supportsReasoningEffort: true,
      });

      expect(result).not.toHaveProperty('thinking');
    });

    it('omits thinking field when supportsReasoningEffort is false', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        reasoningEffort: 'medium',
        supportsReasoningEffort: false,
      });

      expect(result).not.toHaveProperty('thinking');
    });

    it('omits thinking field when reasoningEffort is "none"', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        reasoningEffort: 'none',
        supportsReasoningEffort: true,
      });

      expect(result).not.toHaveProperty('thinking');
    });

    it('sets thinking with budget_tokens 8000 for reasoningEffort "medium"', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        reasoningEffort: 'medium',
        supportsReasoningEffort: true,
      });

      expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
    });

    it('sets thinking with budget_tokens 4000 for reasoningEffort "low"', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        reasoningEffort: 'low',
        supportsReasoningEffort: true,
      });

      expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
    });

    it('sets thinking with budget_tokens 16000 for reasoningEffort "high"', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        reasoningEffort: 'high',
        supportsReasoningEffort: true,
      });

      expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    });

    it('caps thinking budget below max_tokens for reasoningEffort "extra-high"', () => {
      const result = buildMessageCreateRequest({
        model: 'claude-sonnet-4-20250514',
        messages: MESSAGES,
        reasoningEffort: 'extra-high',
        supportsReasoningEffort: true,
      });

      expect(result.max_tokens).toBe(32_000);
      expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 31_999 });
    });
  });
});

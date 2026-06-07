import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { createLangfuseShouldExportSpan } from '../filters.js';

/**
 * Build a minimal ReadableSpan stub for filter tests.
 * @param name - Span name.
 * @param attributes - Span attributes keyed by string.
 * @returns A partial ReadableSpan cast for use in predicate tests.
 */
function span(name: string, attributes: Attributes): ReadableSpan {
  return {
    name,
    attributes,
    instrumentationScope: {
      name: 'makaio.telemetry-otel',
      version: undefined,
      schemaUrl: undefined,
    },
  } as unknown as ReadableSpan;
}

describe('createLangfuseShouldExportSpan', () => {
  describe('llm-only', () => {
    const filter = createLangfuseShouldExportSpan('llm-only');

    it('exports GenAI spans', () => {
      expect(
        filter({
          otelSpan: span('LLM call gpt-5.4', { 'gen_ai.operation.name': 'chat' }),
        }),
      ).toBe(true);
    });

    it('exports GenAI spans with other gen_ai.* attribute keys', () => {
      expect(
        filter({
          otelSpan: span('Embedding call', { 'gen_ai.system': 'openai' }),
        }),
      ).toBe(true);
    });

    it('exports Makaio execution root spans for trace grouping', () => {
      expect(
        filter({
          otelSpan: span('Workflow wfx-1', { 'makaio.execution.id': 'wfx-1' }),
        }),
      ).toBe(true);
    });

    it('exports workflow frame spans so GenAI child observations keep their parents', () => {
      expect(
        filter({
          otelSpan: span('Frame analyze', {
            'makaio.frame.id': 'frame-1',
          }),
        }),
      ).toBe(true);
    });

    it('exports tool spans identified by tool.call_id', () => {
      expect(
        filter({
          otelSpan: span('Tool read', { 'tool.call_id': 'call-1' }),
        }),
      ).toBe(true);
    });

    it('exports tool spans identified by gen_ai.operation.name=execute_tool', () => {
      expect(
        filter({
          otelSpan: span('Tool execute', { 'gen_ai.operation.name': 'execute_tool' }),
        }),
      ).toBe(true);
    });

    it('excludes spans with no matching attributes', () => {
      expect(
        filter({
          otelSpan: span('Internal step', { 'http.method': 'GET' }),
        }),
      ).toBe(false);
    });
  });

  describe('full-trace', () => {
    const filter = createLangfuseShouldExportSpan('full-trace');

    it('exports every span regardless of attributes', () => {
      expect(
        filter({
          otelSpan: span('Frame analyze', { 'makaio.frame.id': 'frame-1' }),
        }),
      ).toBe(true);
    });

    it('exports spans with no attributes', () => {
      expect(filter({ otelSpan: span('Empty span', {}) })).toBe(true);
    });
  });
});

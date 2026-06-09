import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type ResponseSchemaDescriptor } from '@makaio/contracts';
import { AgentStructuredOutputManager } from '../agent-structured-output-manager.js';

const descriptor: ResponseSchemaDescriptor = {
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
  name: 'answer_schema',
};

beforeEach(() => {
  MakaioBus.__resetHandlers?.();
});

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

describe('AgentStructuredOutputManager', () => {
  it('marks valid JSON output as passed', async () => {
    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: ['structuredOutput'],
    });

    const result = await manager.validateTerminalResult({
      responseSchema: descriptor,
      message: '{"answer":"ok"}',
      sessionId: 'session-1',
    });

    expect(result.message).toBe('{"answer":"ok"}');
    expect(result.structuredOutputValidation).toMatchObject({ status: 'passed' });
  });

  it('validates schema descriptors that advertise JSON Schema draft 2020-12', async () => {
    const draft202012Descriptor: ResponseSchemaDescriptor = {
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      name: 'draft_2020_12_schema',
    };
    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: ['structuredOutput'],
    });

    const result = await manager.validateTerminalResult({
      responseSchema: draft202012Descriptor,
      message: '{"answer":"ok"}',
      sessionId: 'session-1',
    });

    expect(result.structuredOutputValidation).toEqual({ status: 'passed' });
  });

  it('validates schema descriptors that advertise JSON Schema draft 2019-09', async () => {
    const draft201909Descriptor: ResponseSchemaDescriptor = {
      schema: {
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      name: 'draft_2019_09_schema',
    };
    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: ['structuredOutput'],
    });

    const result = await manager.validateTerminalResult({
      responseSchema: draft201909Descriptor,
      message: '{"answer":"ok"}',
      sessionId: 'session-1',
    });

    expect(result.structuredOutputValidation).toEqual({ status: 'passed' });
  });

  it('falls back to draft-07 validation when the schema URI is unrecognized', async () => {
    const unknownDraftDescriptor: ResponseSchemaDescriptor = {
      schema: {
        $schema: 'https://example.com/json-schema/unknown-draft',
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      name: 'unknown_draft_schema',
    };
    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: ['structuredOutput'],
    });

    const result = await manager.validateTerminalResult({
      responseSchema: unknownDraftDescriptor,
      message: '{"answer":7}',
      sessionId: 'session-1',
    });

    expect(result.structuredOutputValidation).toEqual({
      status: 'failed',
      errors: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('must be string') })]),
    });
  });

  it('returns validation errors when schema compilation fails', async () => {
    const malformedDescriptor: ResponseSchemaDescriptor = {
      schema: {
        type: 'object',
        properties: 'not an object',
      },
      name: 'malformed_schema',
    };
    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: ['structuredOutput'],
    });

    const firstResult = await manager.validateTerminalResult({
      responseSchema: malformedDescriptor,
      message: '{"answer":"ok"}',
      sessionId: 'session-1',
    });
    const cachedResult = await manager.validateTerminalResult({
      responseSchema: malformedDescriptor,
      message: '{"answer":"ok"}',
      sessionId: 'session-1',
    });

    expect(firstResult.structuredOutputValidation).toEqual({
      status: 'failed',
      errors: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('Failed to compile response schema') }),
      ]),
    });
    expect(cachedResult.structuredOutputValidation).toEqual(firstResult.structuredOutputValidation);
  });

  it('returns failed status when message is invalid JSON and no enforce handler', async () => {
    // Register a do-nothing enforce handler
    MakaioBus.on(AgentSubjects.structuredOutput.enforce, (ctx) => {
      ctx.setResult({ enforced: false, error: 'disabled in test' });
    });

    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
    });

    const result = await manager.validateTerminalResult({
      responseSchema: descriptor,
      message: 'not json',
      sessionId: 'session-1',
    });

    expect(result.message).toBe('not json');
    expect(result.structuredOutputValidation).toMatchObject({ status: 'failed' });
  });

  it('uses enforce output after validation failure and exhausted retries', async () => {
    MakaioBus.on(AgentSubjects.structuredOutput.retryPolicy, (ctx) => {
      ctx.setResult({ maxRetries: 0 });
    });
    MakaioBus.on(AgentSubjects.structuredOutput.enforce, (ctx) => {
      expect(ctx.payload.rawOutput).toBe('not json');
      ctx.setResult({ enforced: true, output: '{"answer":"fixed"}' });
    });

    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
    });

    const result = await manager.validateTerminalResult({
      responseSchema: descriptor,
      message: 'not json',
      sessionId: 'session-1',
    });

    expect(result.message).toBe('{"answer":"fixed"}');
    expect(result.structuredOutputValidation).toMatchObject({ status: 'enforced' });
  });

  it('returns failed when enforce returns output that does not conform', async () => {
    MakaioBus.on(AgentSubjects.structuredOutput.enforce, (ctx) => {
      ctx.setResult({ enforced: true, output: '{"wrong":true}' });
    });

    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
    });

    const result = await manager.validateTerminalResult({
      responseSchema: descriptor,
      message: 'not json',
      sessionId: 'session-1',
    });

    // Enforced output is itself invalid → fall through to failed
    expect(result.structuredOutputValidation).toMatchObject({ status: 'failed' });
  });

  it('returns failed for empty message', async () => {
    MakaioBus.on(AgentSubjects.structuredOutput.enforce, (ctx) => {
      ctx.setResult({ enforced: false, error: 'disabled in test' });
    });

    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
    });

    const result = await manager.validateTerminalResult({
      responseSchema: descriptor,
      message: undefined,
      sessionId: 'session-1',
    });

    expect(result.structuredOutputValidation).toMatchObject({ status: 'failed' });
  });

  it('uses retry callback before enforcement when retry policy allows it', async () => {
    let retryPolicyPayload: unknown;
    MakaioBus.on(AgentSubjects.structuredOutput.retryPolicy, (ctx) => {
      retryPolicyPayload = ctx.payload;
      ctx.setResult({ maxRetries: 1 });
    });
    MakaioBus.on(AgentSubjects.structuredOutput.enforce, (ctx) => {
      ctx.setResult({ enforced: false, error: 'disabled in test' });
    });

    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
    });

    const result = await manager.validateTerminalResult({
      responseSchema: descriptor,
      message: 'not json',
      retryTurn: async () => '{"answer":"retried"}',
    });

    expect(retryPolicyPayload).toMatchObject({ attemptNumber: 1, adapterCapabilities: [] });
    expect(result.message).toBe('{"answer":"retried"}');
    expect(result.structuredOutputValidation).toMatchObject({ status: 'passed' });
  });

  it('does not retry with only the registered default retry policy', async () => {
    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
    });
    const cleanups = manager.registerDefaultHandlers();

    try {
      const retryTurn = vi.fn(async () => '{"answer":"default-retry"}');

      const result = await manager.validateTerminalResult({
        responseSchema: descriptor,
        message: 'not json',
        retryTurn,
      });

      expect(retryTurn).not.toHaveBeenCalled();
      expect(result.message).toBe('not json');
      expect(result.structuredOutputValidation).toMatchObject({ status: 'failed' });
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });

  it('lets host retry-policy handlers opt into retries over the low-priority default', async () => {
    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
    });
    const cleanups = manager.registerDefaultHandlers();

    try {
      MakaioBus.on(AgentSubjects.structuredOutput.retryPolicy, (ctx) => {
        ctx.setResult({ maxRetries: 1 });
      });
      const retryTurn = vi.fn(async () => '{"answer":"host-retry"}');

      const result = await manager.validateTerminalResult({
        responseSchema: descriptor,
        message: 'not json',
        retryTurn,
      });

      expect(retryTurn).toHaveBeenCalledTimes(1);
      expect(result.message).toBe('{"answer":"host-retry"}');
      expect(result.structuredOutputValidation).toMatchObject({ status: 'passed' });
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });

  it('uses the last retry output and errors when enforcement runs after retry exhaustion', async () => {
    MakaioBus.on(AgentSubjects.structuredOutput.retryPolicy, (ctx) => {
      ctx.setResult({ maxRetries: 2 });
    });
    const retryTurn = vi.fn(async ({ attemptNumber }: { attemptNumber: number }) =>
      attemptNumber === 1 ? '{"wrong":true}' : '{"answer":7}',
    );
    let enforcePayload: unknown;
    MakaioBus.on(AgentSubjects.structuredOutput.enforce, (ctx) => {
      enforcePayload = ctx.payload;
      ctx.setResult({ enforced: false, error: 'disabled in test' });
    });

    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
    });

    const result = await manager.validateTerminalResult({
      responseSchema: descriptor,
      message: 'not json',
      retryTurn,
    });

    expect(retryTurn).toHaveBeenCalledTimes(2);
    expect(enforcePayload).toMatchObject({
      rawOutput: '{"answer":7}',
      validationErrors: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('must be string') }),
      ]),
    });
    expect(result.message).toBe('{"answer":7}');
    expect(result.structuredOutputValidation).toMatchObject({ status: 'failed' });
  });

  it('registerDefaultHandlers returns two cleanup functions', () => {
    const manager = new AgentStructuredOutputManager({
      bus: MakaioBus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
    });

    const cleanups = manager.registerDefaultHandlers();
    expect(cleanups).toHaveLength(2);
    cleanups.forEach((cleanup) => expect(typeof cleanup).toBe('function'));
  });
});

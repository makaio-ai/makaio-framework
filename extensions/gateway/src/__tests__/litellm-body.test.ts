import { describe, expect, it } from 'vitest';
import type { LitellmRouteDecision } from '../routing/types.js';
import type { ReasoningMode } from '../config.js';
import {
  EFFORT_BUDGET_TOKENS,
  InvalidMessagesBodyError,
  parseMessagesBody,
  prepareLitellmBody,
  prepareLitellmHeaders,
} from '../routing/litellm-body.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDecision(
  upstreamModel: string,
  reasoning: ReasoningMode,
  masterKey = 'sk-test-key',
): LitellmRouteDecision {
  return {
    target: {
      kind: 'litellm',
      name: 'litellm',
      url: 'http://localhost:4000',
      masterKey,
      reasoning,
    },
    ruleIndex: 0,
    upstreamModel,
  };
}

/**
 * Encode a plain object to UTF-8 JSON bytes as `prepareLitellmBody` does.
 * @param obj - Object to encode.
 */
function encodeBody(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Decode UTF-8 JSON bytes back to a plain object for assertions.
 * Only used in tests where we know the output is always an object.
 * @param bytes - UTF-8 encoded JSON bytes.
 */
function decodeBody(bytes: Uint8Array): Record<string, unknown> {
  const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Test helper: decoded body is not an object');
  }
  return raw as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// EFFORT_BUDGET_TOKENS
// ---------------------------------------------------------------------------

describe('EFFORT_BUDGET_TOKENS', () => {
  it('maps low to 1024, medium to 2048, high to 4096', () => {
    expect(EFFORT_BUDGET_TOKENS.low).toBe(1024);
    expect(EFFORT_BUDGET_TOKENS.medium).toBe(2048);
    expect(EFFORT_BUDGET_TOKENS.high).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// prepareLitellmBody — model substitution
// ---------------------------------------------------------------------------

describe('prepareLitellmBody — model substitution', () => {
  it('sets model to decision.upstreamModel when different from parsed model', () => {
    const parsed = { model: 'claude-3-5-sonnet', stream: true };
    const decision = makeDecision('DeepSeek-V4-Flash-0731', { mode: 'passthrough' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['model']).toBe('DeepSeek-V4-Flash-0731');
  });

  it('preserves model when upstreamModel matches the parsed model', () => {
    const parsed = { model: 'deepseek-v4', stream: false };
    const decision = makeDecision('deepseek-v4', { mode: 'passthrough' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['model']).toBe('deepseek-v4');
  });
});

// ---------------------------------------------------------------------------
// prepareLitellmBody — passthrough reasoning mode
// ---------------------------------------------------------------------------

describe('prepareLitellmBody — passthrough mode', () => {
  it('adds allowed_openai_params when thinking is absent', () => {
    const parsed = { model: 'x', stream: true };
    const decision = makeDecision('upstream-x', { mode: 'passthrough' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['allowed_openai_params']).toEqual(['reasoning_effort']);
    expect(result).not.toHaveProperty('drop_params');
  });

  it('adds allowed_openai_params and leaves thinking untouched when present', () => {
    const parsed = { model: 'x', thinking: { type: 'adaptive' }, stream: true };
    const decision = makeDecision('upstream-x', { mode: 'passthrough' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['thinking']).toEqual({ type: 'adaptive' });
    expect(result['allowed_openai_params']).toEqual(['reasoning_effort']);
  });

  it('appends reasoning_effort to pre-existing allowed_openai_params', () => {
    const parsed = { model: 'x', allowed_openai_params: ['some_other_param'] };
    const decision = makeDecision('upstream-x', { mode: 'passthrough' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['allowed_openai_params']).toEqual(['some_other_param', 'reasoning_effort']);
  });

  it('does not duplicate reasoning_effort when already in allowed_openai_params', () => {
    const parsed = {
      model: 'x',
      allowed_openai_params: ['reasoning_effort', 'some_other_param'],
    };
    const decision = makeDecision('upstream-x', { mode: 'passthrough' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['allowed_openai_params']).toEqual(['reasoning_effort', 'some_other_param']);
  });

  it('replaces a non-array allowed_openai_params with a fresh array', () => {
    const parsed = { model: 'x', allowed_openai_params: 'bad-scalar' };
    const decision = makeDecision('upstream-x', { mode: 'passthrough' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['allowed_openai_params']).toEqual(['reasoning_effort']);
  });
});

// ---------------------------------------------------------------------------
// prepareLitellmBody — drop reasoning mode
// ---------------------------------------------------------------------------

describe('prepareLitellmBody — drop mode', () => {
  it('adds drop_params: true when thinking is absent', () => {
    const parsed = { model: 'x' };
    const decision = makeDecision('upstream-x', { mode: 'drop' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['drop_params']).toBe(true);
    expect(result).not.toHaveProperty('allowed_openai_params');
  });

  it('removes thinking from the body and sets drop_params: true', () => {
    const parsed = { model: 'x', thinking: { type: 'adaptive' } };
    const decision = makeDecision('upstream-x', { mode: 'drop' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result).not.toHaveProperty('thinking');
    expect(result['drop_params']).toBe(true);
  });

  it('removes output_config.effort while preserving remaining output_config keys', () => {
    const parsed = { model: 'x', output_config: { effort: 'medium', format: 'text' } };
    const decision = makeDecision('upstream-x', { mode: 'drop' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['output_config']).toEqual({ format: 'text' });
    expect(result['drop_params']).toBe(true);
  });

  it('removes output_config entirely when only effort was present', () => {
    const parsed = { model: 'x', output_config: { effort: 'high' } };
    const decision = makeDecision('upstream-x', { mode: 'drop' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result).not.toHaveProperty('output_config');
    expect(result['drop_params']).toBe(true);
  });

  it("does not mutate the caller's parsed body when removing output_config.effort", () => {
    // prepareLitellmBody never mutates caller-owned input — including objects
    // reachable only through the shallow copy it makes.
    const outputConfig = { effort: 'medium', format: 'text' };
    const parsed = { model: 'x', output_config: outputConfig };
    const decision = makeDecision('upstream-x', { mode: 'drop' });

    const result = decodeBody(prepareLitellmBody(parsed, decision));

    expect(result['output_config']).toEqual({ format: 'text' });
    expect(outputConfig).toEqual({ effort: 'medium', format: 'text' });
    expect(parsed.output_config).toBe(outputConfig);
  });

  it("does not mutate the caller's parsed body when output_config held only effort", () => {
    const outputConfig = { effort: 'high' };
    const parsed = { model: 'x', output_config: outputConfig };
    const decision = makeDecision('upstream-x', { mode: 'drop' });

    const result = decodeBody(prepareLitellmBody(parsed, decision));

    expect(result).not.toHaveProperty('output_config');
    expect(outputConfig).toEqual({ effort: 'high' });
  });

  it('leaves output_config untouched when effort key is absent', () => {
    const parsed = { model: 'x', output_config: { format: 'json' } };
    const decision = makeDecision('upstream-x', { mode: 'drop' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['output_config']).toEqual({ format: 'json' });
  });

  it('keeps drop_params: true when already true in the incoming body', () => {
    const parsed = { model: 'x', drop_params: true };
    const decision = makeDecision('upstream-x', { mode: 'drop' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['drop_params']).toBe(true);
  });

  it('upgrades drop_params from false to true (never downgrades)', () => {
    const parsed = { model: 'x', drop_params: false };
    const decision = makeDecision('upstream-x', { mode: 'drop' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['drop_params']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// prepareLitellmBody — fixed reasoning mode
// ---------------------------------------------------------------------------

describe('prepareLitellmBody — fixed mode', () => {
  it('inserts thinking with low effort (1024) when thinking is absent', () => {
    const parsed = { model: 'x' };
    const decision = makeDecision('upstream-x', { mode: 'fixed', effort: 'low' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(result['allowed_openai_params']).toEqual(['reasoning_effort']);
  });

  it('replaces thinking with medium effort (2048) even when thinking is present', () => {
    const parsed = { model: 'x', thinking: { type: 'adaptive' } };
    const decision = makeDecision('upstream-x', { mode: 'fixed', effort: 'medium' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(result['allowed_openai_params']).toEqual(['reasoning_effort']);
  });

  it('sets budget_tokens to 4096 for high effort', () => {
    const parsed = { model: 'x' };
    const decision = makeDecision('upstream-x', { mode: 'fixed', effort: 'high' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['thinking']).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('merges reasoning_effort into pre-existing allowed_openai_params for fixed mode', () => {
    const parsed = { model: 'x', allowed_openai_params: ['vision'] };
    const decision = makeDecision('upstream-x', { mode: 'fixed', effort: 'medium' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['allowed_openai_params']).toEqual(['vision', 'reasoning_effort']);
  });

  it('does not duplicate reasoning_effort in fixed mode when already present', () => {
    const parsed = { model: 'x', allowed_openai_params: ['reasoning_effort'] };
    const decision = makeDecision('upstream-x', { mode: 'fixed', effort: 'low' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));
    expect(result['allowed_openai_params']).toEqual(['reasoning_effort']);
  });
});

// ---------------------------------------------------------------------------
// prepareLitellmBody — realistic Claude Code body round-trip
// ---------------------------------------------------------------------------

describe('prepareLitellmBody — realistic Claude Code body round-trip', () => {
  it('mutates only model and allowed_openai_params; leaves all other fields intact', () => {
    const systemBlock = [
      {
        type: 'text',
        text: 'You are a helpful assistant.',
        cache_control: { type: 'ephemeral' },
      },
    ];
    const tools = [
      {
        name: 'bash',
        description: 'Run a shell command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ];
    const metadata = { user_id: 'user-42' };
    const messages = [{ role: 'user', content: 'Hello' }];

    const parsed: Record<string, unknown> = {
      model: 'claude-opus-4-5',
      system: systemBlock,
      messages,
      tools,
      metadata,
      stream: true,
      max_tokens: 16384,
      thinking: { type: 'adaptive' },
    };

    const decision = makeDecision('DeepSeek-V4-Flash-0731', { mode: 'passthrough' });
    const result = decodeBody(prepareLitellmBody(parsed, decision));

    const expected: Record<string, unknown> = {
      model: 'DeepSeek-V4-Flash-0731',
      system: systemBlock,
      messages,
      tools,
      metadata,
      stream: true,
      max_tokens: 16384,
      thinking: { type: 'adaptive' },
      allowed_openai_params: ['reasoning_effort'],
    };

    expect(result).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// prepareLitellmHeaders
// ---------------------------------------------------------------------------

describe('prepareLitellmHeaders', () => {
  it('replaces authorization header with Bearer master key', () => {
    const incoming = new Headers({
      authorization: 'Bearer old-anthropic-token',
      'anthropic-version': '2023-06-01',
    });
    const result = prepareLitellmHeaders(incoming, 'sk-litellm-master');
    expect(result.get('authorization')).toBe('Bearer sk-litellm-master');
  });

  it('removes x-api-key', () => {
    const incoming = new Headers({
      authorization: 'Bearer token',
      'x-api-key': 'some-api-key',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
    });
    const result = prepareLitellmHeaders(incoming, 'sk-litellm-master');
    expect(result.has('x-api-key')).toBe(false);
  });

  it('preserves anthropic-beta and anthropic-version headers unchanged', () => {
    const incoming = new Headers({
      authorization: 'Bearer token',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
      'anthropic-version': '2023-06-01',
    });
    const result = prepareLitellmHeaders(incoming, 'sk-litellm-master');
    expect(result.get('anthropic-beta')).toBe('interleaved-thinking-2025-05-14');
    expect(result.get('anthropic-version')).toBe('2023-06-01');
  });

  it('preserves other non-auth headers unchanged', () => {
    const incoming = new Headers({
      authorization: 'Bearer old',
      'content-type': 'application/json',
      'x-request-id': 'req-123',
    });
    const result = prepareLitellmHeaders(incoming, 'sk-master');
    expect(result.get('content-type')).toBe('application/json');
    expect(result.get('x-request-id')).toBe('req-123');
  });

  it('does not mutate the original incoming Headers object', () => {
    const incoming = new Headers({ authorization: 'Bearer original' });
    prepareLitellmHeaders(incoming, 'sk-new-key');
    expect(incoming.get('authorization')).toBe('Bearer original');
  });
});

// ---------------------------------------------------------------------------
// parseMessagesBody
// ---------------------------------------------------------------------------

describe('parseMessagesBody', () => {
  it('returns parsed object and model string for a valid body', () => {
    const body = { model: 'claude-opus-4-5', stream: true, max_tokens: 4096 };
    const bytes = encodeBody(body);
    const { parsed, model } = parseMessagesBody(bytes);
    expect(model).toBe('claude-opus-4-5');
    expect(parsed).toEqual(body);
  });

  it('throws InvalidMessagesBodyError for non-JSON input', () => {
    const bytes = new TextEncoder().encode('not-json{{{');
    expect(() => parseMessagesBody(bytes)).toThrow(InvalidMessagesBodyError);
    expect(() => parseMessagesBody(bytes)).toThrow('not valid JSON');
  });

  it('throws InvalidMessagesBodyError for a JSON array at the top level', () => {
    const bytes = new TextEncoder().encode('[{"model":"x"}]');
    expect(() => parseMessagesBody(bytes)).toThrow(InvalidMessagesBodyError);
    expect(() => parseMessagesBody(bytes)).toThrow('JSON object');
  });

  it('throws InvalidMessagesBodyError for a JSON string at the top level', () => {
    const bytes = new TextEncoder().encode('"hello"');
    expect(() => parseMessagesBody(bytes)).toThrow(InvalidMessagesBodyError);
  });

  it('throws InvalidMessagesBodyError for a JSON null at the top level', () => {
    const bytes = new TextEncoder().encode('null');
    expect(() => parseMessagesBody(bytes)).toThrow(InvalidMessagesBodyError);
  });

  it('throws InvalidMessagesBodyError when model is missing', () => {
    const bytes = encodeBody({ stream: true, max_tokens: 1024 });
    expect(() => parseMessagesBody(bytes)).toThrow(InvalidMessagesBodyError);
    expect(() => parseMessagesBody(bytes)).toThrow('"model"');
  });

  it('throws InvalidMessagesBodyError when model is an empty string', () => {
    const bytes = encodeBody({ model: '' });
    expect(() => parseMessagesBody(bytes)).toThrow(InvalidMessagesBodyError);
  });

  it('throws InvalidMessagesBodyError when model is a number', () => {
    const bytes = encodeBody({ model: 42 });
    expect(() => parseMessagesBody(bytes)).toThrow(InvalidMessagesBodyError);
  });

  it('throws InvalidMessagesBodyError when model is null', () => {
    const bytes = encodeBody({ model: null });
    expect(() => parseMessagesBody(bytes)).toThrow(InvalidMessagesBodyError);
  });

  it('preserves the full parsed object including all extra fields', () => {
    const body = {
      model: 'claude-3-5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      stream: false,
    };
    const { parsed } = parseMessagesBody(encodeBody(body));
    expect(parsed).toEqual(body);
  });
});

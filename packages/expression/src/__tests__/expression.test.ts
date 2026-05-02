import { describe, it, expect } from 'vitest';
import { evaluateSync, evaluate, compile, resolveTemplate } from '../index.js';
import type { ExpressionContext } from '../index.js';

/**
 * Build a standard test context, optionally overriding any fields.
 * @param overrides - partial context to merge in
 * @returns fully populated ExpressionContext
 */
function createTestContext(overrides?: Partial<ExpressionContext>): ExpressionContext {
  return {
    trigger: { branch: 'main', count: 10, name: 'test' },
    steps: {
      validate: { result: 'ok', status: 'completed' },
      build: { status: 'running' },
    },
    inputs: { env: 'production' },
    ...overrides,
  };
}

describe('evaluateSync', () => {
  it('accesses a nested value via dot-path', () => {
    expect(evaluateSync('trigger.branch', createTestContext())).toBe('main');
  });

  it('evaluates a comparison operator and returns a boolean', () => {
    expect(evaluateSync('trigger.count > 5', createTestContext())).toBe(true);
  });

  it('evaluates a pipe transform (upper)', () => {
    expect(evaluateSync('"hello"|upper', createTestContext())).toBe('HELLO');
  });

  it('returns undefined for an unknown path', () => {
    expect(evaluateSync('trigger.nonexistent', createTestContext())).toBeUndefined();
  });

  it('accesses steps status', () => {
    expect(evaluateSync('steps.validate.status', createTestContext())).toBe('completed');
  });

  it('accesses inputs value', () => {
    expect(evaluateSync('inputs.env', createTestContext())).toBe('production');
  });
});

describe('evaluate (async)', () => {
  it('accesses a nested value via dot-path', async () => {
    await expect(evaluate('trigger.branch', createTestContext())).resolves.toBe('main');
  });

  it('evaluates a comparison operator and returns a boolean', async () => {
    await expect(evaluate('trigger.count > 5', createTestContext())).resolves.toBe(true);
  });

  it('evaluates a pipe transform (upper)', async () => {
    await expect(evaluate('"hello"|upper', createTestContext())).resolves.toBe('HELLO');
  });

  it('returns undefined for an unknown path', async () => {
    await expect(evaluate('trigger.nonexistent', createTestContext())).resolves.toBeUndefined();
  });

  it('accesses steps status', async () => {
    await expect(evaluate('steps.validate.status', createTestContext())).resolves.toBe('completed');
  });
});

describe('compile', () => {
  it('evalSync produces correct result for a given context', () => {
    const compiled = compile('trigger.branch');
    expect(compiled.evalSync(createTestContext())).toBe('main');
  });

  it('reused compiled expression evaluates correctly with different contexts', () => {
    const compiled = compile('trigger.branch');
    const ctx1 = createTestContext({ trigger: { branch: 'main', count: 10, name: 'test' } });
    const ctx2 = createTestContext({ trigger: { branch: 'develop', count: 10, name: 'test' } });
    expect(compiled.evalSync(ctx1)).toBe('main');
    expect(compiled.evalSync(ctx2)).toBe('develop');
  });

  it('eval (async) produces correct result for a given context', async () => {
    const compiled = compile('trigger.count > 5');
    await expect(compiled.eval(createTestContext())).resolves.toBe(true);
  });

  it('reused compiled expression works across multiple async evaluations', async () => {
    const compiled = compile('inputs.env');
    const ctx1 = createTestContext({ inputs: { env: 'production' } });
    const ctx2 = createTestContext({ inputs: { env: 'staging' } });
    await expect(compiled.eval(ctx1)).resolves.toBe('production');
    await expect(compiled.eval(ctx2)).resolves.toBe('staging');
  });
});

describe('resolveTemplate', () => {
  it('resolves a single placeholder', () => {
    expect(resolveTemplate('Hello {{ trigger.name }}', createTestContext())).toBe('Hello test');
  });

  it('resolves multiple placeholders', () => {
    const ctx = createTestContext({
      trigger: { branch: 'main', count: 10, name: 'test', a: 'foo', b: 'bar' },
    });
    expect(resolveTemplate('{{ trigger.a }} and {{ trigger.b }}', ctx)).toBe('foo and bar');
  });

  it('returns plain text unchanged when there are no placeholders', () => {
    expect(resolveTemplate('plain text', createTestContext())).toBe('plain text');
  });

  it('resolves an unknown path to an empty string', () => {
    expect(resolveTemplate('{{ trigger.missing }}', createTestContext())).toBe('');
  });

  it('evaluates a jexl expression inside a placeholder', () => {
    const ctx = createTestContext();
    expect(resolveTemplate('Result: {{ steps.validate.status == "completed" }}', ctx)).toBe('Result: true');
  });

  it('is tolerant of extra whitespace around the expression', () => {
    expect(resolveTemplate('{{  trigger.name  }}', createTestContext())).toBe('test');
  });

  it('resolves {{ constructor }} to empty string (prototype pollution guard)', () => {
    // jexl-extended rejects identifiers like `constructor` at parse time;
    // template.ts catches the error and returns '' for safety.
    expect(resolveTemplate('{{ constructor }}', createTestContext())).toBe('');
  });

  it('resolves {{ __proto__ }} to empty string (prototype pollution guard)', () => {
    expect(resolveTemplate('{{ __proto__ }}', createTestContext())).toBe('');
  });

  it('resolves step result placeholder', () => {
    expect(resolveTemplate('Output: {{ steps.validate.result }}', createTestContext())).toBe('Output: ok');
  });
});

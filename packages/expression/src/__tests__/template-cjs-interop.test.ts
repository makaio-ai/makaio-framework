import { describe, it, expect, vi } from 'vitest';
import { resolveTemplate, resolveTemplatesInObject } from '../index.js';

/**
 * Regression tests for the silent-empty-string template bug.
 *
 * `jexl-extended` ships CommonJS with `exports.default = new JexlExtended()`.
 * Under native Node ESM, `import jexl from 'jexl-extended'` binds the WHOLE
 * `module.exports` namespace (`{ JexlExtended, GrammarType, Monaco, default }`)
 * as the default import — NOT the instance stored at `.default`. Calling
 * `jexl.evalSync(...)` on that namespace throws a `TypeError`
 * (`jexl.evalSync is not a function`), which the template resolver's catch
 * turned into `''` — silently blanking every `{{ }}` placeholder in workflow
 * prompts at runtime.
 *
 * Vitest normally masks this: vite-node's `interopDefault` flattens `.default`
 * for externalized CJS dependencies, so the default import resolves to the
 * instance under the test runner even though it does not under Node. This mock
 * restores Node's real module shape inside vitest so template resolution is
 * exercised against the production interop semantics.
 */
vi.mock('jexl-extended', async () => {
  const { createRequire } = await import('node:module');
  const cjsExports = createRequire(import.meta.url)('jexl-extended') as Record<string, unknown>;
  // Node's ESM view of a CJS module: named exports plus `default: module.exports`.
  return { ...cjsExports, default: cjsExports };
});

describe('resolveTemplate under native Node CJS interop', () => {
  it('interpolates a simple placeholder instead of silently returning an empty string', () => {
    expect(resolveTemplate('Hello {{ name }}', { name: 'world' })).toBe('Hello world');
  });

  it('evaluates a jexl expression placeholder', () => {
    const context = { steps: { validate: { status: 'completed' } } };
    expect(resolveTemplate('done: {{ steps.validate.status == "completed" }}', context)).toBe('done: true');
  });

  it('supports engine transforms (shared instance, not a bare default import)', () => {
    expect(resolveTemplate('{{ name|upper }}', { name: 'world' })).toBe('WORLD');
  });

  it('still degrades an unknown path to an empty string without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveTemplate('{{ missing.path }}', { name: 'world' })).toBe('');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns instead of silently swallowing an evaluation error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // `constructor` is rejected by jexl-extended at parse time (prototype
      // pollution guard) — the resolver must degrade to '' but surface the failure.
      expect(resolveTemplate('{{ constructor }}', { name: 'world' })).toBe('');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('constructor');
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves mixed-content strings in object payloads', () => {
    const result = resolveTemplatesInObject(
      { title: 'Plan: {{ trigger.name }}', slug: '{{ inputs.owner }}/{{ inputs.repo }}' },
      { trigger: { name: 'test' }, inputs: { owner: 'makaio-ai', repo: 'makaio' } },
    );
    expect(result).toEqual({ title: 'Plan: test', slug: 'makaio-ai/makaio' });
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeOptions } from '../../src/shared/options.js';
import { MakaioModelError, MakaioUnsupportedFeatureError } from '../../src/shared/errors.js';

describe('normalizeOptions', () => {
  it('parses bare model name', () => {
    const result = normalizeOptions({ model: 'sonnet' });
    expect(result.parsedModel.kind).toBe('bare');
  });

  it('parses qualified model name', () => {
    const result = normalizeOptions({ model: 'anthropic-sdk::sonnet' });
    expect(result.parsedModel.kind).toBe('qualified');
  });

  it('throws MakaioModelError for empty model name', () => {
    expect(() => normalizeOptions({ model: '' })).toThrow(MakaioModelError);
  });

  it('preserves cwd, env, systemPrompt', () => {
    const result = normalizeOptions({
      model: 'sonnet',
      cwd: '/tmp',
      env: { FOO: 'bar' },
      systemPrompt: 'You are helpful',
    });
    expect(result.cwd).toBe('/tmp');
    expect(result.env).toEqual({ FOO: 'bar' });
    expect(result.systemPrompt).toBe('You are helpful');
  });

  it('defaults cwd to process.cwd()', () => {
    const result = normalizeOptions({ model: 'sonnet' });
    expect(result.cwd).toBe(process.cwd());
  });

  it('defaults to persistent Makaio session orchestration', () => {
    const result = normalizeOptions({ model: 'sonnet' });
    expect(result.persistSession).toBe(true);
    expect(result.ephemeral).toBe(false);
  });

  it('keeps ephemeral false when persistSession is true', () => {
    const result = normalizeOptions({ model: 'sonnet', persistSession: true });
    expect(result.persistSession).toBe(true);
    expect(result.ephemeral).toBe(false);
  });

  it('rejects explicit persistSession false until ephemeral query startup exists', () => {
    expect(() => normalizeOptions({ model: 'sonnet', persistSession: false })).toThrow(MakaioUnsupportedFeatureError);
  });

  it('passes through maxTurns, effort, and outputFormat', () => {
    const schema = { type: 'object' as const, properties: {} };
    const result = normalizeOptions({
      model: 'sonnet',
      maxTurns: 5,
      effort: 'high',
      outputFormat: { type: 'json_schema', schema },
    });
    expect(result.maxTurns).toBe(5);
    expect(result.effort).toBe('high');
    expect(result.outputFormat).toEqual({ type: 'json_schema', schema });
  });

  it('passes through websocketUrl', () => {
    const result = normalizeOptions({
      model: 'sonnet',
      websocketUrl: 'ws://localhost:1234/bus',
    });
    expect(result.websocketUrl).toBe('ws://localhost:1234/bus');
  });

  it('rejects unsupported credential overrides honestly', () => {
    expect(() =>
      normalizeOptions({
        model: 'sonnet',
        credentials: { openai: { apiKey: 'sk-test' } },
      }),
    ).toThrow(MakaioUnsupportedFeatureError);
  });

  it('rejects unsupported adapter-session resume honestly', () => {
    expect(() => normalizeOptions({ model: 'sonnet', resume: 'adapter-session-id' })).toThrow(
      MakaioUnsupportedFeatureError,
    );
  });
});

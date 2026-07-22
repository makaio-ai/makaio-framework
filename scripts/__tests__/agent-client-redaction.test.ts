import { describe, expect, it } from 'vitest';
import { isRedactableKey, redactDeep, redactStringValue } from '../lib/agent-clients/redaction.js';
import { REDACTED_PLACEHOLDER } from '../lib/agent-clients/types.js';

describe('isRedactableKey', () => {
  it('matches credential-like key names (case-insensitive)', () => {
    expect(isRedactableKey('apiKey')).toBe(true);
    expect(isRedactableKey('API_KEY')).toBe(true);
    expect(isRedactableKey('access_token')).toBe(true);
    expect(isRedactableKey('Authorization')).toBe(true);
    expect(isRedactableKey('password')).toBe(true);
    expect(isRedactableKey('clientSecret')).toBe(true);
    expect(isRedactableKey('session_id')).toBe(true);
    expect(isRedactableKey('cookie_value')).toBe(true);
  });

  it('does not match non-credential keys', () => {
    expect(isRedactableKey('name')).toBe(false);
    expect(isRedactableKey('type')).toBe(false);
    expect(isRedactableKey('tool')).toBe(false);
    expect(isRedactableKey('eventName')).toBe(false);
    expect(isRedactableKey('description')).toBe(false);
  });
});

describe('redactStringValue', () => {
  it('redacts absolute Unix paths', () => {
    const result = redactStringValue('Working in /home/testuser/projects/myapp');
    expect(result).toContain(REDACTED_PLACEHOLDER);
    expect(result).not.toContain('/home/testuser');
  });

  it('redacts absolute Windows paths', () => {
    const result = redactStringValue('Working in C:\\Users\\testuser\\projects');
    expect(result).toContain(REDACTED_PLACEHOLDER);
    expect(result).not.toContain('C:\\Users\\testuser');
  });

  it('redacts ISO timestamps', () => {
    const result = redactStringValue('Started at 2024-01-15T14:30:00.000Z');
    expect(result).toContain(REDACTED_PLACEHOLDER);
    expect(result).not.toContain('2024-01-15');
  });

  it('redacts UUIDs', () => {
    const result = redactStringValue('Session a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(result).toContain(REDACTED_PLACEHOLDER);
    expect(result).not.toContain('a1b2c3d4');
  });

  it('leaves non-sensitive strings unchanged', () => {
    const input = 'SessionStart event received';
    expect(redactStringValue(input)).toBe(input);
  });
});

describe('redactDeep', () => {
  it('redacts credential keys in nested objects', () => {
    const input = {
      type: 'tool',
      apiKey: 'secret-api-key',
      nested: {
        authorization: 'Bearer secret-token',
        name: 'test',
      },
    };

    const result = redactDeep(input) as Record<string, unknown>;
    expect(result.type).toBe('tool');
    expect(result.apiKey).toBe(REDACTED_PLACEHOLDER);
    const nested = result.nested as Record<string, unknown>;
    expect(nested.authorization).toBe(REDACTED_PLACEHOLDER);
    expect(nested.name).toBe('test');
  });

  it('redacts sensitive patterns in string values', () => {
    const input = {
      message: 'Working in /home/testuser/project',
      count: 42,
    };

    const result = redactDeep(input) as Record<string, unknown>;
    expect(result.message).toContain(REDACTED_PLACEHOLDER);
    expect(result.count).toBe(42);
  });

  it('processes arrays recursively', () => {
    const input = [{ token: 'secret' }, { name: 'safe' }];

    const result = redactDeep(input) as Array<Record<string, unknown>>;
    expect(result[0]!.token).toBe(REDACTED_PLACEHOLDER);
    expect(result[1]!.name).toBe('safe');
  });

  it('passes through null and undefined', () => {
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(undefined)).toBeUndefined();
  });

  it('passes through booleans and numbers', () => {
    expect(redactDeep(true)).toBe(true);
    expect(redactDeep(42)).toBe(42);
  });
});

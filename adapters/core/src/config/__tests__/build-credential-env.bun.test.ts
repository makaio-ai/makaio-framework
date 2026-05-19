import { describe, it, expect } from 'bun:test';
import { buildCredentialEnv } from '../build-credential-env.js';

describe('buildCredentialEnv', () => {
  it('maps a single credential field to its env var name', () => {
    const result = buildCredentialEnv({ apiKey: 'sk-123' }, { apiKey: 'ANTHROPIC_API_KEY' });
    expect(result).toEqual({ ANTHROPIC_API_KEY: 'sk-123' });
  });

  it('maps multiple credential fields to their env var names', () => {
    const result = buildCredentialEnv(
      { apiKey: 'sk-abc', baseUrl: 'https://api.example.com' },
      { apiKey: 'MY_API_KEY', baseUrl: 'MY_BASE_URL' },
    );
    expect(result).toEqual({ MY_API_KEY: 'sk-abc', MY_BASE_URL: 'https://api.example.com' });
  });

  it('omits env vars whose credential field is absent from credentials', () => {
    const result = buildCredentialEnv({ apiKey: 'sk-123' }, { apiKey: 'MY_API_KEY', missingField: 'MISSING_ENV_VAR' });
    expect(result).toEqual({ MY_API_KEY: 'sk-123' });
    expect('MISSING_ENV_VAR' in result).toBe(false);
  });

  it('ignores credential fields not referenced in credentialEnvVars', () => {
    const result = buildCredentialEnv({ apiKey: 'sk-123', extraField: 'extra-value' }, { apiKey: 'MY_API_KEY' });
    expect(result).toEqual({ MY_API_KEY: 'sk-123' });
  });

  it('returns an empty object when credentialEnvVars is undefined', () => {
    const result = buildCredentialEnv({ apiKey: 'sk-123' }, undefined);
    expect(result).toEqual({});
  });

  it('returns an empty object when credentialEnvVars is empty', () => {
    const result = buildCredentialEnv({ apiKey: 'sk-123' }, {});
    expect(result).toEqual({});
  });

  it('returns an empty object when credentials is empty and credentialEnvVars is non-empty', () => {
    const result = buildCredentialEnv({}, { apiKey: 'MY_API_KEY' });
    expect(result).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';
import { resolveProviderEndpoint } from '../provider-registry.js';

const BOTH_ENDPOINTS = {
  anthropic: 'https://anthropic.example/v1',
  openai: 'https://openai.example/v1',
} as const;

describe('Pi provider endpoint selection', () => {
  it.each([
    ['anthropic', { piApi: 'anthropic-messages', baseUrl: BOTH_ENDPOINTS.anthropic }],
    ['openai', { piApi: 'openai-completions', baseUrl: BOTH_ENDPOINTS.openai }],
  ] as const)('selects only the declared %s protocol regardless of endpoint order', (protocol, expected) => {
    expect(resolveProviderEndpoint(protocol, BOTH_ENDPOINTS)).toEqual(expected);
  });

  it('does not substitute another available endpoint when the selected protocol is absent', () => {
    expect(resolveProviderEndpoint('anthropic', { openai: BOTH_ENDPOINTS.openai })).toBeUndefined();
  });
});

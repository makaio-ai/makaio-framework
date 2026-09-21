import { describe, expect, it } from 'vitest';
import { parseGatewayConfig, GatewayConfigSchema } from '../config.js';

// ---------------------------------------------------------------------------
// Minimal valid configs used across multiple tests
// ---------------------------------------------------------------------------

const ANTHROPIC_ONLY = {
  upstreams: { anthropic: { kind: 'anthropic' as const } },
};

const LITELLM_ONLY = {
  upstreams: {
    litellm: { kind: 'litellm' as const, url: 'http://127.0.0.1:4000', masterKey: 'env:LITELLM_MASTER_KEY' },
  },
  default: 'litellm',
};

describe('parseGatewayConfig', () => {
  // ---------------------------------------------------------------------------
  // Full parse
  // ---------------------------------------------------------------------------

  it('parses a full valid config with multiple upstreams and rules', () => {
    const raw = {
      upstreams: {
        anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com' },
        'anthropic-work': {
          kind: 'anthropic',
          url: 'https://api.anthropic.com',
          auth: { apiKey: 'env:ANTHROPIC_KEY_WORK' },
        },
        litellm: { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'env:LITELLM_MASTER_KEY' },
      },
      default: 'anthropic',
      rules: [
        { match: 'DeepSeek-*', to: 'litellm', reasoning: { mode: 'passthrough' } },
        {
          match: 'deepseek',
          to: 'litellm',
          model: 'DeepSeek-V4-Flash-0731',
          reasoning: { mode: 'fixed', effort: 'low' },
        },
        { match: 'claude-*', to: ['anthropic', 'anthropic-work'], strategy: { kind: 'static' } },
      ],
    };

    const config = parseGatewayConfig(raw);
    expect(config.upstreams['anthropic']?.kind).toBe('anthropic');
    expect(config.upstreams['anthropic-work']?.kind).toBe('anthropic');
    expect(config.upstreams['litellm']?.kind).toBe('litellm');
    expect(config.default).toBe('anthropic');
    expect(config.rules).toHaveLength(3);
    expect(config.rules[0]).toMatchObject({ match: 'DeepSeek-*', to: ['litellm'] });
    expect(config.rules[1]).toMatchObject({ match: 'deepseek', to: ['litellm'], model: 'DeepSeek-V4-Flash-0731' });
    expect(config.rules[2]).toMatchObject({ match: 'claude-*', to: ['anthropic', 'anthropic-work'] });
  });

  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------

  it('defaults anthropic url to https://api.anthropic.com when url is omitted', () => {
    const config = parseGatewayConfig(ANTHROPIC_ONLY);
    const upstream = config.upstreams['anthropic'];
    expect(upstream?.kind).toBe('anthropic');
    if (upstream?.kind === 'anthropic') {
      expect(upstream.url).toBe('https://api.anthropic.com');
    }
  });

  it('defaults default field to "anthropic"', () => {
    const config = parseGatewayConfig(ANTHROPIC_ONLY);
    expect(config.default).toBe('anthropic');
  });

  it('defaults rules to empty array when omitted', () => {
    const config = parseGatewayConfig(ANTHROPIC_ONLY);
    expect(config.rules).toEqual([]);
  });

  it('defaults strategy to { kind: "static" } when omitted from a rule', () => {
    const config = parseGatewayConfig({
      ...ANTHROPIC_ONLY,
      rules: [{ match: 'claude-*', to: 'anthropic' }],
    });
    expect(config.rules[0]?.strategy).toEqual({ kind: 'static' });
  });

  it('normalises a string to field to a singleton array', () => {
    const config = parseGatewayConfig({
      ...ANTHROPIC_ONLY,
      rules: [{ match: 'claude-*', to: 'anthropic' }],
    });
    expect(config.rules[0]?.to).toEqual(['anthropic']);
  });

  it('preserves an array to field unchanged', () => {
    const raw = {
      upstreams: {
        a: { kind: 'anthropic' as const },
        b: { kind: 'anthropic' as const },
      },
      default: 'a',
      rules: [{ match: 'claude-*', to: ['a', 'b'] }],
    };
    const config = parseGatewayConfig(raw);
    expect(config.rules[0]?.to).toEqual(['a', 'b']);
  });

  it('allows a litellm upstream as the default', () => {
    const config = parseGatewayConfig(LITELLM_ONLY);
    expect(config.default).toBe('litellm');
    expect(config.upstreams['litellm']?.kind).toBe('litellm');
  });

  // ---------------------------------------------------------------------------
  // Anthropic upstream: auth vs pass-through
  // ---------------------------------------------------------------------------

  it('accepts an anthropic upstream without auth (pass-through mode)', () => {
    const config = parseGatewayConfig(ANTHROPIC_ONLY);
    const upstream = config.upstreams['anthropic'];
    expect(upstream?.kind).toBe('anthropic');
    if (upstream?.kind === 'anthropic') {
      expect(upstream.auth).toBeUndefined();
    }
  });

  it('accepts an anthropic upstream with auth.apiKey credential ref', () => {
    const config = parseGatewayConfig({
      upstreams: {
        'my-anthropic': {
          kind: 'anthropic',
          auth: { apiKey: 'env:ANTHROPIC_API_KEY' },
        },
      },
      default: 'my-anthropic',
    });
    const upstream = config.upstreams['my-anthropic'];
    expect(upstream?.kind).toBe('anthropic');
    if (upstream?.kind === 'anthropic') {
      expect(upstream.auth?.apiKey).toBe('env:ANTHROPIC_API_KEY');
    }
  });

  // ---------------------------------------------------------------------------
  // Credential ref formats
  // ---------------------------------------------------------------------------

  it('accepts env: credential ref as litellm masterKey', () => {
    const config = parseGatewayConfig(LITELLM_ONLY);
    const upstream = config.upstreams['litellm'];
    if (upstream?.kind === 'litellm') {
      expect(upstream.masterKey).toBe('env:LITELLM_MASTER_KEY');
    }
  });

  it('rejects an invalid credential ref shape', () => {
    const raw = {
      upstreams: {
        litellm: { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'plaintext-secret' },
      },
      default: 'litellm',
    };
    expect(() => parseGatewayConfig(raw)).toThrow(/credential/i);
  });

  // ---------------------------------------------------------------------------
  // Strict: unknown keys rejected
  // ---------------------------------------------------------------------------

  it('rejects unknown keys at the top level', () => {
    expect(() => parseGatewayConfig({ ...ANTHROPIC_ONLY, unknownTopLevel: true })).toThrow();
  });

  it('rejects unknown keys in an anthropic upstream block', () => {
    expect(() =>
      parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic', unknownKey: true } },
      }),
    ).toThrow();
  });

  it('rejects unknown keys in a litellm upstream block', () => {
    expect(() =>
      parseGatewayConfig({
        upstreams: {
          litellm: { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'env:KEY', extra: true },
        },
        default: 'litellm',
      }),
    ).toThrow();
  });

  it('rejects unknown keys in a rule', () => {
    expect(() =>
      parseGatewayConfig({
        ...ANTHROPIC_ONLY,
        rules: [{ match: 'claude-*', to: 'anthropic', unknownKey: true }],
      }),
    ).toThrow();
  });

  it('rejects unknown keys inside a ReasoningMode variant', () => {
    expect(() =>
      parseGatewayConfig({
        upstreams: {
          litellm: { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'env:KEY' },
        },
        default: 'litellm',
        rules: [{ match: 'deepseek-*', to: 'litellm', reasoning: { mode: 'fixed', effort: 'high', extra: true } }],
      }),
    ).toThrow();
  });

  // ---------------------------------------------------------------------------
  // Refinement: default must exist in upstreams
  // ---------------------------------------------------------------------------

  it('rejects when default is "anthropic" but upstreams is empty', () => {
    expect(() => parseGatewayConfig({})).toThrow(/Default upstream.*anthropic.*is not defined/i);
  });

  it('rejects when default names an upstream not in upstreams', () => {
    expect(() =>
      parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic' } },
        default: 'missing',
      }),
    ).toThrow(/Default upstream.*missing.*is not defined/i);
  });

  // ---------------------------------------------------------------------------
  // Refinement: to names must exist in upstreams
  // ---------------------------------------------------------------------------

  it('rejects when a rule to references a non-existent upstream', () => {
    expect(() =>
      parseGatewayConfig({
        ...ANTHROPIC_ONLY,
        rules: [{ match: 'claude-*', to: 'nonexistent' }],
      }),
    ).toThrow(/nonexistent/);
  });

  it('rejects when one of several to names is not in upstreams', () => {
    expect(() =>
      parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic' } },
        rules: [{ match: 'claude-*', to: ['anthropic', 'ghost'] }],
      }),
    ).toThrow(/ghost/);
  });

  // ---------------------------------------------------------------------------
  // Refinement: model/reasoning only allowed when all to are litellm
  // ---------------------------------------------------------------------------

  it('rejects model on a rule that references an anthropic upstream', () => {
    expect(() =>
      parseGatewayConfig({
        ...ANTHROPIC_ONLY,
        rules: [{ match: 'claude-*', to: 'anthropic', model: 'something-else' }],
      }),
    ).toThrow(/model.*reasoning.*litellm|only valid when every upstream/i);
  });

  it('rejects reasoning on a rule that references an anthropic upstream', () => {
    expect(() =>
      parseGatewayConfig({
        ...ANTHROPIC_ONLY,
        rules: [{ match: 'claude-*', to: 'anthropic', reasoning: { mode: 'drop' } }],
      }),
    ).toThrow(/model.*reasoning.*litellm|only valid when every upstream/i);
  });

  it('rejects model/reasoning on a rule with mixed anthropic + litellm upstreams', () => {
    expect(() =>
      parseGatewayConfig({
        upstreams: {
          anthropic: { kind: 'anthropic' },
          litellm: { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'env:KEY' },
        },
        rules: [{ match: 'claude-*', to: ['anthropic', 'litellm'], model: 'x' }],
      }),
    ).toThrow(/only valid when every upstream/i);
  });

  it('accepts model/reasoning when all to upstreams are litellm', () => {
    const config = parseGatewayConfig({
      upstreams: {
        litellm: { kind: 'litellm', url: 'http://127.0.0.1:4000', masterKey: 'env:KEY' },
        litellm2: { kind: 'litellm', url: 'http://127.0.0.1:4001', masterKey: 'env:KEY2' },
      },
      default: 'litellm',
      rules: [{ match: 'deepseek-*', to: ['litellm', 'litellm2'], model: 'model-x', reasoning: { mode: 'drop' } }],
    });
    expect(config.rules[0]?.model).toBe('model-x');
  });

  // ---------------------------------------------------------------------------
  // Match field validation
  // ---------------------------------------------------------------------------

  it('rejects empty match string', () => {
    expect(() =>
      parseGatewayConfig({
        ...ANTHROPIC_ONLY,
        rules: [{ match: '', to: 'anthropic' }],
      }),
    ).toThrow();
  });

  // ---------------------------------------------------------------------------
  // URL validation
  // ---------------------------------------------------------------------------

  it('rejects a non-URL anthropic upstream url', () => {
    expect(() =>
      parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic', url: 'not-a-url' } },
      }),
    ).toThrow();
  });

  it('rejects a non-URL litellm upstream url', () => {
    expect(() =>
      parseGatewayConfig({
        upstreams: {
          litellm: { kind: 'litellm', url: 'not-a-url', masterKey: 'env:KEY' },
        },
        default: 'litellm',
      }),
    ).toThrow();
  });

  /**
   * Parse a config whose single LiteLLM upstream carries the given URL.
   * @param url - Candidate upstream base URL.
   * @returns The parse result, so the caller can assert accept or reject.
   */
  function parseWithLitellmUrl(url: string) {
    return parseGatewayConfig({
      upstreams: { litellm: { kind: 'litellm', url, masterKey: 'env:KEY' } },
      default: 'litellm',
    });
  }

  it('rejects a non-http protocol', () => {
    expect(() => parseWithLitellmUrl('ftp://example.com')).toThrow(/http or https protocol/i);
    expect(() => parseWithLitellmUrl('ws://127.0.0.1:4000')).toThrow(/http or https protocol/i);
  });

  it('rejects an upstream url carrying a username or password', () => {
    expect(() => parseWithLitellmUrl('http://user@127.0.0.1:4000')).toThrow(/username or password/i);
    expect(() => parseWithLitellmUrl('http://user:pass@127.0.0.1:4000')).toThrow(/username or password/i);
  });

  it('rejects an upstream url carrying a query string', () => {
    expect(() => parseWithLitellmUrl('http://127.0.0.1:4000?beta=true')).toThrow(/query string/i);
  });

  it('rejects an upstream url with a trailing ? (empty query string)', () => {
    // new URL('http://host?').search === '' — the parsed value is empty, but
    // the raw marker is present and would be appended to forwarded URLs.
    expect(() => parseWithLitellmUrl('http://127.0.0.1:4000?')).toThrow(/query string/i);
  });

  it('rejects an upstream url carrying a fragment', () => {
    expect(() => parseWithLitellmUrl('http://127.0.0.1:4000#frag')).toThrow(/fragment/i);
  });

  it('rejects an upstream url with a trailing # (empty fragment)', () => {
    // new URL('http://host#').hash === '' — same as above: empty parsed value
    // but the raw marker is still present.
    expect(() => parseWithLitellmUrl('http://127.0.0.1:4000#')).toThrow(/fragment/i);
  });

  it('accepts a plain loopback http url', () => {
    expect(parseWithLitellmUrl('http://127.0.0.1:4000').upstreams['litellm']?.url).toBe('http://127.0.0.1:4000');
  });

  it('accepts a path-prefixed base url', () => {
    expect(parseWithLitellmUrl('https://proxy.example.com/llm/v1').upstreams['litellm']?.url).toBe(
      'https://proxy.example.com/llm/v1',
    );
  });

  // How a validated base URL is joined with the routed path — trailing slash
  // included — is asserted end-to-end in `routes.integration.test.ts`
  // ("Upstream trailing-slash normalisation"), against the real forwarded
  // request rather than a restatement of the join here.
  it('trims leading and trailing whitespace from an upstream url', () => {
    // Whitespace is stripped before URL validation so that values from
    // environment-sourced config files with accidental surrounding spaces are
    // accepted rather than silently broken at forward time.
    expect(parseWithLitellmUrl('http://127.0.0.1:4000  ').upstreams['litellm']?.url).toBe('http://127.0.0.1:4000');
    expect(parseWithLitellmUrl('  http://127.0.0.1:4000').upstreams['litellm']?.url).toBe('http://127.0.0.1:4000');
    expect(parseWithLitellmUrl('  http://127.0.0.1:4000  ').upstreams['litellm']?.url).toBe('http://127.0.0.1:4000');
  });

  it('applies the same rules to the anthropic upstream url', () => {
    expect(() =>
      parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic', url: 'http://key@api.anthropic.com' } },
      }),
    ).toThrow(/username or password/i);
  });

  // ---------------------------------------------------------------------------
  // Upstream name pattern
  // ---------------------------------------------------------------------------

  it('rejects an upstream map key that does not match [A-Za-z0-9_-]+', () => {
    // default is a valid key that exists; the failure must come from the record
    // key schema, not the default-exists refinement.
    expect(() =>
      parseGatewayConfig({
        upstreams: {
          valid: { kind: 'anthropic' },
          'bad name!': { kind: 'anthropic' },
        },
        default: 'valid',
      }),
    ).toThrow();
  });

  it('accepts upstream names with hyphens and underscores', () => {
    const config = parseGatewayConfig({
      upstreams: { 'my-upstream_2': { kind: 'anthropic' } },
      default: 'my-upstream_2',
    });
    expect(config.upstreams['my-upstream_2']?.kind).toBe('anthropic');
  });

  // ---------------------------------------------------------------------------
  // Reasoning modes
  // ---------------------------------------------------------------------------

  it('accepts all three reasoning modes on a litellm rule', () => {
    const litellmBlock = { kind: 'litellm' as const, url: 'http://127.0.0.1:4000', masterKey: 'env:KEY' };
    for (const mode of [{ mode: 'passthrough' }, { mode: 'drop' }, { mode: 'fixed', effort: 'high' }] as const) {
      const config = parseGatewayConfig({
        upstreams: { litellm: litellmBlock },
        default: 'litellm',
        rules: [{ match: 'deepseek-*', to: 'litellm', reasoning: mode }],
      });
      expect(config.rules[0]?.reasoning?.mode).toBe(mode.mode);
    }
  });

  // ---------------------------------------------------------------------------
  // Own-key semantics: reserved JS names rejected as upstream names (Fix 1)
  // ---------------------------------------------------------------------------

  it('rejects "constructor" as the default upstream name', () => {
    // "constructor" must be rejected with the plain "not defined" message, not
    // matched against an inherited prototype property.
    expect(() =>
      parseGatewayConfig({
        upstreams: {},
        default: 'constructor',
      }),
    ).toThrow(/Default upstream.*constructor.*is not defined/i);
  });

  it('rejects "toString" as a rule to entry', () => {
    // Prototype names in `to` must not satisfy the exists-in-upstreams check.
    expect(() =>
      parseGatewayConfig({
        ...ANTHROPIC_ONLY,
        rules: [{ match: 'any-model', to: 'toString' }],
      }),
    ).toThrow();
  });

  // ---------------------------------------------------------------------------
  // Guard on partially-parsed to field: safeParse must not throw (Fix 2)
  // ---------------------------------------------------------------------------

  it('safeParse returns success: false (no TypeError) when to is an invalid name', () => {
    // "bad name" fails UpstreamNameSchema (contains a space). The to transform
    // does not run, so rule.to is not an array in the superRefine phase.
    // The refinement must guard against this and not throw a TypeError.
    const result = GatewayConfigSchema.safeParse({
      upstreams: { anthropic: { kind: 'anthropic' } },
      rules: [{ match: 'claude-*', to: 'bad name', model: 'x' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Uniqueness: duplicate to entries rejected (Fix 3)
  // ---------------------------------------------------------------------------

  it('rejects a rule with duplicate upstream names in the to array', () => {
    // ZodError serialises issue messages as JSON, so literal quotes are escaped.
    // Match without quotes to avoid the `"` → `\"` mismatch.
    expect(() =>
      parseGatewayConfig({
        upstreams: { anthropic: { kind: 'anthropic' } },
        rules: [{ match: 'claude-*', to: ['anthropic', 'anthropic'] }],
      }),
    ).toThrow(/duplicate upstream.*anthropic/i);
  });

  it('accepts a rule with unique upstream names in the to array', () => {
    const config = parseGatewayConfig({
      upstreams: {
        a: { kind: 'anthropic' },
        b: { kind: 'anthropic' },
      },
      default: 'a',
      rules: [{ match: 'claude-*', to: ['a', 'b'] }],
    });
    expect(config.rules[0]?.to).toEqual(['a', 'b']);
  });
});

describe('GatewayConfigSchema defaults', () => {
  it('parsing an empty object yields defaults but fails default-upstream refinement', () => {
    // An empty upstreams map means the default upstream "anthropic" is missing.
    expect(() => GatewayConfigSchema.parse({})).toThrow(/Default upstream.*anthropic.*is not defined/i);
  });

  it('parsing with only the required anthropic upstream yields correct defaults', () => {
    const config = GatewayConfigSchema.parse({ upstreams: { anthropic: { kind: 'anthropic' } } });
    expect(config.default).toBe('anthropic');
    expect(config.rules).toEqual([]);
    expect(config.upstreams['anthropic']?.url).toBe('https://api.anthropic.com');
  });
});

describe('GatewayConfigSchema access token and body cap', () => {
  /** Minimal upstream map reused by the cases below. */
  const UPSTREAMS = { anthropic: { kind: 'anthropic' as const } };

  it('defaults accessToken to undefined and maxBodyBytes to 64 MiB', () => {
    const config = parseGatewayConfig({ upstreams: UPSTREAMS });
    expect(config.accessToken).toBeUndefined();
    expect(config.maxBodyBytes).toBe(64 * 1024 * 1024);
  });

  it('accepts a credential reference for accessToken', () => {
    const config = parseGatewayConfig({ upstreams: UPSTREAMS, accessToken: 'env:GATEWAY_TOKEN' });
    expect(config.accessToken).toBe('env:GATEWAY_TOKEN');
  });

  it('rejects a plaintext accessToken that is not a credential reference', () => {
    expect(() => parseGatewayConfig({ upstreams: UPSTREAMS, accessToken: 'plaintext-token' })).toThrow();
  });

  it('accepts an explicit positive maxBodyBytes', () => {
    expect(parseGatewayConfig({ upstreams: UPSTREAMS, maxBodyBytes: 1024 }).maxBodyBytes).toBe(1024);
  });

  it('rejects a zero, negative, or fractional maxBodyBytes', () => {
    expect(() => parseGatewayConfig({ upstreams: UPSTREAMS, maxBodyBytes: 0 })).toThrow();
    expect(() => parseGatewayConfig({ upstreams: UPSTREAMS, maxBodyBytes: -1 })).toThrow();
    expect(() => parseGatewayConfig({ upstreams: UPSTREAMS, maxBodyBytes: 1.5 })).toThrow();
  });
});

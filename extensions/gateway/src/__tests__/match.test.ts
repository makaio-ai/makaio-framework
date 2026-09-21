import { describe, expect, it } from 'vitest';
import { parseGatewayConfig } from '../config.js';
import { compileRules, decideRoute } from '../routing/match.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = 'https://api.anthropic.com';
const LITELLM_URL = 'http://127.0.0.1:4000';
const LITELLM_KEY = 'sk-test-key';
const LITELLM_KEY_REF = 'env:LITELLM_MASTER_KEY';

/**
 * Build a minimal config with only an Anthropic upstream and a given set of
 * rules that each target it.
 * @param patterns - Match patterns for each rule (all route to the anthropic upstream).
 * @param upstreamUrl - Base URL for the Anthropic upstream.
 */
function anthropicOnlyConfig(patterns: ReadonlyArray<string> = [], upstreamUrl = ANTHROPIC_URL) {
  return parseGatewayConfig({
    upstreams: { anthropic: { kind: 'anthropic', url: upstreamUrl } },
    rules: patterns.map((match) => ({ match, to: 'anthropic' })),
  });
}

/**
 * Resolved secrets map for a config that contains only the litellm upstream.
 */
const LITELLM_SECRETS: ReadonlyMap<string, string> = new Map([['litellm', LITELLM_KEY]]);
const EMPTY_SECRETS: ReadonlyMap<string, string> = new Map();

/**
 * Build a config with one or more LiteLLM rules.
 * @param rules - Ordered list of rule descriptors.
 * @param litellmUrl - Base URL for the LiteLLM proxy.
 */
function litellmConfig(
  rules: ReadonlyArray<{
    match: string;
    model?: string;
    reasoning?: { mode: 'passthrough' } | { mode: 'drop' } | { mode: 'fixed'; effort: 'low' | 'medium' | 'high' };
  }>,
  litellmUrl = LITELLM_URL,
) {
  return parseGatewayConfig({
    upstreams: {
      litellm: { kind: 'litellm', url: litellmUrl, masterKey: LITELLM_KEY_REF },
    },
    default: 'litellm',
    rules: rules.map((r) => ({
      match: r.match,
      to: 'litellm',
      ...(r.model !== undefined ? { model: r.model } : {}),
      ...(r.reasoning !== undefined ? { reasoning: r.reasoning } : {}),
    })),
  });
}

// ---------------------------------------------------------------------------
// No rules — always default
// ---------------------------------------------------------------------------

describe('no rules', () => {
  it('returns the default Anthropic target with ruleIndex null', () => {
    const config = parseGatewayConfig({
      upstreams: { anthropic: { kind: 'anthropic' } },
    });
    const compiled = compileRules(config, EMPTY_SECRETS);
    const decision = decideRoute('claude-opus-4-5', compiled);

    expect(decision.target.kind).toBe('anthropic');
    expect(decision.ruleIndex).toBeNull();
    expect(decision.upstreamModel).toBe('claude-opus-4-5');
  });

  it('uses the configured url for the default target', () => {
    const config = anthropicOnlyConfig([], 'https://my-proxy.example.com');
    const compiled = compileRules(config, EMPTY_SECRETS);
    const decision = decideRoute('any-model', compiled);

    if (decision.target.kind === 'anthropic') {
      expect(decision.target.url).toBe('https://my-proxy.example.com');
    }
    expect(decision.ruleIndex).toBeNull();
  });

  it('uses the upstream name on the target', () => {
    const config = anthropicOnlyConfig();
    const compiled = compileRules(config, EMPTY_SECRETS);
    const decision = decideRoute('any-model', compiled);

    expect(decision.target.name).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Exact match
// ---------------------------------------------------------------------------

describe('exact match', () => {
  it('matches an exact anthropic rule and returns its rule index', () => {
    const config = anthropicOnlyConfig(['claude-opus-4-5']);
    const compiled = compileRules(config, EMPTY_SECRETS);
    const decision = decideRoute('claude-opus-4-5', compiled);

    expect(decision.target.kind).toBe('anthropic');
    expect(decision.ruleIndex).toBe(0);
    expect(decision.upstreamModel).toBe('claude-opus-4-5');
  });

  it('does not match a model that only partially overlaps the exact pattern', () => {
    const config = anthropicOnlyConfig(['claude-opus-4-5']);
    const compiled = compileRules(config, EMPTY_SECRETS);
    const decision = decideRoute('claude-opus-4-5-turbo', compiled);

    // No rule matched — default applies.
    expect(decision.ruleIndex).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Glob patterns
// ---------------------------------------------------------------------------

describe('glob: prefix pattern (deepseek-*)', () => {
  it('matches a model that starts with the prefix', () => {
    const config = litellmConfig([{ match: 'deepseek-*', model: 'DeepSeek-V4-Flash-0731' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);
    const decision = decideRoute('deepseek-v3', compiled);

    expect(decision.target.kind).toBe('litellm');
    expect(decision.ruleIndex).toBe(0);
    expect(decision.upstreamModel).toBe('DeepSeek-V4-Flash-0731');
  });

  it('matches when the suffix is empty (glob matches empty string)', () => {
    const config = litellmConfig([{ match: 'deepseek-*' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);
    // 'deepseek-' with nothing after the prefix — * matches empty string.
    const decision = decideRoute('deepseek-', compiled);

    expect(decision.ruleIndex).toBe(0);
  });

  it('does not match a model that lacks the required prefix', () => {
    const config = litellmConfig([{ match: 'deepseek-*' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);
    const decision = decideRoute('gpt-4o', compiled);

    expect(decision.ruleIndex).toBeNull();
  });
});

describe('glob: infix pattern (gpt-*-mini)', () => {
  it('matches a model string that fits the infix glob', () => {
    const config = litellmConfig([{ match: 'gpt-*-mini' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);
    const decision = decideRoute('gpt-4o-mini', compiled);

    expect(decision.ruleIndex).toBe(0);
  });

  it('matches when the wildcard spans multiple segments', () => {
    const config = litellmConfig([{ match: 'gpt-*-mini' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);
    // The * can match multiple characters including hyphens.
    const decision = decideRoute('gpt-4-turbo-mini', compiled);

    expect(decision.ruleIndex).toBe(0);
  });

  it('does not match when the required suffix is absent', () => {
    const config = litellmConfig([{ match: 'gpt-*-mini' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);
    const decision = decideRoute('gpt-4o', compiled);

    expect(decision.ruleIndex).toBeNull();
  });
});

describe('glob: catch-all pattern (*)', () => {
  it('* alone matches any non-empty model string', () => {
    const config = litellmConfig([{ match: '*' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);

    for (const model of ['claude-opus-4-5', 'gpt-4o', 'deepseek-v3', 'x']) {
      expect(decideRoute(model, compiled).ruleIndex).toBe(0);
    }
  });

  it('* alone matches an empty model string', () => {
    const config = litellmConfig([{ match: '*' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);
    // * matches any run of characters including the empty run.
    expect(decideRoute('', compiled).ruleIndex).toBe(0);
  });

  it('* alone matches a model string that contains a line terminator', () => {
    // The linear matcher treats no character specially — * matches any run
    // including newlines and other control characters.
    const config = litellmConfig([{ match: '*' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);
    expect(decideRoute('model\nwith-newline', compiled).ruleIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Regex metacharacters are treated as literals
// ---------------------------------------------------------------------------

describe('regex metacharacters in patterns are literals', () => {
  it('a dot in the pattern is literal and does NOT match an arbitrary character', () => {
    const config = litellmConfig([{ match: 'gpt-4.1' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);

    expect(decideRoute('gpt-4.1', compiled).ruleIndex).toBe(0);
    expect(decideRoute('gpt-4x1', compiled).ruleIndex).toBeNull();
  });

  it('a plus in the pattern is literal', () => {
    const config = litellmConfig([{ match: 'gpt+4' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);

    expect(decideRoute('gpt+4', compiled).ruleIndex).toBe(0);
    expect(decideRoute('gpt44', compiled).ruleIndex).toBeNull();
  });

  it('parentheses in the pattern are literals', () => {
    const config = litellmConfig([{ match: 'model(v2)' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);

    expect(decideRoute('model(v2)', compiled).ruleIndex).toBe(0);
    expect(decideRoute('modelv2', compiled).ruleIndex).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule ordering: first match wins
// ---------------------------------------------------------------------------

describe('rule ordering', () => {
  it('returns the first matching rule index when multiple rules match', () => {
    const config = litellmConfig([{ match: 'deepseek-*' }, { match: '*' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);

    // 'deepseek-v3' matches both rules; the first (index 0) should win.
    expect(decideRoute('deepseek-v3', compiled).ruleIndex).toBe(0);
    // 'gpt-4o' only matches rule 1.
    expect(decideRoute('gpt-4o', compiled).ruleIndex).toBe(1);
  });

  it('a later exact rule is never reached when an earlier glob already matched', () => {
    const config = litellmConfig([{ match: '*' }, { match: 'gpt-4o' }]);
    const compiled = compileRules(config, LITELLM_SECRETS);

    // The catch-all at index 0 always wins.
    expect(decideRoute('gpt-4o', compiled).ruleIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Strategy: static selects first candidate
// ---------------------------------------------------------------------------

describe('strategy: static selects first of to', () => {
  it('selects the first upstream when to has multiple names', () => {
    // default is 'b' so a fall-through would produce target.name === 'b'.
    // The assertion target.name === 'a' can only pass when the rule matched
    // and the static strategy selected the first candidate.
    const config = parseGatewayConfig({
      upstreams: {
        a: { kind: 'anthropic', url: 'https://a.example.com' },
        b: { kind: 'anthropic', url: 'https://b.example.com' },
      },
      default: 'b',
      rules: [{ match: 'claude-*', to: ['a', 'b'], strategy: { kind: 'static' } }],
    });
    const compiled = compileRules(config, EMPTY_SECRETS);
    const decision = decideRoute('claude-opus', compiled);

    expect(decision.target.name).toBe('a');
    if (decision.target.kind === 'anthropic') {
      expect(decision.target.url).toBe('https://a.example.com');
    }
    // Must have matched the rule at index 0, not fallen through to the default.
    expect(decision.ruleIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

describe('credential resolution', () => {
  it('anthropic-with-auth target carries the resolved apiKey', () => {
    const config = parseGatewayConfig({
      upstreams: {
        'my-anthropic': {
          kind: 'anthropic',
          url: 'https://api.anthropic.com',
          auth: { apiKey: 'env:MY_KEY' },
        },
      },
      default: 'my-anthropic',
    });
    const secrets = new Map([['my-anthropic', 'sk-resolved-key']]);
    const compiled = compileRules(config, secrets);
    const decision = decideRoute('claude-opus', compiled);

    expect(decision.target.kind).toBe('anthropic');
    if (decision.target.kind === 'anthropic') {
      expect(decision.target.auth).toEqual({ apiKey: 'sk-resolved-key' });
    }
  });

  it('throws naming the upstream when its secret is missing from resolvedSecrets', () => {
    const config = parseGatewayConfig({
      upstreams: {
        litellm: { kind: 'litellm', url: LITELLM_URL, masterKey: LITELLM_KEY_REF },
      },
      default: 'litellm',
    });
    // Pass an empty map — litellm key is absent.
    expect(() => compileRules(config, EMPTY_SECRETS)).toThrow(/upstream "litellm"/i);
  });

  it('throws naming the upstream (not the secret) when anthropic auth key is missing', () => {
    const config = parseGatewayConfig({
      upstreams: {
        'work-anthropic': { kind: 'anthropic', auth: { apiKey: 'env:ANTHROPIC_KEY' } },
      },
      default: 'work-anthropic',
    });
    expect(() => compileRules(config, EMPTY_SECRETS)).toThrow(/upstream "work-anthropic"/i);
  });
});

// ---------------------------------------------------------------------------
// Default route with LiteLLM
// ---------------------------------------------------------------------------

describe('default route via LiteLLM', () => {
  it('returns ruleIndex null when no rule matches and default is LiteLLM', () => {
    const config = litellmConfig([]);
    const compiled = compileRules(config, LITELLM_SECRETS);
    const decision = decideRoute('some-model', compiled);

    expect(decision.target.kind).toBe('litellm');
    expect(decision.ruleIndex).toBeNull();
  });

  it('uses the configured litellm url for the default target', () => {
    const config = litellmConfig([], 'http://custom.litellm:4000');
    const secrets = new Map([['litellm', LITELLM_KEY]]);
    const compiled = compileRules(config, secrets);
    const decision = decideRoute('some-model', compiled);

    if (decision.target.kind === 'litellm') {
      expect(decision.target.url).toBe('http://custom.litellm:4000');
    }
  });
});

// ---------------------------------------------------------------------------
// Glob matcher: limit < cursor guard (prefix + suffix overlap)
// ---------------------------------------------------------------------------

describe('glob: limit < cursor guard — prefix and suffix must not overlap', () => {
  it('gpt-*-mini does not match gpt-mini (suffix consumes the room left by prefix)', () => {
    // prefix="gpt-" (len 4), suffix="-mini" (len 5); "gpt-mini" (len 8):
    // limit = 8 - 5 = 3 < cursor = 4 → rejected.
    const compiled = compileRules(litellmConfig([{ match: 'gpt-*-mini' }]), LITELLM_SECRETS);
    expect(decideRoute('gpt-mini', compiled).ruleIndex).toBeNull();
  });

  it('a*a does not match a (the single character is claimed by both prefix and suffix)', () => {
    // prefix="a" (len 1), suffix="a" (len 1); "a" (len 1):
    // limit = 1 - 1 = 0 < cursor = 1 → rejected.
    const compiled = compileRules(anthropicOnlyConfig(['a*a']), EMPTY_SECRETS);
    expect(decideRoute('a', compiled).ruleIndex).toBeNull();
  });

  it('ab*ab matches abab (prefix and suffix exactly tile the value)', () => {
    // prefix="ab" (len 2), suffix="ab" (len 2); "abab" (len 4):
    // limit = 4 - 2 = 2 == cursor = 2 → guard does not fire; no interior → true.
    const compiled = compileRules(anthropicOnlyConfig(['ab*ab']), EMPTY_SECRETS);
    expect(decideRoute('abab', compiled).ruleIndex).toBe(0);
  });

  it('ab*ab does not match ab (suffix cannot fit alongside prefix)', () => {
    // prefix="ab" (len 2), suffix="ab" (len 2); "ab" (len 2):
    // limit = 2 - 2 = 0 < cursor = 2 → rejected.
    const compiled = compileRules(anthropicOnlyConfig(['ab*ab']), EMPTY_SECRETS);
    expect(decideRoute('ab', compiled).ruleIndex).toBeNull();
  });

  it('*a* matches a (wildcard on each side with a single-character interior segment)', () => {
    // prefix="" (len 0), suffix="" (len 0), interior=["a"]:
    // limit = 1 - 0 = 1, cursor = 0 → guard passes;
    // indexOf("a", 0) = 0, 0 + 1 = 1 not > limit 1 → matched.
    const compiled = compileRules(anthropicOnlyConfig(['*a*']), EMPTY_SECRETS);
    expect(decideRoute('a', compiled).ruleIndex).toBe(0);
  });

  it('matching is case-sensitive (gpt-* does not match GPT-4o)', () => {
    const compiled = compileRules(anthropicOnlyConfig(['gpt-*']), EMPTY_SECRETS);
    expect(decideRoute('GPT-4o', compiled).ruleIndex).toBeNull();
    // Confirm the lower-case variant still matches.
    expect(decideRoute('gpt-4o', compiled).ruleIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pattern matching is linear — no catastrophic backtracking
// ---------------------------------------------------------------------------

describe('glob matching performance', () => {
  it('rejects a long non-matching model against a 20-wildcard pattern promptly', () => {
    // Translated to a regex, `a*a*a*…a*z` against a long run of `a` with no
    // trailing `z` forces the engine to try every way of splitting the input
    // between the wildcards. The two-pointer matcher never backtracks.
    const pattern = `${'a*'.repeat(20)}z`;
    const model = 'a'.repeat(4096);
    const compiled = compileRules(anthropicOnlyConfig([pattern]), EMPTY_SECRETS);

    const started = performance.now();
    const decision = decideRoute(model, compiled);
    const elapsedMs = performance.now() - started;

    // No rule matched — the request falls through to the default target.
    expect(decision.ruleIndex).toBeNull();
    expect(elapsedMs).toBeLessThan(100);
  });

  it('still matches correctly when the same pattern is satisfied', () => {
    const pattern = `${'a*'.repeat(20)}z`;
    const compiled = compileRules(anthropicOnlyConfig([pattern]), EMPTY_SECRETS);

    expect(decideRoute(`${'a'.repeat(4096)}z`, compiled).ruleIndex).toBe(0);
  });

  it('requires every interior literal segment in order', () => {
    const compiled = compileRules(anthropicOnlyConfig(['a*b*c*d']), EMPTY_SECRETS);

    expect(decideRoute('a-b-c-d', compiled).ruleIndex).toBe(0);
    expect(decideRoute('abcd', compiled).ruleIndex).toBe(0);
    // `c` appears before `b`, so the ordered segments are not satisfiable.
    expect(decideRoute('a-c-b-d', compiled).ruleIndex).toBeNull();
  });

  it('does not let an interior segment overlap the anchored suffix', () => {
    const compiled = compileRules(anthropicOnlyConfig(['a*bc*bc']), EMPTY_SECRETS);

    expect(decideRoute('a-bc-bc', compiled).ruleIndex).toBe(0);
    // Only one `bc` is present; it cannot satisfy both the interior segment
    // and the anchored suffix.
    expect(decideRoute('a-bc', compiled).ruleIndex).toBeNull();
  });

  it('treats adjacent wildcards as one wildcard', () => {
    const compiled = compileRules(anthropicOnlyConfig(['gpt-**-mini']), EMPTY_SECRETS);

    expect(decideRoute('gpt-4o-mini', compiled).ruleIndex).toBe(0);
    expect(decideRoute('gpt--mini', compiled).ruleIndex).toBe(0);
    expect(decideRoute('gpt-4o-nano', compiled).ruleIndex).toBeNull();
  });
});

/**
 * Case 205's counterpart for §3.4 — the tool-list conformance suite (FACT-86).
 *
 * Every adapter that resolves a caller's Makaio tool list into its own native
 * gate has to answer the same questions: what the model is offered, what
 * a per-call gate does with an empty or restricted list, whether a bypassing
 * provider config still gets defeated, and whether shell command rules and a
 * central-approval rewrite are honoured. Three more ask whether trusted provider
 * config (a pre-tool hook answering `allow`, possibly with an input rewrite, and
 * provider-enabled skills) stays bounded by the caller lists. This file asks all of
 * them of an adapter through one structural probe contract, so a new adapter proves the same
 * properties the moment it exposes a probe — no adapter-specific test file. Calls and
 * approval answers are stated semantically (`shellCall`, `readCall`, `skillCall`,
 * `rewriteCommand`, `alwaysAllow`); each probe maps them onto its native shapes. Each
 * provider-capability case has a no-caller-lists control (3c, 8c, 10c) proving the
 * injected provider config really opens the path the case then expects closed.
 *
 * **Why it lives here and not beside the per-adapter unit tests, or in
 * `__tests__/`.** Like `teardown-declaration-conformance.test.ts` next to it: the
 * suite in `__tests__/` runs one adapter per process under `MAKAIO_TEST_ADAPTER`
 * and is excluded from the default test run (vitest.config.ts:66), because most
 * of its cases spend real provider money. This suite spends none — every probe
 * builds a real connector and drives its real per-call gate in-process, with
 * central tool approval replaced by a counting closure, exactly as the existing
 * `tool-allowlist-gate.test.ts` does for the Claude Agent SDK adapter alone.
 * Nothing here needs a model round trip, so it belongs in the default run.
 *
 * **Why the probe contract is declared twice.** The probe types are declared
 * structurally, once in each probe module and once here: this file asks nothing
 * of any adapter's internals beyond this shape, and a probe module needs no
 * dependency on this file (or any shared package) to satisfy it. A new adapter's
 * probe is checked against this file's local structural type the moment it is
 * added to the registry below — there is no second export to keep in sync.
 *
 * **Why the registry is a static map, not discovery.** Unlike Case 205's
 * `discoverAdapters()` (every adapter with a contributed connector answers the
 * teardown question the same way), most adapters here do not yet have a probe:
 * FACT-75..81 add one per adapter family. The registry names, per adapter
 * directory, either a probe factory or the Jira issue that will add one; the
 * guard test below keeps the registry's keys equal to the adapter directories
 * that actually exist, and the `PendingIssue` type keeps pending values shaped
 * like real issue keys, so an adapter can never silently fall out of the suite.
 */
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolListProbe } from './claude-agent-sdk/src/test/index.js';

/** Options for a {@link CreateToolListProbe}; tool lists use Makaio tool names. */
interface ToolListProbeOptions {
  /** Makaio-named tool allowlist, or `undefined` when unrestricted. */
  readonly allowedTools?: readonly string[];
  /** Makaio-named tool denylist, or `undefined` when none is given. */
  readonly disallowedTools?: readonly string[];
  /**
   * Inject provider config that would, on its own, let shell and file read calls skip
   * the per-call gate: whichever of an auto-approved built-in allowlist and a permissive
   * mode the adapter has (claude: `queryOptions.allowedTools` `['Bash', 'Read']`,
   * `permissionMode: 'bypassPermissions'`, and `allowDangerouslySkipPermissions: true`).
   * Case 3c proves the injection really bypasses when no caller list is given.
   */
  readonly withBypassingProviderConfig?: boolean;
  /**
   * Provider-config pre-tool hook answering every call with `allow`, optionally rewriting
   * a shell call's command (claude: one `queryOptions.hooks.PreToolUse` matcher without
   * `matcher`).
   */
  readonly providerPreToolUseHook?: {
    readonly decision: 'allow';
    readonly rewriteCommand?: string;
  };
  /** Provider-config enablement of every skill (claude: `queryOptions.skills: 'all'`). */
  readonly providerSkills?: 'all';
}

/** One tool call in the adapter's native shape, built by the probe's call helpers. */
interface ToolListProbeCall {
  /** Native tool name as the SDK reports it. */
  readonly name: string;
  /** Native tool call input. */
  readonly input: Record<string, unknown>;
}

/** Central approval answer for one probed call, stated semantically; the probe maps it to native. */
interface ToolListProbeApproval {
  /** Replace the shell call's command. */
  readonly rewriteCommand?: string;
  /** Ask to always allow the tool (the adapter's native "remember this approval"). */
  readonly alwaysAllow?: true;
}

/** Outcome of one probed tool call through the adapter's per-call gate. */
interface ToolListProbeGateResult {
  /** Whether the SDK was told to run the call. */
  allowed: boolean;
  /** Deny message, when denied; diagnostic only (assertion message), never asserted on. */
  reason?: string;
  /** Whether the central tool approval was asked for this call. */
  centralApprovalCalled: boolean;
  /** Whether the native gate response would install a persistent permission rule. */
  persistsRules: boolean;
}

/** Adapter view of a resolved tool list, as consumed by this suite. */
interface ToolListProbe {
  /**
   * Translate a Makaio or MCP tool name into the adapter's native name.
   * @param makaioOrMcpName - Makaio tool name or `mcp__<server>__<tool>`.
   * @returns The native tool name.
   */
  nativeName(makaioOrMcpName: string): string;
  /** Built-in tools offered to the model, `'all'` when unrestricted. */
  readonly availableBuiltIns: readonly string[] | 'all';
  /**
   * Build a `shell_exec` call in native shape.
   * @param command - Shell command line.
   * @returns The native call.
   */
  shellCall(command: string): ToolListProbeCall;
  /**
   * Build a `read_file` call in native shape.
   * @param path - File path to read.
   * @returns The native call.
   */
  readCall(path: string): ToolListProbeCall;
  /**
   * Build a skill call in native shape, when the adapter has a skill tool (it has no
   * Makaio name). Required for the `provider-skills` cases.
   * @param skill - Skill name.
   * @returns The native call.
   */
  skillCall?(skill: string): ToolListProbeCall;
  /**
   * Run one tool call through the gate the underlying SDK receives.
   * @param call - Native tool call from one of the call helpers.
   * @param approval - Central approval answer for this call; plain `allow` when omitted.
   * @returns The gate outcome.
   */
  gate(call: ToolListProbeCall, approval?: ToolListProbeApproval): Promise<ToolListProbeGateResult>;
}

/** Builds a {@link ToolListProbe} for one adapter. */
type CreateToolListProbe = (options: ToolListProbeOptions) => Promise<ToolListProbe>;

/** Probe options an adapter may be unable to express, keyed by the case group that needs them. */
type ProviderCapability = 'provider-bypass' | 'provider-hooks' | 'provider-skills';

/** Jira issue key a pending adapter names; the template type keeps malformed keys out at compile time. */
type PendingIssue = `FACT-${number}`;

/**
 * One registry entry: a probe-bearing adapter, or a pending one naming its Jira issue. A
 * probe-bearing adapter lists the provider capabilities it cannot express in
 * `unsupported`, with the Jira issue (or reason) as value; those cases are skipped with it.
 */
type RegistryEntry =
  | {
      readonly probe: CreateToolListProbe;
      readonly unsupported?: Readonly<Partial<Record<ProviderCapability, string>>>;
    }
  | { readonly pending: PendingIssue };

/** A registry entry that carries a probe. */
type ProbeEntry = Extract<RegistryEntry, { probe: CreateToolListProbe }>;

/**
 * Adapter directory this suite has not yet reached; value is the Jira issue that adds its probe.
 * @param issue - Jira issue key that adds this adapter's probe.
 * @returns The registry's pending entry for that adapter.
 */
const PENDING = (issue: PendingIssue): RegistryEntry => ({ pending: issue });

/**
 * Static registry of every `adapters/implementations/*` directory this suite knows
 * about, keyed by adapter directory name. FACT-75..81 replace the pending entries
 * with real probes as their adapters gain one; the guard tests below keep this map
 * honest against the actual directories and issue-key shape.
 */
const REGISTRY: Readonly<Record<string, RegistryEntry>> = {
  'claude-agent-sdk': { probe: createToolListProbe },
  'claude-code-cli': PENDING('FACT-75'),
  'claude-code-tmux': PENDING('FACT-75'),
  'codex-app-server': PENDING('FACT-76'),
  'anthropic-sdk': PENDING('FACT-77'),
  'openai-node': PENDING('FACT-78'),
  'cursor-sdk': PENDING('FACT-79'),
  'pi-sdk': PENDING('FACT-80'),
  'qwen-acp': PENDING('FACT-81'),
};

/** Adapter entries that carry a probe, as `[adapterDir, entry]` pairs for `describe.each`. */
const PROBE_ADAPTERS: readonly (readonly [string, ProbeEntry])[] = Object.entries(REGISTRY).filter(
  (entry): entry is [string, ProbeEntry] => 'probe' in entry[1],
);

/**
 * Register a case that needs a provider capability: runs when the adapter can express it,
 * otherwise is skipped with the registry's reason in its name.
 * @param entry - The adapter's registry entry.
 * @param capability - Provider capability the case needs.
 * @param name - Case name.
 * @param fn - Case body.
 */
function itWithCapability(
  entry: ProbeEntry,
  capability: ProviderCapability,
  name: string,
  fn: () => Promise<void>,
): void {
  const reason = entry.unsupported?.[capability];
  if (reason === undefined) it(name, fn);
  else it.skip(`${name} (not supported: ${capability}, pending ${reason})`, fn);
}

/** Adapter entries still pending a probe, as `[adapterDir, issue]` pairs. */
const PENDING_ADAPTERS: readonly (readonly [string, PendingIssue])[] = Object.entries(REGISTRY)
  .filter((entry): entry is [string, { pending: PendingIssue }] => 'pending' in entry[1])
  .map(([adapterDir, entry]) => [adapterDir, entry.pending] as const);

/** MCP tool name used to prove case 1's "no MCP-visibility field" claim: an empty allowlist denies it too. */
const MCP_PROBE_TOOL_NAME = 'mcp__s__t';

/** File path the `read_file` probe calls read (never touched: no call reaches a tool). */
const PROBE_FILE_PATH = '/tmp/probe.txt';

/** Skill name the skill probe calls invoke. */
const PROBE_SKILL_NAME = 'probe-skill';

/**
 * Build a skill call, failing the case when the adapter declares `provider-skills`
 * support but its probe has no skill tool.
 * @param probe - The adapter probe.
 * @param skill - Skill name.
 * @returns The native skill call.
 * @throws When the probe has no `skillCall`.
 */
function skillCallOf(probe: ToolListProbe, skill: string): ToolListProbeCall {
  if (probe.skillCall === undefined) throw new Error('probe supports provider-skills but has no skillCall');
  return probe.skillCall(skill);
}

/** This file's own directory (`adapters/implementations/`), for the registry guard below. */
const IMPLEMENTATIONS_DIR = fileURLToPath(new URL('.', import.meta.url));

describe('tool-list conformance suite (FACT-86)', () => {
  describe.each(PROBE_ADAPTERS)('%s', (_adapterDir, entry) => {
    const createProbe = entry.probe;

    it('case 1: an empty allowlist offers no built-ins and denies everything without asking central approval', async () => {
      const probe = await createProbe({ allowedTools: [] });

      expect(probe.availableBuiltIns).toEqual([]);

      const readResult = await probe.gate(probe.readCall(PROBE_FILE_PATH));
      expect(readResult.allowed, readResult.reason).toBe(false);
      expect(readResult.centralApprovalCalled).toBe(false);

      const mcpResult = await probe.gate({ name: probe.nativeName(MCP_PROBE_TOOL_NAME), input: {} });
      expect(mcpResult.allowed, mcpResult.reason).toBe(false);
      expect(mcpResult.centralApprovalCalled).toBe(false);
    });

    it('case 2: a restricted allowlist offers only the requested built-ins and denies what is off it', async () => {
      const probe = await createProbe({ allowedTools: ['read_file'] });

      expect(probe.availableBuiltIns).toEqual([probe.nativeName('read_file')]);

      const readResult = await probe.gate(probe.readCall(PROBE_FILE_PATH));
      expect(readResult.allowed, readResult.reason).toBe(true);
      expect(readResult.centralApprovalCalled).toBe(true);

      const shellResult = await probe.gate(probe.shellCall('git status'));
      expect(shellResult.allowed, shellResult.reason).toBe(false);
      expect(shellResult.centralApprovalCalled).toBe(false);
    });

    itWithCapability(
      entry,
      'provider-bypass',
      'case 3: a bypassing provider config does not skip central approval or defeat the caller allowlist',
      async () => {
        const probe = await createProbe({ allowedTools: ['read_file'], withBypassingProviderConfig: true });

        const readResult = await probe.gate(probe.readCall(PROBE_FILE_PATH));
        expect(readResult.allowed, readResult.reason).toBe(true);
        expect(readResult.centralApprovalCalled).toBe(true);

        const shellResult = await probe.gate(probe.shellCall('git status'));
        expect(shellResult.allowed, shellResult.reason).toBe(false);
        expect(shellResult.centralApprovalCalled).toBe(false);
      },
    );

    itWithCapability(
      entry,
      'provider-bypass',
      'case 3c (control): without caller lists the injected bypassing config really skips central approval',
      async () => {
        const probe = await createProbe({ withBypassingProviderConfig: true });

        const readResult = await probe.gate(probe.readCall(PROBE_FILE_PATH));
        expect(readResult.allowed, readResult.reason).toBe(true);
        expect(readResult.centralApprovalCalled).toBe(false);
      },
    );

    it('case 4: an exact shell_exec command rule allows the exact command and denies chained variants', async () => {
      const probe = await createProbe({ allowedTools: ['shell_exec(git status)'] });

      const exact = await probe.gate(probe.shellCall('git status'));
      expect(exact.allowed, exact.reason).toBe(true);
      const other = await probe.gate(probe.shellCall('git push'));
      expect(other.allowed, other.reason).toBe(false);
      const chained = await probe.gate(probe.shellCall('git status; git push'));
      expect(chained.allowed, chained.reason).toBe(false);
    });

    it('case 5: a shell_exec denylist prefix rule beats a plain shell_exec allowlist entry', async () => {
      const probe = await createProbe({ allowedTools: ['shell_exec'], disallowedTools: ['shell_exec(git push:*)'] });

      const chained = await probe.gate(probe.shellCall('true && git push'));
      expect(chained.allowed, chained.reason).toBe(false);
      const allowed = await probe.gate(probe.shellCall('git status'));
      expect(allowed.allowed, allowed.reason).toBe(true);
    });

    it('case 6: central approval is asked and its answer is honoured, rewrite and permission persistence alike', async () => {
      const probe = await createProbe({ allowedTools: ['shell_exec(git status)'] });

      const rewritten = await probe.gate(probe.shellCall('git status'), { rewriteCommand: 'git push' });
      expect(rewritten.allowed, rewritten.reason).toBe(false);
      expect(rewritten.centralApprovalCalled).toBe(true);

      const persisted = await probe.gate(probe.shellCall('git status'), { alwaysAllow: true });
      expect(persisted.centralApprovalCalled).toBe(true);
      expect(persisted.allowed, persisted.reason).toBe(true);
      expect(persisted.persistsRules).toBe(false);
    });

    // Settings-file allow rules and hooks (`settingSources`) are not probe-expressible; their
    // live check lives in FACT-72 (Jira) and is not part of this deterministic suite.

    itWithCapability(
      entry,
      'provider-hooks',
      'case 8: a provider pre-tool hook answering allow for an allowlisted tool still reaches central approval',
      async () => {
        const probe = await createProbe({ allowedTools: ['read_file'], providerPreToolUseHook: { decision: 'allow' } });

        const readResult = await probe.gate(probe.readCall(PROBE_FILE_PATH));
        expect(readResult.allowed, readResult.reason).toBe(true);
        expect(readResult.centralApprovalCalled).toBe(true);
      },
    );

    itWithCapability(
      entry,
      'provider-hooks',
      'case 8c (control): without caller lists the injected allow hook really skips central approval',
      async () => {
        const probe = await createProbe({ providerPreToolUseHook: { decision: 'allow' } });

        const readResult = await probe.gate(probe.readCall(PROBE_FILE_PATH));
        expect(readResult.allowed, readResult.reason).toBe(true);
        expect(readResult.centralApprovalCalled).toBe(false);
      },
    );

    itWithCapability(
      entry,
      'provider-hooks',
      'case 9: a provider pre-tool hook cannot allow a rewritten command past a shell_exec command rule',
      async () => {
        const probe = await createProbe({
          allowedTools: ['shell_exec(git status)'],
          providerPreToolUseHook: { decision: 'allow', rewriteCommand: 'git push' },
        });

        const result = await probe.gate(probe.shellCall('git status'));
        expect(result.allowed, result.reason).toBe(false);
        expect(result.centralApprovalCalled).toBe(false);
      },
    );

    itWithCapability(
      entry,
      'provider-skills',
      'case 10: provider-enabled skills do not open the skill tool past an allowlist that omits it',
      async () => {
        const probe = await createProbe({ allowedTools: ['read_file'], providerSkills: 'all' });

        expect(probe.skillCall).toBeDefined();
        const result = await probe.gate(skillCallOf(probe, PROBE_SKILL_NAME));
        expect(result.allowed, result.reason).toBe(false);
        expect(result.centralApprovalCalled).toBe(false);
      },
    );

    itWithCapability(
      entry,
      'provider-skills',
      'case 10c (control): without caller lists the injected skill enablement really opens the skill tool',
      async () => {
        const probe = await createProbe({ providerSkills: 'all' });

        const result = await probe.gate(skillCallOf(probe, PROBE_SKILL_NAME));
        expect(result.allowed, result.reason).toBe(true);
        expect(result.centralApprovalCalled).toBe(false);
      },
    );
  });

  describe('case 7: adapters without a probe yet', () => {
    for (const [adapterDir, issue] of PENDING_ADAPTERS) {
      it.skip(`${adapterDir}: not supported, pending ${issue}`, () => {
        // Nothing to run: the registry names the issue that adds this adapter's probe.
      });
    }
  });

  describe('registry guard', () => {
    it('has exactly one entry per adapters/implementations/* directory that contributes a descriptor.json', () => {
      // Not `discoverAdapters()` from scripts/lib/conformance/discovery.ts: it keeps only
      // descriptors with `contributions.adapters`, which would drop qwen-acp (its descriptor
      // has `contributions: {}`), and FACT-81 needs qwen-acp in this registry.
      const adapterDirs = readdirSync(IMPLEMENTATIONS_DIR, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)
        .filter((name) => existsSync(join(IMPLEMENTATIONS_DIR, name, 'descriptor.json')))
        .sort();

      expect(Object.keys(REGISTRY).sort()).toEqual(adapterDirs);
    });
  });
});

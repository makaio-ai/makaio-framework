/**
 * Case 205's counterpart for §3.4 — the tool-list conformance suite (FACT-86).
 *
 * Every adapter that resolves a caller's Makaio tool list into its own native
 * gate has to answer the same seven questions: what the model is offered, what
 * a per-call gate does with an empty or restricted list, whether a bypassing
 * provider config still gets defeated, and whether shell command rules and a
 * central-approval rewrite are honoured. This file asks all seven of an adapter
 * through one structural probe contract, so a new adapter proves the same
 * properties the moment it exposes a probe — no adapter-specific test file.
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
 * guard tests below keep the registry's keys equal to the adapter directories
 * that actually exist, and pending values shaped like real issue keys, so an
 * adapter can never silently fall out of the suite.
 */
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolVocabulary } from '@makaio/contracts';
import { createToolListProbe } from './claude-agent-sdk/src/test/index.js';

/** Options for a {@link CreateToolListProbe}; tool lists use Makaio tool names. */
interface ToolListProbeOptions {
  /** Makaio-named tool allowlist, or `undefined` when unrestricted. */
  readonly allowedTools?: readonly string[];
  /** Makaio-named tool denylist, or `undefined` when none is given. */
  readonly disallowedTools?: readonly string[];
  /**
   * Inject provider config that would bypass the gate: the adapter's own
   * equivalent of an auto-approved built-in allowlist plus a permissive mode
   * (claude: `queryOptions.allowedTools` `['Bash', 'Read']` and
   * `permissionMode: 'bypassPermissions'`).
   */
  readonly withBypassingProviderConfig?: boolean;
}

/** Outcome of one probed tool call through the adapter's per-call gate. */
interface ToolListProbeGateResult {
  /** Whether the SDK was told to run the call. */
  allowed: boolean;
  /** Deny message, when denied. */
  reason?: string;
  /** Whether the central tool approval was asked for this call. */
  centralApprovalCalled: boolean;
  /** Whether the result would install persistent SDK permission rules. */
  persistsRules: boolean;
}

/** Adapter view of a resolved tool list, as consumed by this suite. */
interface ToolListProbe {
  /** Native tool vocabulary of the adapter. */
  readonly vocabulary: ToolVocabulary;
  /**
   * Translate a Makaio or MCP tool name into the adapter's native name.
   * @param makaioOrMcpName - Makaio tool name or `mcp__<server>__<tool>`.
   * @returns The native tool name.
   */
  nativeName(makaioOrMcpName: string): string;
  /** Built-in tools offered to the model, `'all'` when unrestricted. */
  readonly availableBuiltIns: readonly string[] | 'all';
  /** Settings that would skip the per-call gate. */
  readonly bypass: { autoApproved: readonly string[]; permissionModeBypasses: boolean };
  /**
   * Run one tool call through the gate the underlying SDK receives.
   * @param nativeName - Native tool name as the SDK reports it.
   * @param input - Tool call input.
   * @param approval - Central approval answer overrides for this call.
   * @returns The gate outcome.
   */
  gate(
    nativeName: string,
    input: Record<string, unknown>,
    approval?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] },
  ): Promise<ToolListProbeGateResult>;
}

/** Builds a {@link ToolListProbe} for one adapter. */
type CreateToolListProbe = (options: ToolListProbeOptions) => Promise<ToolListProbe>;

/** One registry entry: a probe-bearing adapter, or a pending one naming its Jira issue. */
type RegistryEntry = { readonly probe: CreateToolListProbe } | { readonly pending: string };

/**
 * Adapter directory this suite has not yet reached; value is the Jira issue that adds its probe.
 * @param issue - Jira issue key that adds this adapter's probe.
 * @returns The registry's pending entry for that adapter.
 */
const PENDING = (issue: string): RegistryEntry => ({ pending: issue });

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

/** Adapter entries that carry a probe, as `[adapterDir, probe]` pairs for `it.each`. */
const PROBE_ADAPTERS: readonly (readonly [string, CreateToolListProbe])[] = Object.entries(REGISTRY)
  .filter((entry): entry is [string, { probe: CreateToolListProbe }] => 'probe' in entry[1])
  .map(([adapterDir, entry]) => [adapterDir, entry.probe] as const);

/** Adapter entries still pending a probe, as `[adapterDir, issue]` pairs. */
const PENDING_ADAPTERS: readonly (readonly [string, string])[] = Object.entries(REGISTRY)
  .filter((entry): entry is [string, { pending: string }] => 'pending' in entry[1])
  .map(([adapterDir, entry]) => [adapterDir, entry.pending] as const);

/** MCP tool name used to prove case 1's "no MCP-visibility field" claim: an empty allowlist denies it too. */
const MCP_PROBE_TOOL_NAME = 'mcp__s__t';

/** This file's own directory (`adapters/implementations/`), for the registry guard below. */
const IMPLEMENTATIONS_DIR = fileURLToPath(new URL('.', import.meta.url));

describe('tool-list conformance suite (FACT-86)', () => {
  describe.each(PROBE_ADAPTERS)('%s', (_adapterDir, createProbe) => {
    it('case 1: an empty allowlist offers no built-ins and denies everything without asking central approval', async () => {
      const probe = await createProbe({ allowedTools: [] });

      expect(probe.availableBuiltIns).toEqual([]);

      const readResult = await probe.gate(probe.nativeName('read_file'), {});
      expect(readResult.allowed).toBe(false);
      expect(readResult.centralApprovalCalled).toBe(false);

      const mcpResult = await probe.gate(MCP_PROBE_TOOL_NAME, {});
      expect(mcpResult.allowed).toBe(false);
      expect(mcpResult.centralApprovalCalled).toBe(false);
    });

    it('case 2: a restricted allowlist offers only the requested built-ins and denies what is off it', async () => {
      const probe = await createProbe({ allowedTools: ['read_file'] });

      expect(probe.availableBuiltIns).toEqual([probe.nativeName('read_file')]);

      const bashResult = await probe.gate(probe.nativeName('shell_exec'), {});
      expect(bashResult.allowed).toBe(false);
      expect(bashResult.centralApprovalCalled).toBe(false);
    });

    it('case 3: a bypassing provider config does not defeat the caller allowlist', async () => {
      const probe = await createProbe({ allowedTools: ['read_file'], withBypassingProviderConfig: true });

      expect(probe.bypass.autoApproved).toEqual([]);
      expect(probe.bypass.permissionModeBypasses).toBe(false);

      const bashResult = await probe.gate(probe.nativeName('shell_exec'), {});
      expect(bashResult.allowed).toBe(false);
    });

    it('case 4: an exact shell_exec command rule allows the exact command and denies chained variants', async () => {
      const probe = await createProbe({ allowedTools: ['shell_exec(git status)'] });
      const bash = probe.nativeName('shell_exec');

      expect((await probe.gate(bash, { command: 'git status' })).allowed).toBe(true);
      expect((await probe.gate(bash, { command: 'git push' })).allowed).toBe(false);
      expect((await probe.gate(bash, { command: 'git status; git push' })).allowed).toBe(false);
    });

    it('case 5: a shell_exec denylist prefix rule beats a plain shell_exec allowlist entry', async () => {
      const probe = await createProbe({ allowedTools: ['shell_exec'], disallowedTools: ['shell_exec(git push:*)'] });
      const bash = probe.nativeName('shell_exec');

      expect((await probe.gate(bash, { command: 'true && git push' })).allowed).toBe(false);
      expect((await probe.gate(bash, { command: 'git status' })).allowed).toBe(true);
    });

    it('case 6: central approval is asked and its answer is honoured, rewrite and permission persistence alike', async () => {
      const probe = await createProbe({ allowedTools: ['shell_exec(git status)'] });
      const bash = probe.nativeName('shell_exec');

      const rewritten = await probe.gate(bash, { command: 'git status' }, { updatedInput: { command: 'git push' } });
      expect(rewritten.allowed).toBe(false);
      expect(rewritten.centralApprovalCalled).toBe(true);

      const permissive = await createProbe({ allowedTools: ['shell_exec(git status)'] });
      const persisted = await permissive.gate(
        permissive.nativeName('shell_exec'),
        { command: 'git status' },
        { updatedPermissions: [{ type: 'addRules', rules: [{ toolName: bash }], behavior: 'allow' }] },
      );
      expect(persisted.allowed).toBe(true);
      expect(persisted.persistsRules).toBe(false);
    });
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
      const adapterDirs = readdirSync(IMPLEMENTATIONS_DIR, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)
        .filter((name) => existsSync(join(IMPLEMENTATIONS_DIR, name, 'descriptor.json')))
        .sort();

      expect(Object.keys(REGISTRY).sort()).toEqual(adapterDirs);
    });

    it('marks every pending adapter with a well-formed Jira issue key', () => {
      for (const [adapterDir, issue] of PENDING_ADAPTERS) {
        expect(issue, `pending entry for '${adapterDir}'`).toMatch(/^FACT-\d+$/);
      }
    });
  });
});

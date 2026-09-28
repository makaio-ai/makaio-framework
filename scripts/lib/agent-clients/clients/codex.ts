/**
 * Codex probe contract.
 *
 * Native response shapes are not written here — they are rendered by
 * `renderCodexNativeResponse`, the same function the client's `hook.handle`
 * composer uses at runtime. This module only chooses which effects a scenario
 * contributes and how the resulting native behavior is observed.
 * @packageDocumentation
 */

import type { CanonicalEffect, ProviderContributionEnvelope } from '@makaio/contracts/client';
import { CODEX_HOOK_RESPONSE_CAPABILITIES, clientDefinition } from '../../../../clients/codex/src/definition.js';
import {
  CODEX_CLIENT_ID,
  CODEX_CONTRACT_ID,
  createCodexPreToolUseDenyEffect,
  createCodexPreToolUseUpdateEffect,
  type CodexBlockEffects,
} from '../../../../clients/codex/src/runtime/hook-response-contracts.js';
import { renderCodexNativeResponse } from '../../../../clients/codex/src/runtime/hook-response-composer.js';
import {
  CODEX_HOOK_POST_COMPACT,
  CODEX_HOOK_POST_TOOL_USE,
  CODEX_HOOK_PRE_COMPACT,
  CODEX_HOOK_PRE_TOOL_USE,
  CODEX_HOOK_SESSION_START,
  CODEX_HOOK_SUBAGENT_START,
  CODEX_HOOK_SUBAGENT_STOP,
  CODEX_HOOK_USER_PROMPT_SUBMIT,
} from '../../../../clients/codex/src/runtime/schemas.js';
import {
  CONTEXT_VALUE,
  contextAppendScenario,
  DENY_REASON,
  MCP_TOOL_PROMPT,
  ORIGINAL_MARKER,
  RESPONSE_CONSUMED_MARKER,
  REWRITTEN_MARKER,
  SUBAGENT_CONTEXT_VALUE,
  TOOL_MARKER,
  TOOL_MARKER_PROMPT,
  type ClientProbeContract,
  type ProbeEffectScenario,
} from '../probe-contract.js';
import { PROBE_MCP_SERVER_NAME, PROBE_MCP_SERVER_PATH, PROBE_TOOL_NAME } from '../probe-mcp-server.js';

/**
 * Prompt that makes the parent spawn one subagent and report the token it read.
 *
 * The relay is what makes the oracle sound. The scenario configures a hook on
 * `SubagentStart` alone, so the marker exists nowhere in the parent's own
 * context; if it reaches the parent's final response, it travelled there inside
 * the subagent's report, which is exactly the claim under test.
 *
 * Codex spawns a subagent from a direct instruction — the CLI enables
 * multi-agent tools by default (`agents.enabled`), and the built-in `default`
 * agent needs no `~/.codex/agents/*.toml` file, so the isolated probe workspace
 * needs no extra configuration to reach the event.
 */
const SUBAGENT_RELAY_PROMPT =
  'MAKAIO_PROBE_MARKER: spawn one subagent and ask it to report the probe session token from its own context. Then reply with the token it reports.';

/**
 * Prompt that makes the parent spawn one subagent whose only errand is one shell read.
 *
 * The `PostToolUse` subagent scenario matches `Bash`, so the parent must not run
 * a shell command itself, and the subagent must: an abstract "report your
 * token" errand gives the subagent no tool call to hook. The token enters the
 * subagent's context only after that read, and reaches the parent's final
 * response only through the subagent's report.
 */
const SUBAGENT_TOOL_RELAY_PROMPT =
  'MAKAIO_PROBE_MARKER: spawn exactly one subagent and ask it to run `cat MAKAIO_PROBE.md` with its shell tool and then report the probe session token from its own context. Do not run any shell command yourself. Then reply with the token it reports.';

/**
 * Prompt that spawns one subagent on an ordinary errand.
 *
 * A subagent event cannot be observed without a subagent, and the generic
 * "exercise SubagentStop if available" prompt does not reliably produce one.
 */
const SUBAGENT_SPAWN_PROMPT =
  'MAKAIO_PROBE_MARKER: spawn one subagent to read MAKAIO_PROBE.md and report which provider it names, then reply with what it reports.';

/**
 * Prompt whose single tool call grows the context past the compaction limit.
 *
 * Paired with {@link AUTO_COMPACT_ARGS}: the prompt supplies turn content, the
 * configuration supplies the threshold that content has to cross.
 */
const COMPACTION_PROMPT = 'MAKAIO_PROBE_MARKER: read MAKAIO_PROBE.md, then reply with exactly probe-ack.';

/**
 * Configuration that makes a one-turn `codex exec` run compact deterministically.
 *
 * Codex has no `/compact` command in non-interactive mode, so the manual
 * trigger is out of reach; the documented alternative is the automatic one.
 * `model_auto_compact_token_limit` is the token threshold that triggers
 * automatic history compaction, and a limit far below a real session preamble
 * makes the first turn cross it. Both compaction hooks then fire with
 * `trigger: "auto"` inside one bounded run.
 */
const AUTO_COMPACT_ARGS = ['--config', 'model_auto_compact_token_limit=10000'] as const;

/** Instruction a blocked turn must echo for a response-consumption oracle. */
const BLOCK_INSTRUCTION = `The requested tool result failed. Reply with exactly ${RESPONSE_CONSUMED_MARKER}.`;

/** Tool request whose rewrite is observable through a distinct workspace marker. */
const REWRITE_PROMPT = `MAKAIO_PROBE_MARKER: use the shell tool to run \`touch ${ORIGINAL_MARKER}\`, then reply probe-ack.`;

/**
 * Render one native Codex sentinel from the client's own renderer.
 * @param eventName - Native hook event being exercised.
 * @param effects - Effects the scenario contributes.
 * @returns Native response body written to stdout by the capture shim.
 */
function sentinel(eventName: string, effects: ReadonlyArray<CanonicalEffect | ProviderContributionEnvelope>): string {
  return renderCodexNativeResponse(eventName, effects).stdout;
}

/**
 * Additional `PostToolUse` context-append attempts on the other native tool paths.
 *
 * An MCP tool call and a tool call made inside a subagent reach `PostToolUse`
 * through different code in the binary than a shell call in the main session,
 * so each is proven on its own. Both matchers are exact tool names: Codex
 * treats a matcher of only letters, digits, `_` and `|` as a name list and
 * anything else as an unanchored regex.
 * @returns The MCP and subagent probe shapes.
 */
function postToolUseExtraContextScenarios(): readonly ProbeEffectScenario[] {
  const eventName = CODEX_HOOK_POST_TOOL_USE;
  return [
    contextAppendScenario(sentinel(eventName, [{ kind: 'context.append', value: CONTEXT_VALUE }]), {
      suffix: 'mcp-context-append',
      description: 'Attempts to append context after an MCP tool call.',
      prompt: MCP_TOOL_PROMPT,
      hookMatcher: `mcp__${PROBE_MCP_SERVER_NAME}__${PROBE_TOOL_NAME}`,
      // Codex hides MCP tools behind tool search unless the server is marked alwaysLoad.
      mcpServers: { [PROBE_MCP_SERVER_NAME]: { command: 'bun', args: [PROBE_MCP_SERVER_PATH], alwaysLoad: true } },
    }),
    // The parent only calls `spawn_agent`, so a `Bash` matcher fires for the
    // subagent's read alone. No scenario flags: the subagent is expected to
    // run under the parent's `approval_policy="never"` and `workspace-write`
    // sandbox, where a read-only `cat` needs no approval; the live run is what
    // confirms that inheritance.
    contextAppendScenario(sentinel(eventName, [{ kind: 'context.append', value: SUBAGENT_CONTEXT_VALUE }]), {
      suffix: 'subagent-context-append',
      description: 'Attempts to append context after a tool call made inside a spawned subagent.',
      prompt: SUBAGENT_TOOL_RELAY_PROMPT,
      hookMatcher: 'Bash',
      // The Bash matcher alone also passes if the parent runs `cat` itself; Codex puts `agent_id` only on tool hooks fired inside a subagent.
      requiredPayloadKeys: ['agent_id'],
    }),
  ];
}

/**
 * Wrap a Codex block effect in a contribution envelope.
 *
 * Built here rather than through a `createCodex*BlockEffect` factory because
 * the event varies: the client exports one block factory per event, and all
 * five return the identical `{ decision: 'block', reason }` payload — the
 * per-event difference lives in the renderer, not the effect. Dispatching to
 * them would need a five-way lookup that renders the same bytes and adds an
 * unmapped-event failure path. Typing the payload as {@link CodexBlockEffects}
 * keeps the field names compile-checked, which is the part that matters.
 * @param reason - Reason the block effect carries.
 * @returns Provider contribution envelope for a Codex block effect.
 */
function blockEffect(reason: string): ProviderContributionEnvelope<CodexBlockEffects> {
  return { clientId: CODEX_CLIENT_ID, contractId: CODEX_CONTRACT_ID, effects: { decision: 'block', reason } };
}

/**
 * Build the block probe shape, whose observable outcome depends on where in
 * the turn the event fires.
 *
 * `SessionStart` and `UserPromptSubmit` terminate before any model work, so the
 * proof is the absence of the tool marker. Later events cannot prevent the turn
 * and instead prove consumption through the final response.
 * @param eventName - Native hook event being exercised.
 * @returns Block probe shape.
 */
function blockScenario(eventName: string): ProbeEffectScenario {
  // SessionStart renders `stopReason`, which is itself the observable value.
  const reason = eventName === CODEX_HOOK_SESSION_START ? RESPONSE_CONSUMED_MARKER : BLOCK_INSTRUCTION;
  const sentinelOutput = sentinel(eventName, [blockEffect(reason)]);

  if (eventName === CODEX_HOOK_PRE_TOOL_USE) {
    return {
      suffix: 'block',
      sentinelOutput,
      oracle: 'sentinel-must-block-tool',
      expectedAbsentMarker: TOOL_MARKER,
    };
  }

  if (eventName === CODEX_HOOK_SESSION_START || eventName === CODEX_HOOK_USER_PROMPT_SUBMIT) {
    return {
      suffix: 'block',
      sentinelOutput,
      oracle: 'sentinel-must-block-before-model',
      prompt: TOOL_MARKER_PROMPT,
      expectedAbsentMarker: TOOL_MARKER,
    };
  }

  return {
    suffix: 'block',
    sentinelOutput,
    oracle: 'final-response-must-contain-marker',
    expectedResponseMarker: RESPONSE_CONSUMED_MARKER,
  };
}

/** Codex probe contract consumed by the scenario generator. */
export const codexProbeContract: ClientProbeContract = {
  clientId: 'codex',
  definition: clientDefinition,

  scenarioForEffect(eventName, effect) {
    if (effect === 'context.append') {
      // `SubagentStart` appends to a context the parent never sees, so its
      // scenario has to create a subagent and route the subagent's own words
      // back out; the default marker-only prompt would leave the event
      // unreached and the oracle unprovable.
      const isSubagentStart = eventName === CODEX_HOOK_SUBAGENT_START;
      return contextAppendScenario(
        sentinel(eventName, [
          { kind: 'context.append', value: isSubagentStart ? SUBAGENT_CONTEXT_VALUE : CONTEXT_VALUE },
        ]),
        {
          suffix: 'context-append',
          ...(isSubagentStart && {
            description: 'Attempts to seed a spawned subagent with hook-appended context it must repeat back.',
            prompt: SUBAGENT_RELAY_PROMPT,
          }),
        },
      );
    }

    if (effect === CODEX_HOOK_RESPONSE_CAPABILITIES.block) return blockScenario(eventName);

    if (effect === CODEX_HOOK_RESPONSE_CAPABILITIES.permissionDeny) {
      return {
        suffix: 'permission-deny',
        sentinelOutput: sentinel(eventName, [createCodexPreToolUseDenyEffect(DENY_REASON)]),
        oracle: 'sentinel-must-block-tool',
        expectedAbsentMarker: TOOL_MARKER,
      };
    }

    if (effect === CODEX_HOOK_RESPONSE_CAPABILITIES.inputUpdate) {
      return {
        suffix: 'input-update',
        sentinelOutput: sentinel(eventName, [
          createCodexPreToolUseUpdateEffect({ command: `touch ${REWRITTEN_MARKER}` }),
        ]),
        oracle: 'sentinel-must-rewrite-tool',
        prompt: REWRITE_PROMPT,
        expectedPresentMarker: REWRITTEN_MARKER,
        expectedAbsentMarker: ORIGINAL_MARKER,
      };
    }

    throw new Error(`No Codex probe shape for effect '${effect}' on '${eventName}'`);
  },

  extraEffectScenarios(eventName, effect) {
    if (effect === 'context.append' && eventName === CODEX_HOOK_POST_TOOL_USE)
      return postToolUseExtraContextScenarios();
    return [];
  },

  observationScenario(eventName) {
    // Both shapes below reach their event by construction — one spawns the
    // subagent, the other lowers the threshold the turn has to cross — so the
    // capture is the claim. `unobserved` would also pass a recapture in which
    // the hook never fired and the fixture published an empty event list.
    if (eventName === CODEX_HOOK_SUBAGENT_STOP) {
      return {
        suffix: 'observation',
        description: 'Spawns one subagent so the completion event is reached deterministically.',
        prompt: SUBAGENT_SPAWN_PROMPT,
        oracle: 'capture-only',
      };
    }

    if (eventName === CODEX_HOOK_PRE_COMPACT || eventName === CODEX_HOOK_POST_COMPACT) {
      return {
        suffix: 'observation',
        description: 'Forces automatic compaction within one turn by lowering the auto-compaction token limit.',
        prompt: COMPACTION_PROMPT,
        cliArgs: AUTO_COMPACT_ARGS,
        oracle: 'capture-only',
      };
    }

    return undefined;
  },
};

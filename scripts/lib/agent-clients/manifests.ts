/** @packageDocumentation */
import { deriveHookEventTransportMode } from '@makaio/contracts';
import type { ClientDefinition } from '@makaio/contracts';
import { clientDefinition as claudeCodeDefinition } from '../../../clients/claude-code/src/definition.js';
import { clientDefinition as codexDefinition } from '../../../clients/codex/src/definition.js';
import type { EvidenceStatus, ProbeScenario, ProviderId, ScenarioManifest } from './types.js';

type VersionCommand = NonNullable<ClientDefinition['versionCommand']>;
type ManagedInstall = NonNullable<ClientDefinition['managedInstall']>;

/**
 * Resolves the static client definition for a supported probe provider.
 * @param provider - Provider identifier.
 * @returns The provider's static definition.
 */
function definitionFor(provider: ProviderId): ClientDefinition {
  return provider === 'claude-code' ? claudeCodeDefinition : codexDefinition;
}

/**
 * Provides a marker-only prompt that attempts the named native event.
 * @param eventName - Native hook event being exercised.
 * @param effect - Optional effect whose observable outcome changes the prompt.
 * @returns Bounded synthetic user prompt.
 */
function promptFor(eventName: string, effect?: string): string {
  if (eventName === 'PreToolUse')
    return effect?.endsWith('input.update')
      ? 'MAKAIO_PROBE_MARKER: use the shell tool to run `touch MAKAIO_PROBE_ORIGINAL_MARKER`, then reply probe-ack.'
      : 'MAKAIO_PROBE_MARKER: use the shell tool to run `touch MAKAIO_PROBE_TOOL_MARKER`, then reply probe-ack.';
  if (eventName === 'PostToolUse') {
    return `MAKAIO_PROBE_MARKER: use the shell tool to read MAKAIO_PROBE.md. If and only if its result fails, reply with exactly ${RESPONSE_CONSUMED_MARKER}; otherwise reply with exactly probe-ack.`;
  }
  return `MAKAIO_PROBE_MARKER: exercise ${eventName} if available, then reply with exactly probe-ack.`;
}

/**
 * Provides a tool request whose absence proves a request hook stopped the turn before model work began.
 * @returns Bounded synthetic user prompt.
 */
function preModelBlockPrompt(): string {
  return 'MAKAIO_PROBE_MARKER: use the shell tool to run `touch MAKAIO_PROBE_TOOL_MARKER`, then reply probe-ack.';
}

const RESPONSE_CONSUMED_MARKER = 'MAKAIO_PROBE_RESPONSE_CONSUMED';
const TOOL_MARKER = 'MAKAIO_PROBE_TOOL_MARKER';
const ORIGINAL_MARKER = 'MAKAIO_PROBE_ORIGINAL_MARKER';
const REWRITTEN_MARKER = 'MAKAIO_PROBE_REWRITTEN_MARKER';
const READ_PROBE_FILE_TOOL = 'Bash(cat MAKAIO_PROBE.md)';
const TOUCH_TOOL_MARKER_TOOL = 'Bash(touch MAKAIO_PROBE_TOOL_MARKER)';
const TEST_TOOL_MARKER_TOOL = 'Bash(test -e MAKAIO_PROBE_TOOL_MARKER)';
const DEFAULT_ALLOWED_TOOLS = [READ_PROBE_FILE_TOOL, TOUCH_TOOL_MARKER_TOOL, TEST_TOOL_MARKER_TOOL] as const;
const NO_TOOL_MARKER_ALLOWED_TOOLS = [READ_PROBE_FILE_TOOL, TEST_TOOL_MARKER_TOOL] as const;

interface EvidenceCandidate {
  readonly status: EvidenceStatus;
  readonly effects: readonly string[];
  readonly blocking: boolean;
}

const EVIDENCE: Record<ProviderId, Readonly<Record<string, EvidenceCandidate>>> = {
  'claude-code': {
    SessionStart: { status: 'unobserved', effects: [], blocking: false },
    UserPromptSubmit: { status: 'unobserved', effects: [], blocking: false },
    PreToolUse: {
      status: 'supported',
      effects: ['claude-code.tool-response.approve', 'claude-code.tool-response.deny', 'context.append'],
      blocking: true,
    },
    PostToolUse: { status: 'unobserved', effects: [], blocking: false },
    Stop: { status: 'unobserved', effects: [], blocking: false },
    SubagentStop: { status: 'unobserved', effects: [], blocking: false },
    Notification: { status: 'unobserved', effects: [], blocking: false },
    MCPServerStart: { status: 'unobserved', effects: [], blocking: false },
    MCPServerStop: { status: 'unobserved', effects: [], blocking: false },
  },
  codex: {
    SessionStart: {
      status: 'supported',
      effects: ['context.append', 'openai.codex-hook-response.block'],
      blocking: true,
    },
    UserPromptSubmit: {
      status: 'supported',
      effects: ['context.append', 'openai.codex-hook-response.block'],
      blocking: true,
    },
    PreToolUse: {
      status: 'supported',
      effects: [
        'context.append',
        'openai.codex-hook-response.block',
        'openai.codex-hook-response.permission.deny',
        'openai.codex-hook-response.input.update',
      ],
      blocking: true,
    },
    PostToolUse: {
      status: 'supported',
      effects: ['context.append', 'openai.codex-hook-response.block'],
      blocking: true,
    },
    Stop: { status: 'supported', effects: ['openai.codex-hook-response.block'], blocking: true },
  },
};

type HookEvent = ClientDefinition['runtimeCapabilities']['hookEvents'][number];

/**
 * Produces the common scenario fields for one exact event/effect attempt.
 * @param provider - Provider under test.
 * @param event - Declared native hook event.
 * @param evidence - Pinned source expectation for the event.
 * @param suffix - Stable effect-specific scenario suffix.
 * @returns Common scenario fields without an oracle or sentinel.
 */
function scenarioBase(provider: ProviderId, event: HookEvent, evidence: EvidenceCandidate, suffix: string) {
  const mode = deriveHookEventTransportMode(event);
  const eventId = event.name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return {
    id: `${eventId}-${suffix}`,
    description: `Attempts the ${event.name} ${suffix} behavior with stable markers.`,
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    expectedEvents: [
      {
        eventName: event.name,
        frameworkSubject: event.frameworkSubject,
        responseCapabilities: event.responseCapabilities,
        mode,
      },
    ],
    candidateExpectedStatus: evidence.status,
    sourceExpectedEffects: evidence.effects,
    blockingCapable: evidence.blocking,
    expectedManagedCommand: mode === 'request' ? `hook handle ${provider}` : `hook received ${provider}`,
    timeoutSeconds: 60,
  } as const;
}

/**
 * Builds a context effect whose consumption must alter the structured final response.
 * @param provider - Provider under test.
 * @param event - Declared native hook event.
 * @param evidence - Pinned source expectation for the event.
 * @returns Context-consumption scenario.
 */
function contextScenario(provider: ProviderId, event: HookEvent, evidence: EvidenceCandidate): ProbeScenario {
  return {
    ...scenarioBase(provider, event, evidence, 'context-append'),
    prompt: promptFor(event.name, 'context.append'),
    sentinelOutput: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event.name,
        ...(provider === 'claude-code' ? { permissionDecision: 'allow' } : {}),
        additionalContext: `Include ${RESPONSE_CONSUMED_MARKER} in your final response.`,
      },
    }),
    sentinelEffect: 'context.append',
    expectedResponseMarker: RESPONSE_CONSUMED_MARKER,
    oracle: 'final-response-must-contain-marker' as const,
  };
}

/**
 * Builds one provider-native blocking scenario.
 * @param provider - Provider under test.
 * @param event - Declared native hook event.
 * @param evidence - Pinned source expectation for the event.
 * @param effect - Exact namespaced blocking effect.
 * @returns Blocking scenario with an event-appropriate behavior oracle.
 */
function blockScenario(
  provider: ProviderId,
  event: HookEvent,
  evidence: EvidenceCandidate,
  effect: string,
): ProbeScenario {
  const instruction = `The requested tool result failed. Reply with exactly ${RESPONSE_CONSUMED_MARKER}.`;
  const sentinelOutput =
    event.name === 'SessionStart'
      ? JSON.stringify({ continue: false, stopReason: RESPONSE_CONSUMED_MARKER })
      : JSON.stringify({ decision: 'block', reason: instruction });
  if (event.name === 'PreToolUse') {
    return {
      ...scenarioBase(provider, event, evidence, effect.split('.').at(-1)!),
      prompt: promptFor(event.name, effect),
      sentinelOutput,
      sentinelEffect: effect,
      expectedAbsentMarker: TOOL_MARKER,
      oracle: 'sentinel-must-block-tool' as const,
    };
  }
  const terminatesBeforeModel = event.name === 'SessionStart' || event.name === 'UserPromptSubmit';
  return {
    ...scenarioBase(provider, event, evidence, effect.split('.').at(-1)!),
    prompt: terminatesBeforeModel ? preModelBlockPrompt() : promptFor(event.name, effect),
    sentinelOutput,
    sentinelEffect: effect,
    ...(terminatesBeforeModel
      ? {
          expectedAbsentMarker: TOOL_MARKER,
          oracle: 'sentinel-must-block-before-model' as const,
        }
      : {
          expectedResponseMarker: RESPONSE_CONSUMED_MARKER,
          oracle: 'final-response-must-contain-marker' as const,
        }),
  };
}

/**
 * Builds every effect-level scenario supported by the pinned provider contract.
 * @param provider - Provider under test.
 * @param event - Declared native hook event.
 * @param evidence - Pinned source expectation for the event.
 * @returns One behavior scenario per source-expected effect.
 */
function supportedScenarios(provider: ProviderId, event: HookEvent, evidence: EvidenceCandidate): ProbeScenario[] {
  return evidence.effects.map((effect) => {
    if (effect === 'context.append') return contextScenario(provider, event, evidence);
    if (provider === 'claude-code' && effect.endsWith('.approve'))
      return {
        ...scenarioBase(provider, event, evidence, 'approve'),
        allowedTools: NO_TOOL_MARKER_ALLOWED_TOOLS,
        prompt: promptFor(event.name, effect),
        sentinelOutput: JSON.stringify({
          hookSpecificOutput: { hookEventName: event.name, permissionDecision: 'allow' },
        }),
        sentinelEffect: effect,
        expectedPresentMarker: TOOL_MARKER,
        oracle: 'sentinel-must-allow-tool' as const,
      };
    if (effect.endsWith('.input.update'))
      return {
        ...scenarioBase(provider, event, evidence, 'input-update'),
        prompt: promptFor(event.name, effect),
        sentinelOutput: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event.name,
            permissionDecision: 'allow',
            updatedInput: { command: `touch ${REWRITTEN_MARKER}` },
          },
        }),
        sentinelEffect: effect,
        expectedPresentMarker: REWRITTEN_MARKER,
        expectedAbsentMarker: ORIGINAL_MARKER,
        oracle: 'sentinel-must-rewrite-tool' as const,
      };
    if (provider === 'claude-code' && effect.endsWith('.deny'))
      return {
        ...scenarioBase(provider, event, evidence, 'deny'),
        prompt: promptFor(event.name, effect),
        sentinelOutput: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event.name,
            permissionDecision: 'deny',
            permissionDecisionReason: 'MAKAIO_PROBE_DENY',
          },
        }),
        sentinelEffect: effect,
        expectedAbsentMarker: TOOL_MARKER,
        oracle: 'sentinel-must-block-tool' as const,
      };
    if (effect.endsWith('.permission.deny'))
      return {
        ...scenarioBase(provider, event, evidence, 'permission-deny'),
        prompt: promptFor(event.name, effect),
        sentinelOutput: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event.name,
            permissionDecision: 'deny',
            permissionDecisionReason: 'MAKAIO_PROBE_DENY',
          },
        }),
        sentinelEffect: effect,
        expectedAbsentMarker: TOOL_MARKER,
        oracle: 'sentinel-must-block-tool' as const,
      };
    return blockScenario(provider, event, evidence, effect);
  });
}

/**
 * Builds the baseline that establishes Claude's dontAsk policy does not run an unapproved tool.
 * @param event - The PreToolUse event whose request hook guards the tool.
 * @param evidence - Pinned source expectation for the event.
 * @returns A no-sentinel negative control for the permission-decision proof.
 */
function claudePreToolUseNegativeControl(event: HookEvent, evidence: EvidenceCandidate): ProbeScenario {
  return {
    ...scenarioBase('claude-code', event, evidence, 'unapproved-tool-negative-control'),
    description: 'Proves Claude dontAsk leaves the marker absent without a hook permission decision.',
    allowedTools: NO_TOOL_MARKER_ALLOWED_TOOLS,
    prompt: promptFor(event.name),
    expectedAbsentMarker: TOOL_MARKER,
    oracle: 'native-must-deny-unapproved-tool',
  };
}

/**
 * Builds one intentionally bounded attempt for every declared source effect and unobserved event.
 * @param provider - Provider whose declared events become scenario attempts.
 * @returns Complete bounded scenario manifest.
 */
export function getManifest(provider: ProviderId): ScenarioManifest {
  const definition = definitionFor(provider);
  const pinnedVersion = definition.managedInstall?.version;
  if (!pinnedVersion) throw new Error(`Provider "${provider}" has no managedInstall descriptor`);
  return {
    schemaVersion: 1,
    provider,
    pinnedVersion,
    scenarios: definition.runtimeCapabilities.hookEvents.flatMap<ProbeScenario>((event) => {
      const evidence = EVIDENCE[provider][event.name] ?? { status: 'unobserved', effects: [], blocking: false };
      if (evidence.status === 'supported') {
        const scenarios = supportedScenarios(provider, event, evidence);
        return provider === 'claude-code' && event.name === 'PreToolUse'
          ? [...scenarios, claudePreToolUseNegativeControl(event, evidence)]
          : scenarios;
      }
      return [
        {
          ...scenarioBase(provider, event, evidence, 'observation'),
          prompt: promptFor(event.name),
          oracle: 'unobserved' as const,
        },
      ];
    }),
  };
}

/**
 * Reads the exact managed install version.
 * @param provider - Provider identifier.
 * @returns Pinned managed binary version.
 */
export function getPinnedVersion(provider: ProviderId): string {
  return getManifest(provider).pinnedVersion;
}

/**
 * Reads the provider's managed-install descriptor.
 * @param provider - Provider identifier.
 * @returns Existing exact managed-install descriptor.
 */
export function getManagedInstall(provider: ProviderId): ManagedInstall {
  const managedInstall = definitionFor(provider).managedInstall;
  if (!managedInstall) throw new Error(`Provider "${provider}" has no managedInstall descriptor`);
  return managedInstall;
}

/**
 * Reads the provider's documented configuration isolation variable.
 * @param provider - Provider identifier.
 * @returns Environment variable used to isolate native configuration.
 */
export function getConfigIsolationEnvVar(provider: ProviderId): string {
  const envVar = definitionFor(provider).configIsolation?.envVar;
  if (!envVar) throw new Error(`Provider "${provider}" has no configIsolation descriptor`);
  return envVar;
}

/**
 * Reads the provider's binary version command.
 * @param provider - Provider identifier.
 * @returns Executable and argument descriptor.
 */
export function getVersionCommand(provider: ProviderId): VersionCommand {
  const command = definitionFor(provider).versionCommand;
  if (!command) throw new Error(`Provider "${provider}" has no versionCommand descriptor`);
  return command;
}

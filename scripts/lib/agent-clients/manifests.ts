/** @packageDocumentation */
import { deriveHookEventTransportMode } from '@makaio/contracts';
import type { ClientDefinition } from '@makaio/contracts';
import { probeContractFor } from './clients/index.js';
import {
  DEFAULT_ALLOWED_TOOLS,
  RESPONSE_CONSUMED_MARKER,
  TOOL_MARKER_PROMPT,
  type ProbeEffectScenario,
} from './probe-contract.js';
import type { EvidenceStatus, ProbeScenario, ProviderId, ScenarioManifest } from './types.js';

type VersionCommand = NonNullable<ClientDefinition['versionCommand']>;
type ManagedInstall = NonNullable<ClientDefinition['managedInstall']>;
type HookEvent = ClientDefinition['runtimeCapabilities']['hookEvents'][number];

/**
 * Resolves the static client definition for a supported probe provider.
 * @param provider - Provider identifier.
 * @returns The provider's static definition.
 */
function definitionFor(provider: ProviderId): ClientDefinition {
  return probeContractFor(provider).definition;
}

/**
 * Provides a marker-only prompt that attempts the named native event.
 *
 * Scenarios whose oracle needs a different action override this through the
 * client-owned probe contract.
 * @param eventName - Native hook event being exercised.
 * @returns Bounded synthetic user prompt.
 */
function promptFor(eventName: string): string {
  if (eventName === 'PreToolUse') return TOOL_MARKER_PROMPT;
  if (eventName === 'PostToolUse') {
    return `MAKAIO_PROBE_MARKER: use the shell tool to read MAKAIO_PROBE.md. If and only if its result fails, reply with exactly ${RESPONSE_CONSUMED_MARKER}; otherwise reply with exactly probe-ack.`;
  }
  return `MAKAIO_PROBE_MARKER: exercise ${eventName} if available, then reply with exactly probe-ack.`;
}

/** Source-backed expectation for one declared event. */
interface EvidenceCandidate {
  readonly status: EvidenceStatus;
  readonly effects: readonly string[];
  readonly blocking: boolean;
}

/**
 * Central source-evidence table.
 *
 * Deliberately **not** client-owned: a client contributes how a claimed effect
 * is rendered and observed, never which effects it may claim. Widening an entry
 * without a matching captured probe fails the committed fixture suite.
 */
const EVIDENCE: Record<ProviderId, Readonly<Record<string, EvidenceCandidate>>> = {
  'claude-code': {
    SessionStart: { status: 'supported', effects: ['context.append'], blocking: false },
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

/**
 * Merges harness-owned scenario scaffolding with one client-owned probe shape.
 * @param provider - Provider under test.
 * @param event - Declared native hook event.
 * @param evidence - Central source expectation for the event.
 * @param seed - Client-owned native shape and observable oracle.
 * @param sentinelEffect - Declared effect this scenario attempts, when it attempts one.
 * @returns Complete bounded probe scenario.
 */
function buildScenario(
  provider: ProviderId,
  event: HookEvent,
  evidence: EvidenceCandidate,
  seed: ProbeEffectScenario,
  sentinelEffect?: string,
): ProbeScenario {
  const mode = deriveHookEventTransportMode(event);
  const eventId = event.name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return {
    id: `${eventId}-${seed.suffix}`,
    description: seed.description ?? `Attempts the ${event.name} ${seed.suffix} behavior with stable markers.`,
    prompt: seed.prompt ?? promptFor(event.name),
    allowedTools: seed.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
    expectedEvents: [
      {
        eventName: event.name,
        frameworkSubject: event.frameworkSubject,
        responseCapabilities: event.responseCapabilities,
        mode,
      },
    ],
    ...(seed.sentinelOutput !== undefined && { sentinelOutput: seed.sentinelOutput }),
    candidateExpectedStatus: evidence.status,
    sourceExpectedEffects: evidence.effects,
    ...(sentinelEffect !== undefined && { sentinelEffect }),
    ...(seed.expectedResponseMarker !== undefined && { expectedResponseMarker: seed.expectedResponseMarker }),
    ...(seed.expectedPresentMarker !== undefined && { expectedPresentMarker: seed.expectedPresentMarker }),
    ...(seed.expectedAbsentMarker !== undefined && { expectedAbsentMarker: seed.expectedAbsentMarker }),
    blockingCapable: evidence.blocking,
    expectedManagedCommand: mode === 'request' ? `hook handle ${provider}` : `hook received ${provider}`,
    oracle: seed.oracle,
    timeoutSeconds: 60,
  };
}

/**
 * Builds one intentionally bounded attempt for every declared source effect and unobserved event.
 * @param provider - Provider whose declared events become scenario attempts.
 * @returns Complete bounded scenario manifest.
 */
export function getManifest(provider: ProviderId): ScenarioManifest {
  const contract = probeContractFor(provider);
  const pinnedVersion = contract.definition.managedInstall?.version;
  if (!pinnedVersion) throw new Error(`Provider "${provider}" has no managedInstall descriptor`);
  return {
    schemaVersion: 1,
    provider,
    pinnedVersion,
    scenarios: contract.definition.runtimeCapabilities.hookEvents.flatMap<ProbeScenario>((event) => {
      const evidence = EVIDENCE[provider][event.name] ?? { status: 'unobserved', effects: [], blocking: false };
      if (evidence.status !== 'supported') {
        return [buildScenario(provider, event, evidence, { suffix: 'observation', oracle: 'unobserved' })];
      }
      return [
        ...evidence.effects.map((effect) =>
          buildScenario(provider, event, evidence, contract.scenarioForEffect(event.name, effect), effect),
        ),
        ...(contract.baselineScenarios?.(event.name) ?? []).map((seed) =>
          buildScenario(provider, event, evidence, seed),
        ),
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

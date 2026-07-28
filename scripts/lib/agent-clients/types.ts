/** @packageDocumentation */

/** Supported provider identifiers for the probe harness. */
export type ProviderId = 'claude-code' | 'codex';

/** Credentials intentionally admitted to a probe child process. */
export type CredentialMode = 'api-key' | 'oauth-token' | 'access-token' | 'native-login';

/** Evidence oracle evaluated after a scenario finishes. */
export type ScenarioOracle =
  | 'capture-only'
  | 'final-response-must-contain-marker'
  | 'native-must-deny-unapproved-tool'
  | 'sentinel-must-block-before-model'
  | 'sentinel-must-allow-tool'
  | 'sentinel-must-block-tool'
  | 'sentinel-must-rewrite-tool'
  | 'unobserved';
/** Evidence state recorded for each attempt. */
export type EvidenceStatus = 'supported' | 'observer-only' | 'unobserved';

/** A single native hook event exercised by a scenario. */
export interface CandidateHookEventShape {
  /** Native event name. */
  readonly eventName: string;
  /** Framework subject, when the event has one. */
  readonly frameworkSubject?: string;
  /** Capabilities declared by the client definition. */
  readonly responseCapabilities: readonly string[];
  /** Transport mode derived from response capabilities. */
  readonly mode: 'event' | 'request';
}

/** A bounded native-client scenario. */
export interface ProbeScenario {
  /** Stable fixture name. */
  readonly id: string;
  /** What native behavior the scenario attempts to induce. */
  readonly description: string;
  /** Marker-only model instruction. */
  readonly prompt: string;
  /** Provider-native tools pre-approved for this scenario. */
  readonly allowedTools: readonly string[];
  /** Exactly one declared hook event attempted by this scenario. */
  readonly expectedEvents: readonly CandidateHookEventShape[];
  /** Native response emitted by the capture shim, when the event is request-capable. */
  readonly sentinelOutput?: string;
  /** Source-backed expectation before this live attempt. */
  readonly candidateExpectedStatus: EvidenceStatus;
  /** Effects expected from pinned source evidence; live observation is recorded separately. */
  readonly sourceExpectedEffects: readonly string[];
  /** Single effect exercised by the scenario's sentinel response. */
  readonly sentinelEffect?: string;
  /** Marker that must occur in the provider's final response for a response-consumption oracle. */
  readonly expectedResponseMarker?: string;
  /** Workspace marker expected after a tool-execution oracle. */
  readonly expectedPresentMarker?: string;
  /** Workspace marker forbidden after a tool-execution oracle. */
  readonly expectedAbsentMarker?: string;
  /** Whether the provider can synchronously prevent the native action. */
  readonly blockingCapable: boolean;
  /** Managed bridge command expected for the event. */
  readonly expectedManagedCommand: string;
  /** Observable native outcome required for a pass. */
  readonly oracle: ScenarioOracle;
  /** Maximum scenario wall-clock time. */
  readonly timeoutSeconds: number;
}

/** Provider-specific scenario collection. */
export interface ScenarioManifest {
  /** Fixture wire-format version. */
  readonly schemaVersion: 1;
  /** Provider under test. */
  readonly provider: ProviderId;
  /** Exact managed CLI version. */
  readonly pinnedVersion: string;
  /** Effect-level attempts covering every currently declared hook event. */
  readonly scenarios: readonly ProbeScenario[];
}

/** User-facing probe options. */
export interface ProbeOptions {
  readonly provider: ProviderId;
  readonly credentialMode: CredentialMode;
  readonly updateFixtures: boolean;
  readonly maxScenarios: number;
  readonly maxWallClockSeconds: number;
}

/** Environment variables passed through without interpretation. */
export const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'USER',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SYSTEMROOT',
  'COMSPEC',
  'WINDIR',
] as const;

/** Provider credential variable to mode mapping. */
export const PROVIDER_CREDENTIAL_VARS: Record<ProviderId, Record<string, CredentialMode>> = {
  'claude-code': { ANTHROPIC_API_KEY: 'api-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
  codex: { CODEX_ACCESS_TOKEN: 'access-token' },
};

/**
 * Isolation variables a native-login lease must publish per provider.
 *
 * This is a required minimum, not an admit-list. The client-owned session
 * config lease is the authority on the environment its child needs, and the
 * probe delivers that environment as published; the harness only asserts that
 * the lease actually isolated itself before a networked request is made.
 */
export const PROVIDER_REQUIRED_NATIVE_AUTH_ENV_VARS: Record<ProviderId, readonly string[]> = {
  'claude-code': ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
};

/** Placeholder written in normalized evidence for prohibited values. */
export const REDACTED_PLACEHOLDER = '[redacted]';
/** Key fragments prohibited from persisted evidence. */
export const REDACTION_KEY_PATTERNS = [
  'key',
  'token',
  'secret',
  'password',
  'credential',
  'authorization',
  'auth',
  'cookie',
  'session',
  'transcript',
  'prompt',
  'input',
] as const;
/** Values that are not stable portable evidence. */
export const REDACTION_VALUE_PATTERNS = [
  /\/(?:Users|home|tmp|var|etc)\/.+/g,
  /[A-Z]:\\(?:Users|Windows|Temp)\\.+/g,
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.Z\d+-]*/g,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
] as const;

/** Normalized capture metadata; no raw native document is persisted. */
export interface RecordedHookEvent {
  readonly eventName: string;
  readonly frameworkSubject?: string;
  readonly responseCapabilities: readonly string[];
  readonly mode: 'event' | 'request';
  /** Source-backed candidate status. */
  readonly candidateExpectedStatus: EvidenceStatus;
  /** Status actually observed by this run. */
  readonly observedStatus: EvidenceStatus;
  /** Effects expected from pinned source evidence. */
  readonly sourceExpectedEffects: readonly string[];
  /** Effects whose native consumption this scenario directly observed. */
  readonly observedEffects: readonly string[];
  readonly blockingCapable: boolean;
  readonly managedCommand: string;
  /** Sorted native top-level keys only. */
  readonly payloadKeys: readonly string[];
  /** The shim wrote a response; native consumption is established only by the oracle. */
  readonly sentinelInjected: boolean;
}

/** Committed per-scenario normalized evidence. */
export interface ScenarioFixture {
  readonly schemaVersion: 3;
  readonly provider: ProviderId;
  readonly cliVersion: string;
  readonly scenarioId: string;
  readonly events: readonly RecordedHookEvent[];
  readonly oracle: ScenarioOracle;
  readonly oraclePassed: boolean;
  readonly exitCode: number | null;
}

/** One source-preserving entry in a provider hook-contract manifest. */
export interface HookContractManifestEvent {
  /** Source-backed expectation before a paid native probe. */
  readonly candidateEvidenceStatus: EvidenceStatus;
  /** Aggregate outcome of the last complete paid native probe. */
  readonly observedEvidenceStatus: EvidenceStatus | null;
  /** Whether the native client invoked this event's configured hook. */
  readonly hookFired: boolean | null;
  /** Additional source-owned fields retained verbatim when live evidence is published. */
  readonly [field: string]: unknown;
}

/** Provider-owned source and live hook-contract evidence document. */
export interface HookContractManifest {
  /** Stable manifest schema version. */
  readonly version: string;
  /** Provider client identifier. */
  readonly clientId: ProviderId;
  /** Exact CLI version represented by the source contract. */
  readonly cliVersion: string;
  /** Live probe transaction state. */
  readonly liveProbe: {
    readonly status: 'pending' | 'captured';
    readonly capturedAt: string | null;
  };
  /** Source contract entries keyed by native event name. */
  readonly events: Readonly<Record<string, HookContractManifestEvent>>;
  /** Other source-owned manifest fields retained verbatim. */
  readonly [field: string]: unknown;
}

/** Raw capture written only inside the disposable workspace. */
export interface CapturedHookInvocation {
  readonly eventName: string;
  readonly input: unknown;
  readonly sentinelInjected: boolean;
}

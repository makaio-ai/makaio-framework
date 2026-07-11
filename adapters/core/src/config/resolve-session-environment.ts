import type { IMakaioBus } from '@makaio/bus-core';
import type { ClientExecutionContext } from '@makaio/contracts/client';
import { resolveClientBinary } from '@makaio/subsystem-client';
import { cleanEnvForAdapter } from '../utils/cleanEnvForAdapter.js';

/**
 * Input options for {@link resolveSessionEnvironment}.
 */
export interface SessionEnvironmentOptions {
  /** Runtime bus that owns client binary resolution. */
  globalBus?: IMakaioBus;
  /**
   * Stable client identifier passed to `resolveClientBinary`
   * (e.g. `'claude-code'`, `'qwen'`, `'github-copilot'`). Omit for
   * connector-only SDK adapters with no managed binary.
   */
  clientId?: string;
  /**
   * Base environment variables explicitly supplied by the host. This function
   * never falls back to ambient `process.env`.
   */
  baseEnv?: Record<string, string>;
  /** Non-auth session environment composed over the base environment. */
  sessionEnv?: Readonly<Record<string, string>>;
  /** Pre-resolved non-auth binary environment supplied by an external host. */
  binaryEnv?: Readonly<Record<string, string>>;
  /** Complete normalized auth source/sink set removed before selected delivery. */
  scrubEnvVars?: readonly string[];
  /** Environment returned by the connector-owned client config lease. */
  leaseEnv?: Readonly<Record<string, string>>;
  /** Selected normalized process-environment delivery, applied last. */
  selectedAuthEnv?: Readonly<Record<string, string>>;
}

/**
 * Fully resolved session environment returned by {@link resolveSessionEnvironment}.
 *
 * Binary resolution is returned alongside process-private and shared-context
 * environment views derived from one authoritative merge.
 */
export interface SessionEnvironmentResult {
  /**
   * Execution context for the resolved client binary, or `undefined` when
   * no `client.resolveBinary` handler is registered (framework-only boot).
   */
  resolvedBinary: ClientExecutionContext | undefined;
  /**
   * Process-private connector environment:
   * `{ ...scrub({ ...baseEnv, ...sessionEnv, ...resolvedBinaryEnv, ...binaryEnv, ...leaseEnv }), ...selectedAuthEnv }`.
   *
   * This view may contain the selected plaintext process delivery and must not
   * be copied into bus payloads, logs, or other shared execution contexts.
   */
  connectorEnv: Record<string, string>;
  /**
   * Shared execution-context environment produced from host/session/binary
   * inputs after the full auth scrub. Connector-private lease variables are
   * excluded even when another source supplied the same variable name.
   *
   * Connector-owned bus and tool payloads use this view so explicitly shareable
   * variables remain available without exporting process authentication or
   * config-directory capabilities.
   */
  contextEnv: Readonly<Record<string, string>>;
}

/**
 * Resolve the selected client binary and compose the two environment views.
 *
 * Credential refs are deliberately absent from this contract. The normalized
 * adapter-auth runtime resolves them once and passes only the selected process
 * delivery. Lease keys are connector-private capabilities: the same names are
 * removed from the shared view regardless of which environment source supplied
 * them, while the connector view still receives the scrubbed lease values.
 * @param options - Session environment resolution options
 * @returns Binary execution context and merged connector/context environments
 */
export async function resolveSessionEnvironment(options: SessionEnvironmentOptions): Promise<SessionEnvironmentResult> {
  const {
    globalBus,
    clientId,
    baseEnv = {},
    sessionEnv = {},
    binaryEnv = {},
    scrubEnvVars = [],
    leaseEnv = {},
    selectedAuthEnv = {},
  } = options;

  let resolvedBinary: ClientExecutionContext | undefined;
  if (clientId !== undefined) {
    if (globalBus === undefined) {
      throw new Error('Client binary resolution requires the adapter runtime global bus.');
    }
    resolvedBinary = await resolveClientBinary(globalBus, clientId);
  }
  const sharedEnv: Record<string, string> = {
    ...baseEnv,
    ...sessionEnv,
    ...(resolvedBinary?.env ?? {}),
    ...binaryEnv,
  };
  const connectorEnvBeforeScrub: Record<string, string> = {
    ...sharedEnv,
    ...leaseEnv,
  };
  const connectorPrivateEnvVars = Object.keys(leaseEnv);
  const contextEnv: Record<string, string> = cleanEnvForAdapter(sharedEnv, {
    omitEnvVars: [...new Set([...scrubEnvVars, ...connectorPrivateEnvVars])],
  });
  const scrubbedConnectorEnv = cleanEnvForAdapter(connectorEnvBeforeScrub, { omitEnvVars: scrubEnvVars });
  const connectorEnv: Record<string, string> = {
    ...scrubbedConnectorEnv,
    ...selectedAuthEnv,
  };
  Object.freeze(contextEnv);
  Object.freeze(connectorEnv);

  return { resolvedBinary, connectorEnv, contextEnv };
}

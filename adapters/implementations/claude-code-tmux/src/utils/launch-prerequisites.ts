import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';

/** Options for preparing a Claude Code tmux launch. */
export interface PrepareLaunchPrerequisitesOptions {
  /** Project directory whose Claude Code config is prepared. */
  projectDir: string;
  /** Spawn environment forwarded to MCP tool execution context. */
  baseEnv: Record<string, string>;
  /** Makaio session ID, when available. */
  sessionId: string | undefined;
  /** Agent ID fallback for session-scoped config isolation. */
  agentId: string;
  /** Optional client profile name used as session config source. */
  clientProfileName: string | undefined;
  /** Wire Claude Code hooks into the returned session config directory. */
  ensureHookWiring: (projectDir: string, configDir: string) => Promise<void>;
  /** Register the pinned MCP bridge session. */
  registerMcpSession: (projectDir: string, env: Record<string, string>) => Promise<void>;
  /** Fail if initialization was superseded while prerequisites awaited. */
  assertLifecycleCurrent: () => void;
}

/**
 * Prepare session config, hook wiring, and MCP registration before native spawn.
 * @param options - Launch prerequisite dependencies and callbacks.
 * @returns Merged spawn environment with session config env vars applied.
 */
export async function prepareLaunchPrerequisites(
  options: PrepareLaunchPrerequisitesOptions,
): Promise<Record<string, string>> {
  const sid = options.sessionId ?? options.agentId;
  const sc = await MakaioBus.requestOptional(ClientSubjects.sessionConfig.create, {
    clientId: 'claude-code',
    sessionId: sid,
    profileName: options.clientProfileName,
  });
  if (!sc.handled) {
    throw new Error(
      'Claude Code tmux requires session-scoped Claude Code config support: client.sessionConfig.create is unavailable',
    );
  }

  const mergedEnv = { ...options.baseEnv, ...sc.data.env };
  const prerequisites = await Promise.allSettled([
    options.ensureHookWiring(options.projectDir, sc.data.sessionDir),
    options.registerMcpSession(options.projectDir, mergedEnv),
  ]);
  const failedPrerequisite = prerequisites.find((result) => result.status === 'rejected');
  if (failedPrerequisite?.status === 'rejected') {
    throw failedPrerequisite.reason;
  }
  options.assertLifecycleCurrent();
  return mergedEnv;
}

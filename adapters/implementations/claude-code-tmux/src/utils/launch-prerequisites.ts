/** Options for preparing a Claude Code tmux launch. */
export interface PrepareLaunchPrerequisitesOptions {
  /** Project directory whose Claude Code config is prepared. */
  projectDir: string;
  /** Centrally finalized environment used only for the Claude child process. */
  baseEnv: Record<string, string>;
  /** Wire Claude Code hooks into the returned session config directory. */
  ensureHookWiring: (projectDir: string, configDir: string) => Promise<void>;
  /** Register the pinned MCP bridge session. */
  registerMcpSession: (projectDir: string) => Promise<void>;
  /** Fail if initialization was superseded while prerequisites awaited. */
  assertLifecycleCurrent: () => void;
}

/**
 * Prepare hook wiring and MCP registration against the central client lease.
 * @param options - Launch prerequisite dependencies and callbacks.
 * @returns A stable copy of the centrally prepared spawn environment.
 */
export async function prepareLaunchPrerequisites(
  options: PrepareLaunchPrerequisitesOptions,
): Promise<Record<string, string>> {
  const configDir = options.baseEnv['CLAUDE_CONFIG_DIR']?.trim();
  if (!configDir) {
    throw new Error('Claude Code tmux requires CLAUDE_CONFIG_DIR from the central client config lease.');
  }

  const spawnEnv = { ...options.baseEnv };
  const prerequisites = await Promise.allSettled([
    options.ensureHookWiring(options.projectDir, configDir),
    options.registerMcpSession(options.projectDir),
  ]);
  const failedPrerequisite = prerequisites.find((result) => result.status === 'rejected');
  if (failedPrerequisite?.status === 'rejected') {
    throw failedPrerequisite.reason;
  }
  options.assertLifecycleCurrent();
  return spawnEnv;
}

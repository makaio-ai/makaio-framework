/**
 * Credential resolution for the agent-client probe harness.
 *
 * Resolves explicit credentials or materializes a client-owned native-login
 * lease before any networked model request.
 * @packageDocumentation
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { clearClaudeCodeNativeCredentialsForSession } from '../../../clients/claude-code/src/runtime/native-credentials.js';
import { handleClaudeCodeSessionConfigSetup } from '../../../clients/claude-code/src/runtime/session-config-handler.js';
import { CodexSessionConfigHandler } from '../../../clients/codex/src/runtime/session-config-handler.js';
import type { CredentialMode, ProviderId } from './types.js';
import { PROVIDER_CREDENTIAL_VARS } from './types.js';

type SupportedNativePlatform = 'darwin' | 'linux' | 'win32';

/**
 * Resolve the host platform admitted by client session-config contracts.
 * @param platform - Node platform reported by the host process.
 */
function resolveSupportedNativePlatform(platform: NodeJS.Platform): SupportedNativePlatform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform;
  throw new Error('Native login is unsupported on this platform');
}

/**
 * Require the client-owned isolation environment needed by a native-login child.
 * @param provider - Client whose isolation environment is required.
 * @param env - Environment returned by the client-owned setup handler.
 */
function requireNativeLoginEnv(provider: ProviderId, env: Record<string, string> | undefined): Record<string, string> {
  const required =
    provider === 'claude-code' ? ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] : ['CODEX_HOME'];
  if (!env || required.some((name) => env[name] === undefined || env[name]!.length === 0))
    throw new Error(`Native login setup did not return isolated ${provider} environment`);
  return env;
}

/**
 * Result of credential resolution.
 */
export interface CredentialResolution {
  /** The resolved credential mode, if exactly one is active. */
  readonly mode?: CredentialMode;
  /** Error message if resolution failed. */
  readonly error?: string;
}

/** Isolated native-login material leased for the duration of one probe. */
export interface NativeLoginLease {
  /** Client-owned environment required to locate isolated authentication. */
  readonly env: Readonly<Record<string, string>>;
  /** Whether the client verified that native authentication was materialized. */
  readonly authMaterialized: boolean;
  /** Reconcile and remove client-owned isolated authentication before workspace cleanup. */
  teardown(): Promise<void>;
}

/** Injectable client-owned native-login setup used by tests and the probe entry point. */
export interface NativeLoginLeaseFactory {
  /** Prepare an isolated credential lease. */
  prepare(params: {
    readonly provider: ProviderId;
    readonly configDir: string;
    readonly projectDir: string;
    readonly env: NodeJS.ProcessEnv;
  }): Promise<NativeLoginLease>;
}

const nativeLoginLeaseFactory: NativeLoginLeaseFactory = {
  async prepare({ provider, configDir, projectDir, env }) {
    const platform = resolveSupportedNativePlatform(process.platform);
    if (provider === 'claude-code') {
      try {
        const setup = await handleClaudeCodeSessionConfigSetup({
          sessionDir: configDir,
          baseConfigDir: configDir,
          projectDir,
          platform,
          configInheritance: 'auth-only',
        });
        return {
          env: requireNativeLoginEnv(provider, setup.env),
          authMaterialized: setup.authMaterialized,
          teardown: async () => clearClaudeCodeNativeCredentialsForSession({ sessionDir: configDir, platform }),
        };
      } catch (error) {
        await clearClaudeCodeNativeCredentialsForSession({ sessionDir: configDir, platform }).catch(
          (cleanupError: unknown) => {
            throw new AggregateError([error, cleanupError], 'Native Claude login setup and cleanup both failed');
          },
        );
        throw error;
      }
    }

    const nativeConfigDir = path.resolve(env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
    const handler = new CodexSessionConfigHandler(undefined, nativeConfigDir);
    const setup = await handler.setup({
      sessionDir: configDir,
      baseConfigDir: configDir,
      projectDir,
      platform,
      configInheritance: 'auth-only',
    });
    return {
      env: requireNativeLoginEnv(provider, setup.env),
      authMaterialized: setup.authMaterialized,
      teardown: async () => {
        await handler.teardown({ sessionDir: configDir, platform });
      },
    };
  },
};

/**
 * Materializes a client-owned native login into an isolated probe config directory.
 * @param params - Provider, isolated paths, environment, and an optional test seam.
 * @returns A secret-free lease that must be torn down before deleting the workspace.
 */
export async function prepareNativeLoginLease(params: {
  readonly provider: ProviderId;
  readonly configDir: string;
  readonly projectDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly factory?: NativeLoginLeaseFactory;
}): Promise<NativeLoginLease> {
  const lease = await (params.factory ?? nativeLoginLeaseFactory).prepare({
    provider: params.provider,
    configDir: params.configDir,
    projectDir: params.projectDir,
    env: params.env ?? process.env,
  });
  if (!lease.authMaterialized) {
    await lease.teardown();
    throw new Error(`Native login was not materialized for provider "${params.provider}"`);
  }
  return lease;
}

/**
 * Resolves the credential mode for a provider from the environment.
 *
 * Exactly one explicit credential environment variable takes precedence. When
 * none are set, the probe uses a client-owned native-login lease instead.
 * @param params - Resolution parameters.
 * @param params.provider - The provider to resolve credentials for.
 * @param params.env - The environment to inspect (defaults to `process.env`).
 * @returns The resolution result with either a mode or an error.
 */
export function resolveCredentialMode(params: { provider: ProviderId; env?: NodeJS.ProcessEnv }): CredentialResolution {
  const { provider, env = process.env } = params;
  const credentialVars = PROVIDER_CREDENTIAL_VARS[provider];
  const active: Array<{ envVar: string; mode: CredentialMode }> = [];

  for (const [envVar, mode] of Object.entries(credentialVars)) {
    const value = env[envVar];
    if (value !== undefined && value.length > 0) {
      active.push({ envVar, mode });
    }
  }

  if (active.length === 0) {
    return { mode: 'native-login' };
  }

  if (active.length > 1) {
    const vars = active.map((a) => a.envVar).join(', ');
    return {
      error: `Ambiguous credentials for provider "${provider}": multiple variables set (${vars}). Set exactly one.`,
    };
  }

  return { mode: active[0]!.mode };
}

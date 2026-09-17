/**
 * Client definition for the OpenAI Codex CLI.
 *
 * Codex is a first-party agentic coding assistant binary (`codex`) that
 * Makaio harnesses via the codex-app-server adapter. Capability annotations
 * are derived from `codexCapabilityMap` in `@makaio/contracts` to keep
 * capability taxonomy in a single canonical location.
 * @packageDocumentation
 */

import { codexCapabilityMap, createClientDefinition } from '@makaio/contracts';

/** Namespaced Codex hook-response capabilities exposed to contributors. */
export const CODEX_HOOK_RESPONSE_CAPABILITIES = Object.freeze({
  block: 'openai.codex-hook-response.block',
  permissionDeny: 'openai.codex-hook-response.permission.deny',
  inputUpdate: 'openai.codex-hook-response.input.update',
} as const);

/**
 * Static client definition for `@makaio/client-codex`.
 *
 * Declares the two native tools the `codex` binary exposes (`bash` and
 * `patch`) and the recommended default approval policy for new harnesses
 * targeting this client.
 */
export const clientDefinition = createClientDefinition({
  id: 'codex',
  name: 'Codex',
  version: '0.1.0',
  description: 'OpenAI Codex CLI — an agentic coding assistant',
  binary: {
    name: 'codex',
    supportedVersions: '0.144.1',
  },
  managedInstall: {
    type: 'npm',
    package: '@openai/codex',
    version: '0.144.1',
  },
  versionCommand: {
    executable: {
      default: 'node_modules/.bin/codex',
      win32: 'node_modules/.bin/codex.cmd',
    },
    args: ['--version'],
  },
  configIsolation: { envVar: 'CODEX_HOME', defaultPath: '~/.codex' },
  nativeTools: [
    {
      name: 'bash',
      friendlyName: 'Terminal',
      description: 'Execute shell commands in the Codex sandbox',
      category: 'System',
      capabilities: (codexCapabilityMap.bash ?? []).map((tag) => ({ tag })),
    },
    {
      name: 'patch',
      friendlyName: 'Patch File',
      description: 'Apply unified diff patches to files',
      category: 'Files',
      capabilities: (codexCapabilityMap.patch ?? []).map((tag) => ({ tag })),
    },
  ],
  defaultApprovalPolicy: 'full-access',
  authMethods: [
    {
      id: 'native',
      mode: 'inferred',
      label: 'Native account',
    },
    {
      id: 'access-token',
      mode: 'explicit',
      label: 'Access token',
      fields: [
        {
          id: 'accessToken',
          label: 'Access token',
          required: true,
          secret: true,
          sourceHints: [{ kind: 'environment', variable: 'CODEX_ACCESS_TOKEN' }],
        },
      ],
    },
  ],
  defaultAuth: {
    providerDefinitionId: 'openai-codex',
    methodId: 'native',
  },
  runtimeCapabilities: {
    supportsHooks: true,
    supportsStatusline: false,
    supportsSupervisorLaunch: true,
    supportsManagedBinary: true,
    hookEvents: [
      {
        name: 'SessionStart',
        frameworkSubject: 'client.session.started',
        // `session.token` is NOT declared here: Codex passes no session id to
        // its MCP subprocesses, so no consumer can key `client.session.token.get`.
        // The composer sink and the catalog `supportedInteractions` entry remain
        // in place — declaring `session.token` here is the only change needed
        // once such a lookup key exists.
        responseCapabilities: ['context.append', CODEX_HOOK_RESPONSE_CAPABILITIES.block],
      },
      {
        name: 'UserPromptSubmit',
        // `frameworkSubject` is the primary mapping registered here.
        // The normalizer additionally derives `client.session.turn.started`
        // before emitting `client.session.userPrompt.submitted`, giving
        // observed sessions start-of-turn cadence without a separate hook.
        frameworkSubject: 'client.session.userPrompt.submitted',
        responseCapabilities: ['context.append', CODEX_HOOK_RESPONSE_CAPABILITIES.block],
      },
      {
        name: 'PreToolUse',
        frameworkSubject: 'client.session.tool.pre',
        responseCapabilities: [
          'context.append',
          CODEX_HOOK_RESPONSE_CAPABILITIES.block,
          CODEX_HOOK_RESPONSE_CAPABILITIES.permissionDeny,
          CODEX_HOOK_RESPONSE_CAPABILITIES.inputUpdate,
        ],
      },
      {
        name: 'PostToolUse',
        frameworkSubject: 'client.session.tool.post',
        responseCapabilities: ['context.append', CODEX_HOOK_RESPONSE_CAPABILITIES.block],
      },
      {
        name: 'Stop',
        frameworkSubject: 'client.session.turn.completed',
        responseCapabilities: [CODEX_HOOK_RESPONSE_CAPABILITIES.block],
      },
      {
        name: 'SubagentStart',
        frameworkSubject: 'client.session.subagent.started',
        // `context.append` lands in the *subagent's* context window, not the
        // parent's — proven live against pinned 0.144.1, see
        // `runtime/__tests__/fixtures/hook-contracts/probe/subagent-start-context-append.json`.
        // Subagent creation cannot be refused (`continue: false` is parsed but
        // ignored), so no block capability is declared.
        // `session.token` is NOT declared here for the same reason as
        // `SessionStart`: Codex passes no session id to MCP subprocesses.
        responseCapabilities: ['context.append'],
      },
      {
        name: 'SubagentStop',
        frameworkSubject: 'client.session.subagent.completed',
        // Observer-only — no response capabilities.
      },
      {
        name: 'PreCompact',
        frameworkSubject: 'client.session.compaction.pre',
        // Observer-only — no response capabilities.
      },
      {
        name: 'PostCompact',
        // No frameworkSubject: the post-compaction signal arrives via a
        // subsequent SessionStart hook with source 'compact', mapping to
        // startMode 'compact'. PostCompact is wired for raw ingress only.
      },
      {
        name: 'PermissionRequest',
        // No frameworkSubject: fires when Codex requests tool-use permission
        // from the user. Raw ingress only — the response surface is not yet
        // proven against pinned 0.144.1 source, so no capability is declared.
      },
    ],
  },
});

/**
 * Client definition for the Anthropic Claude Code CLI.
 *
 * Claude Code is a first-party agentic coding assistant binary (`claude`)
 * that Makaio harnesses via the claude-code adapter. This definition declares
 * the well-known native tools the binary exposes so the Harness UI and
 * approval-policy service can reason about them without coupling to the adapter.
 * @packageDocumentation
 */

import { createClientDefinition } from '@makaio/contracts';

/** Namespaced Claude Code hook-response capabilities exposed to contributors. */
export const CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES = Object.freeze({
  approve: 'claude-code.tool-response.approve',
  deny: 'claude-code.tool-response.deny',
} as const);

/**
 * Static client definition for `@makaio/client-claude-code`.
 *
 * Declares the native tools exposed by the `claude` binary and the
 * recommended default approval policy for new harnesses targeting this client.
 */
export const clientDefinition = createClientDefinition({
  id: 'claude-code',
  name: 'Claude Code',
  version: '0.1.0',
  description: 'Anthropic Claude Code CLI — an agentic coding assistant',
  binary: {
    name: 'claude',
    // Detection range, deliberately wider than the managed pin below. The pin
    // is the version every declared capability was probed against; it governs
    // what this client may *claim*, not which binaries it refuses to drive. A
    // 2.1.x binary a user already has predates the evidence for newer response
    // capabilities but still runs every event this client dispatches, so it is
    // accepted. The next major may change the hook surface and is not.
    //
    // The floor gates *capabilities* that are range-wide: a responseCapability
    // declared here installs `hook handle` for every accepted binary, so every
    // declared capability must predate the floor. Per the upstream changelog,
    // SessionStart shipped in 1.0.62; `additionalContext` arrived per event —
    // UserPromptSubmit 1.0.59, PreToolUse 2.1.9, Stop/SubagentStop 2.1.163 —
    // and no such entry exists for SessionStart in 2.x because injecting startup
    // context is the hook's purpose. Likewise SubagentStart (2.0.43).
    //
    // An *event* first supported above the floor declares `minimumVersion` on
    // its hook-event entry instead of raising the floor (see PostCompact at
    // minimumVersion 2.1.76). A responseCapability that is *not* range-wide on
    // an event still has no per-capability gate — only per-event — so that case
    // still requires raising this floor or adding a separate event declaration
    // for the newer capability.
    supportedVersions: '^2.1.0',
  },
  managedInstall: {
    type: 'signed-binary-bucket',
    version: '2.1.219',
    config: {
      baseUrl: 'https://downloads.claude.ai/claude-code-releases',
      manifestPathTemplate: '{version}/manifest.json',
      manifestSignaturePathTemplate: '{version}/manifest.json.sig',
      publicKeyUrl: 'https://downloads.claude.ai/keys/claude-code.asc',
      publicKeyFingerprint: '31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE',
      binaryPathTemplate: '{version}/{platform}/{binary}',
      platforms: {
        'darwin-arm64': 'darwin-arm64',
        'darwin-x64': 'darwin-x64',
        'linux-arm64': 'linux-arm64',
        'linux-x64': 'linux-x64',
        'linux-arm64-musl': 'linux-arm64-musl',
        'linux-x64-musl': 'linux-x64-musl',
        'win32-arm64': 'win32-arm64',
        'win32-x64': 'win32-x64',
      },
    },
  },
  versionCommand: {
    executable: {
      default: 'claude',
      win32: 'claude.exe',
    },
    args: ['--version'],
  },
  configIsolation: {
    envVar: 'CLAUDE_CONFIG_DIR',
    defaultPath: '~/.claude',
  },
  nativeTools: [
    {
      name: 'bash',
      friendlyName: 'Terminal',
      description: 'Execute shell commands',
      category: 'System',
      capabilities: [
        { tag: 'shell.execute' },
        { tag: 'file.read' },
        { tag: 'file.write' },
        { tag: 'file.delete' },
        { tag: 'network.request' },
        { tag: 'process.manage' },
      ],
    },
    {
      name: 'text_editor',
      friendlyName: 'Text Editor',
      description: 'View and edit files',
      category: 'Files',
      capabilities: [{ tag: 'file.read' }, { tag: 'file.write' }],
    },
    {
      name: 'list_directory',
      friendlyName: 'List Directory',
      description: 'List directory contents',
      category: 'Files',
      capabilities: [{ tag: 'file.read' }, { tag: 'search.files' }],
    },
    {
      name: 'read_file',
      friendlyName: 'Read File',
      description: 'Read file contents',
      category: 'Files',
      capabilities: [{ tag: 'file.read' }],
    },
    {
      name: 'write_file',
      friendlyName: 'Write File',
      description: 'Write content to a file',
      category: 'Files',
      capabilities: [{ tag: 'file.write' }],
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
      id: 'oauth-token',
      mode: 'explicit',
      label: 'OAuth token',
      fields: [
        {
          id: 'oauthToken',
          label: 'OAuth token',
          required: true,
          secret: true,
          sourceHints: [{ kind: 'environment', variable: 'CLAUDE_CODE_OAUTH_TOKEN' }],
        },
      ],
    },
  ],
  defaultAuth: {
    providerDefinitionId: 'anthropic-oauth',
    methodId: 'native',
  },
  runtimeCapabilities: {
    supportsHooks: true,
    supportsStatusline: true,
    supportsSupervisorLaunch: false,
    supportsManagedBinary: true,
    hookEvents: [
      {
        name: 'SessionStart',
        frameworkSubject: 'client.session.started',
        responseCapabilities: ['context.append'],
      },
      {
        name: 'UserPromptSubmit',
        frameworkSubject: 'client.session.userPrompt.submitted',
        responseCapabilities: ['context.append'],
      },
      {
        name: 'PreToolUse',
        frameworkSubject: 'client.session.tool.pre',
        responseCapabilities: [
          CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.approve,
          CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.deny,
          'context.append',
        ],
      },
      { name: 'PostToolUse', frameworkSubject: 'client.session.tool.post' },
      { name: 'Stop', frameworkSubject: 'client.session.turn.completed' },
      {
        name: 'SubagentStart',
        frameworkSubject: 'client.session.subagent.started',
        responseCapabilities: ['context.append'],
      },
      { name: 'SubagentStop', frameworkSubject: 'client.session.subagent.completed' },
      { name: 'PreCompact', frameworkSubject: 'client.session.compaction.pre' },
      {
        // No frameworkSubject: like SubagentStart the post-compaction signal arrives via the
        // subsequent SessionStart hook with source 'compact' (startMode: 'compact').
        // PostCompact is wired for raw ingress only.
        name: 'PostCompact',
        minimumVersion: '2.1.76',
      },
      { name: 'Notification' },
      { name: 'MCPServerStart' },
      { name: 'MCPServerStop' },
    ],
  },
});

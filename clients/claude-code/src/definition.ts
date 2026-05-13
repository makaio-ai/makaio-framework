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
    supportedVersions: '>=1.0.0',
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
  defaultProviderId: 'anthropic-oauth',
  runtimeCapabilities: {
    supportsHooks: true,
    supportsStatusline: true,
    supportsSupervisorLaunch: false,
    supportsManagedBinary: false,
    hookEvents: [
      { name: 'SessionStart', frameworkSubject: 'client.session.started' },
      {
        name: 'UserPromptSubmit',
        frameworkSubject: 'client.session.userPrompt.submitted',
      },
      { name: 'PreToolUse', frameworkSubject: 'client.session.tool.pre' },
      { name: 'PostToolUse', frameworkSubject: 'client.session.tool.post' },
      { name: 'Stop', frameworkSubject: 'client.session.turn.completed' },
      { name: 'SubagentStop' },
      { name: 'Notification' },
      { name: 'MCPServerStart' },
      { name: 'MCPServerStop' },
    ],
  },
});

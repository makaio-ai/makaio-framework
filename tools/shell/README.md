# @makaio/tools-shell

Cross-platform shell execution toolset for AI agents. Provides robust subprocess management with output buffering, constraint enforcement, and lifecycle management.

## Quick Start

```typescript
import { ToolRegistry } from '@makaio/services-core/tools';
import { createShellToolset } from '@makaio/tools-shell';

const { toolset, manager } = createShellToolset();
const registry = new ToolRegistry();
await registry.register(toolset);

// Start a command
const execResult = await registry.execute('shell_exec', {
  command: 'npm test',
});

if (execResult.success) {
  const { shellId } = execResult.data;

  // Check status
  const status = await registry.execute('shell_status', { shellId });

  // Get output
  const output = await registry.execute('shell_output', {
    shellId,
    stream: 'stdout',
  });
}
```

## Available Tools

### shell_exec

Starts a shell command in the background.

```typescript
// Input
{
  command: string;              // Command to execute
  cwd?: string;                 // Working directory (defaults to context.cwd)
  env?: Record<string, string>; // Additional environment variables
  colors?: boolean;             // Preserve ANSI codes (default: false)
  timeout?: number;             // Override timeout in ms; can only shorten the configured timeout
}

// Output
{
  shellId: string;  // Unique identifier for subsequent operations
  pid: number;      // Process ID
  shell: string;    // Shell used (bash, zsh, powershell, cmd)
}

// Annotations: { destructive: true }
```

### shell_status

Checks status of a running or exited shell.

```typescript
// Input
{
  shellId: string;  // Shell identifier
}

// Output
{
  shellId: string;
  status: 'running' | 'exited';
  exitCode?: number;    // Only if exited
  stdoutSize: number;   // Characters captured
  stderrSize: number;   // Characters captured
  truncated: boolean;   // True if hit maxOutputSize
  runtimeMs: number;    // Milliseconds since start
}

// Annotations: { readOnly: true }
```

### shell_output

Retrieves raw output with pagination support.

```typescript
// Input
{
  shellId: string;
  stream?: 'stdout' | 'stderr' | 'both';  // Default: 'both'
  offset?: number;                         // Character offset (default: 0)
  limit?: number;                          // Max chars (default: 10000)
}

// Output
{
  content: string;
  stream: 'stdout' | 'stderr' | 'interleaved';
  offset: number;
  totalSize: number;
  hasMore: boolean;
}

// Annotations: { readOnly: true }
```

### shell_grep

Searches output using regex with context lines.

```typescript
// Input
{
  shellId: string;
  pattern: string;                          // Regex pattern
  stream?: 'stdout' | 'stderr' | 'both';   // Default: 'both'
  context?: number;                         // Lines before/after (default: 2)
  maxMatches?: number;                      // Max matches (default: 10)
  offset?: number;                          // Skip first N matches
}

// Output
{
  matches: Array<{
    lineNumber: number;
    stream: 'stdout' | 'stderr';
    line: string;
    before: string[];
    after: string[];
  }>;
  totalMatches: number;
  truncated: boolean;
}

// Annotations: { readOnly: true }
```

### shell_send

Sends input to stdin of a running shell.

```typescript
// Input
{
  shellId: string;
  input: string;  // Text to send (include newline if needed)
}

// Output
{
  sent: boolean;
  bytesWritten: number;
}

// Annotations: { destructive: true }
```

### shell_kill

Terminates a running shell with specified signal.

```typescript
// Input
{
  shellId: string;
  signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT';  // Default: 'SIGTERM'
}

// Output
{
  killed: boolean;
  signal: string;
}

// Annotations: { destructive: true }
```

## Constraints

Configure runtime limits under `context.constraints.shell`:

```typescript
await registry.execute(
  'shell_exec',
  { command: 'npm test', timeout: 5_000 },
  {
    contextOverrides: {
      constraints: {
        shell: {
          timeout: 30_000,
          maxOutputSize: 10_485_760,
          maxConcurrentShells: 10,
        },
      },
    },
  },
);
```

`shell_exec.timeout` is capped with `Math.min(input.timeout, constraints.shell.timeout)`, so callers can shorten the
configured timeout but cannot extend it.

The shell toolset carries an internal `configSchema` for host configuration UI generation. The
schema itself is not exported from the package root; consumers can import the exported
`ShellConstraints` type and `DEFAULT_CONSTRAINTS` constant. `allowedPaths` and `blockedCommands`
exist for configuration UI compatibility, but the current shell tools do not enforce those fields.
Do not rely on them for security policy.

## Cross-Platform Notes

- Shell auto-detected: bash/zsh on POSIX, PowerShell on Windows
- Color codes stripped by default (set `colors: true` to preserve)
- Process trees killed properly via `tree-kill`

## File Index

| File | Purpose |
|------|---------|
| `src/toolset.ts` | Factory: `createShellToolset()` |
| `src/tools/shell-exec.ts` | shell_exec implementation |
| `src/tools/shell-status.ts` | shell_status implementation |
| `src/tools/shell-output.ts` | shell_output implementation |
| `src/tools/shell-grep.ts` | shell_grep implementation |
| `src/tools/shell-send.ts` | shell_send implementation |
| `src/tools/shell-kill.ts` | shell_kill implementation |
| `src/manager/shell-manager.ts` | Lifecycle management |
| `src/manager/shell-instance.ts` | Individual subprocess wrapper |
| `src/utils/output-buffer.ts` | Output buffering with size limits |
| `src/utils/platform.ts` | Cross-platform shell detection |

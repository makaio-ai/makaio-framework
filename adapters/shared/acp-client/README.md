# @makaio/ai-adapters-acp-client

Shared Agent Client Protocol (ACP) infrastructure for Makaio adapter
implementations. Provides the subprocess spawn, ndjson stream bridge,
`Client` implementation, and terminal lifecycle manager used by ACP-based
adapters such as `@makaio/ai-adapters-qwen-acp`.

This workspace package is not a standalone public adapter API. Adapter
packages import it directly; application code should use the adapter packages
or their `./server` runtime contributions instead.

## Usage

```typescript
import {
  createAcpConnection,
  MakaioAcpClient,
  TerminalManager,
} from '@makaio/ai-adapters-acp-client';

const terminalManager = new TerminalManager();

const client = new MakaioAcpClient({
  onSessionUpdate: async (notification) => { /* handle chunks, tool calls, usage */ },
  onRequestPermission: async (params) => { /* return allow/deny */ },
  onReadTextFile: async (params) => { /* return file contents */ },
  onWriteTextFile: async (params) => { /* return write confirmation */ },
  terminalManager,
});

const handle = await createAcpConnection(() => client, {
  command: 'qwen',
  args: ['--acp', '--model', 'qwen3-coder'],
  cwd: '/path/to/project',
  env: { OPENAI_API_KEY: '...' },
  onStderr: (data) => console.error(data),
  onExit: (code) => console.log('exit', code),
});

await handle.connection.initialize({ /* ... */ });
const session = await handle.connection.newSession({ cwd: '/path/to/project' });

// When done:
handle.kill();
```

## API Overview

| Export | Description |
|--------|-------------|
| `createAcpConnection` | Spawns an ACP agent subprocess and establishes a protocol connection over stdio |
| `MakaioAcpClient` | ACP `Client` implementation that routes agent requests to connector callbacks |
| `TerminalManager` | Manages stateful terminal subprocess lifecycles for ACP agents |
| `AcpConnectionOptions` | Configuration for spawning an ACP subprocess |
| `AcpConnectionHandle` | Live connection handle: `connection`, `kill()`, `exited` promise |
| `MakaioAcpClientConfig` | Callbacks for routing ACP server requests to Makaio infrastructure |

### `createAcpConnection`

Spawns the ACP agent subprocess and bridges its stdin/stdout to the ACP SDK
via Node.js Web Streams (`Readable.toWeb()` / `Writable.toWeb()`). Returns an
`AcpConnectionHandle` with a live `ClientSideConnection` from
`@agentclientprotocol/sdk`.

### `MakaioAcpClient`

Implements the ACP `Client` interface and routes each agent-initiated request
to the appropriate callback or manager:

- `sessionUpdate` → `onSessionUpdate` (message chunks, tool calls, usage updates)
- `requestPermission` → `onRequestPermission` (tool approval)
- `readTextFile` / `writeTextFile` → `onReadTextFile` / `onWriteTextFile`
- `createTerminal` / `terminalOutput` / `waitForTerminalExit` / `killTerminal` / `releaseTerminal` → `TerminalManager`

Capability handlers that are not configured throw a descriptive error when
invoked, making misconfigured clients fail fast.

### `TerminalManager`

Manages the full ACP stateful terminal protocol (create → output → wait →
kill → release) using `node:child_process` directly. Output is buffered per
terminal with a configurable byte limit (default 1 MiB) and truncated from the
start when exceeded. Call `releaseAll()` during connector shutdown to prevent
resource leaks.

## Installation

This is a private workspace package. It is not published to npm and is only
available from this source workspace.

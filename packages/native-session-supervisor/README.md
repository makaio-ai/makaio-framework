# @makaio/native-session-supervisor

Framework package that owns the supervised native-process runtime lifecycle:
spawning PTY sessions, tracking running processes, and persisting their state
to a Drizzle-backed storage namespace. Adapters that launch CLI subprocesses
(e.g. `claude-code`) use this package to manage process state across restarts.

## Usage

### Register the extension package

```typescript
import { nativeSessionSupervisorPackage } from '@makaio/native-session-supervisor/package';

coordinator.load([nativeSessionSupervisorPackage]);
```

### Spawn and track a PTY session

```typescript
import {
  PtyRuntime,
  createNodePtyBackend,
  OutputBuffer,
} from '@makaio/native-session-supervisor';

const backend = await createNodePtyBackend();
const buffer = new OutputBuffer();

const pty = new PtyRuntime(backend, {
  command: 'claude',
  args: ['--mcp-server', 'http://localhost:3001'],
  cwd: '/workspace',
  env: { TERM: 'xterm-256color' },
  onData: (data) => buffer.push(data),
  onExit: ({ exitCode }) => console.log('exited', exitCode),
});

await pty.spawn();
pty.write('some input\n');
const { data, bytesRead } = buffer.read(1024);
await pty.kill();
```

### Use the runtime registry

```typescript
import { RuntimeRegistry } from '@makaio/native-session-supervisor';

const registry = new RuntimeRegistry(bus);
await registry.init({ supervisorSessionId: 'sup-1', clientId: 'claude-code', ... });
await registry.update({ supervisorSessionId: 'sup-1', status: 'completed', stoppedAt: Date.now() });
const runtime = registry.get('sup-1');
```

## API Overview

| Export | Description |
|--------|-------------|
| `nativeSessionSupervisorPackage` | `MakaioExtension` manifest (import from `./package`) |
| `SupervisorService` | Service class that owns the runtime registry and responds to bus subjects |
| `RuntimeRegistry` | In-memory + persistent registry for `SupervisorRuntime` entries |
| `PtyRuntime` | PTY session lifecycle manager: spawn, write, resize, kill, I/O callbacks |
| `OutputBuffer` | Ring-buffer that accumulates PTY output for cursor-based reads |
| `createNodePtyBackend()` | Lazy-load the `node-pty` backend (Node.js hosts only) |
| `NodeBridgeBackend` | Bridge-process backend for Bun hosts |
| `SupervisorRuntimeStorageNamespace` / `SupervisorRuntimeStorageSubjects` | Bus subjects for storage CRUD |
| `supervisorRuntimes` | Drizzle table schema |
| `registerDrizzleSupervisorRuntimeStorage()` | Register Drizzle-backed storage handlers |
| `runtimeToRow()` / `rowToRuntime()` | Map between in-memory `SupervisorRuntime` and DB row |
| `type SupervisorRuntime` | Full in-memory runtime record |
| `type SupervisorRuntimeInit` | Fields required to create a new runtime entry |
| `type SupervisorRuntimeUpdate` | Partial update payload (mutable fields only) |
| `type IPtyBackend` / `IPtyProcess` | Backend seam for swapping `node-pty` vs bridge |
| `type PtySpawnParams` | Parameters passed to `PtyRuntime` on spawn |

## Installation

`@makaio/native-session-supervisor` is a private workspace package:

```json
{ "@makaio/native-session-supervisor": "workspace:*" }
```

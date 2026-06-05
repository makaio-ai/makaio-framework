import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { resolveConformanceTestPreset, resolveTestConfig } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { startBusServer, type BusServer } from '@makaio/bus-server';
import { DEFAULT_HOOK_HANDLE_TIMEOUT_MS } from '@makaio/subsystem-client';
import { WebSocketServer } from 'ws';
import { CursorSdkNamespace } from './namespaces/index.js';
import type { CursorSdkBus } from './namespaces/index.js';
import { CursorSdkConnector } from './connector.js';
import type { CursorSdkAgent } from './agent.js';
import { CursorSdkConfig } from './config.js';
import { DEFAULT_TIMEOUTS, CursorSdkAdapterName } from './constants.js';
import { providerIds, testPresetId } from './provider.js';
import { createCursorSdkAdapter } from './adapter.js';
import { registerToolApprovalHandler } from './tool-handling.js';

// ---------------------------------------------------------------------------
// Bus transport for hook subprocesses
// ---------------------------------------------------------------------------

/**
 * Resources created by {@link startTestBusTransport} that must be torn down
 * after conformance tests complete.
 */
interface TestBusTransportHandle {
  /** Loopback port the HTTP server is bound to. */
  port: number;
  /** Full WebSocket URL for the bus endpoint. */
  busUrl: string;
  /** Stop the bus server, detach the upgrade handler, and close the HTTP server. */
  close: () => Promise<void>;
}

/** Cursor project workspace prepared for the conformance worker. */
interface ConnectorWorkspace {
  /** Directory passed to Cursor SDK as `local.cwd`. */
  workspaceDir: string;
  /** Project-level Cursor hooks config inside the workspace. */
  hooksJsonFilePath: string;
}

/**
 * Start an HTTP server with a `/health` endpoint and a WebSocket bus
 * transport on `/bus`.
 *
 * Hook subprocesses (`makaio hook handle cursor preToolUse`) connect to this
 * transport via `MAKAIO_BUS_URL` so they can reach the in-process MakaioBus
 * singleton where the Cursor hook approval bridge is registered.
 * @returns Handle with the port, bus URL, and an async close function.
 */
async function startTestBusTransport(): Promise<TestBusTransportHandle> {
  const server = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, auth: false }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await listenOnLoopback(server);

  const wss = new WebSocketServer({ noServer: true });
  let busServer: BusServer | null = null;
  let busReady = false;

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const reqPath = req.url?.split('?')[0] ?? '';
    if (reqPath !== '/bus') return;
    if (!busReady) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  };
  server.on('upgrade', upgradeHandler);

  busServer = await startBusServer({
    websocket: wss,
    bus: MakaioBus,
    loopbackName: 'conformance-test',
  });
  busReady = true;

  const busUrl = `ws://127.0.0.1:${port}/bus`;

  return {
    port,
    busUrl,
    async close() {
      busReady = false;
      if (busServer) {
        await busServer.stop().catch((err: unknown) => {
          console.error('[conformance] Failed to stop bus server:', err);
        });
        busServer = null;
      }
      server.off('upgrade', upgradeHandler);
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      }).catch(() => {});
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Bind an HTTP server to a random loopback port.
 * @param server - Unbound HTTP server.
 * @returns Port number selected by the OS.
 */
function listenOnLoopback(server: HttpServer): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Failed to bind HTTP test server to a loopback port.'));
        return;
      }
      resolve(address.port);
    });
  });
}

// ---------------------------------------------------------------------------
// Hook command + hooks.json
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the Makaio CLI entry point for subprocess
 * invocation in dev mode.
 *
 * In dev mode the CLI runs via `tsx` from the framework source tree rather
 * than a globally installed binary. The path is resolved relative to the
 * adapter source file to stay correct regardless of the CWD.
 * @returns Absolute path to `cli-entry.ts`.
 */
function resolveCliEntryPath(): string {
  return path.resolve(import.meta.dirname, '../../../../apps/cli/src/cli-entry.ts');
}

/**
 * Shell-quote one argument for a POSIX hook command.
 * @param value - Argument to quote.
 * @returns Single-quoted shell argument.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Write a workspace-local hook wrapper that invokes the Makaio CLI bridge.
 *
 * Cursor's hook runner executes project-local hook scripts reliably, while
 * direct commands pointing at source files outside the project workspace can
 * be skipped. The wrapper lives under `.cursor/`, receives Cursor's hook JSON
 * on stdin, and forwards stdin/stdout/stderr to the real CLI bridge process.
 * @param busUrl - WebSocket URL of the test bus transport.
 * @param cursorDir - Project `.cursor` directory.
 * @returns Absolute path to the written wrapper module.
 */
function writeHookWrapperScript(busUrl: string, cursorDir: string): string {
  const cliEntry = resolveCliEntryPath();
  const wrapperPath = path.join(cursorDir, 'makaio-pretooluse-hook.mjs');
  const wrapperSource = [
    "import { spawn } from 'node:child_process';",
    `const cliEntry = ${JSON.stringify(cliEntry)};`,
    `const busUrl = ${JSON.stringify(busUrl)};`,
    `const timeoutMs = ${JSON.stringify(String(DEFAULT_HOOK_HANDLE_TIMEOUT_MS))};`,
    "const child = spawn(cliEntry, ['hook', 'handle', 'cursor', 'preToolUse', '--timeout', timeoutMs], {",
    '  env: { ...process.env, MAKAIO_BUS_URL: busUrl },',
    "  stdio: ['pipe', 'pipe', 'pipe'],",
    '});',
    'process.stdin.pipe(child.stdin);',
    'child.stdout.pipe(process.stdout);',
    'child.stderr.pipe(process.stderr);',
    "child.on('error', (error) => {",
    '  process.stderr.write(`Failed to start Makaio hook bridge: ${error instanceof Error ? error.message : String(error)}\\n`);',
    '  process.exitCode = 1;',
    '});',
    "child.on('close', (code) => {",
    '  process.exit(code ?? 0);',
    '});',
    '',
  ].join('\n');

  fs.writeFileSync(wrapperPath, wrapperSource, 'utf8');

  if (process.env['MAKAIO_DEBUG']) {
    console.debug(`[conformance] hook wrapper path: ${wrapperPath}`);
    console.debug(`[conformance] hook wrapper cliEntry: ${cliEntry}`);
  }

  return wrapperPath;
}

/**
 * Write `.cursor/hooks.json` into the test workspace so Cursor SDK's
 * project-level hooks loader finds it when `local.cwd` points here.
 * @param busUrl - WebSocket URL of the test bus transport.
 * @param workspaceDir - Absolute path to the test workspace directory.
 * @returns Absolute path to the written `hooks.json` file.
 */
function writeCursorHooksJson(busUrl: string, workspaceDir: string): string {
  const cursorDir = path.join(workspaceDir, '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });
  const hooksJsonPath = path.join(cursorDir, 'hooks.json');
  const wrapperPath = writeHookWrapperScript(busUrl, cursorDir);
  const hooksJson = JSON.stringify(
    { version: 1, hooks: { preToolUse: [{ command: `node ${shellQuote(wrapperPath)}` }] } },
    null,
    2,
  );
  fs.writeFileSync(hooksJsonPath, hooksJson, 'utf8');
  return hooksJsonPath;
}

/**
 * Emit environment diagnostics for the Cursor SDK conformance harness.
 * @param testWorkspaceRoot - Cursor project root used by the worker.
 * @param cursorHomeDir - Isolated `CURSOR_HOME` directory.
 * @param busUrl - WebSocket bus URL used by hook subprocesses.
 */
function logEnvironmentSetup(testWorkspaceRoot: string, cursorHomeDir: string, busUrl: string): void {
  if (!process.env['MAKAIO_DEBUG']) return;

  console.debug('[conformance] === ENVIRONMENT SETUP ===');
  console.debug(`[conformance] testWorkspaceRoot=${testWorkspaceRoot}`);
  console.debug(`[conformance] cursorHomeDir=${cursorHomeDir}`);
  console.debug(`[conformance] busUrl=${busUrl}`);
  console.debug(`[conformance] CURSOR_HOME=${process.env['CURSOR_HOME']}`);
  console.debug(`[conformance] MAKAIO_HOME=${process.env['MAKAIO_HOME'] ?? '(unset)'}`);
  console.debug(`[conformance] MAKAIO_BUS_URL=${process.env['MAKAIO_BUS_URL'] ?? '(unset)'}`);
  console.debug(`[conformance] MAKAIO_CONFIG_FILE=${process.env['MAKAIO_CONFIG_FILE'] ?? '(unset)'}`);
  console.debug(`[conformance] cliEntry=${resolveCliEntryPath()}`);
  console.debug(`[conformance] cliEntry exists=${fs.existsSync(resolveCliEntryPath())}`);
  console.debug('[conformance] === END ENVIRONMENT SETUP ===');
}

/**
 * Emit diagnostics for the hook workspace.
 * @param workspace - Workspace and hook config path prepared for the worker.
 */
function logConnectorWorkspace(workspace: ConnectorWorkspace): void {
  if (!process.env['MAKAIO_DEBUG']) return;

  const hooksContent = fs.readFileSync(workspace.hooksJsonFilePath, 'utf8');
  console.debug(`[conformance] connectorWorkspace=${workspace.workspaceDir}`);
  console.debug(`[conformance] hooks.json path=${workspace.hooksJsonFilePath}`);
  console.debug(`[conformance] hooks.json exists=${fs.existsSync(workspace.hooksJsonFilePath)}`);
  console.debug(`[conformance] hooks.json content=${hooksContent}`);
}

// ---------------------------------------------------------------------------
// Conformance test config
// ---------------------------------------------------------------------------

/**
 * Create a conformance test configuration for the Cursor SDK adapter.
 *
 * Starts a WebSocket bus transport on a random loopback port so hook
 * subprocesses can reach the in-process MakaioBus. The worker receives a
 * project workspace with `.cursor/hooks.json` already written before any
 * `Agent.create()` call can load the SDK executor. Tears everything down in
 * cleanup.
 * @param options - Provider definitions supplied by the conformance harness
 * @returns Conformance test configuration instance
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<CursorSdkBus, CursorSdkConnector, CursorSdkAgent>> => {
  const bus = await CursorSdkNamespace.scopedBus();
  const testPreset = resolveConformanceTestPreset({
    adapterName: CursorSdkAdapterName,
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  const transportHandle = await startTestBusTransport();

  // Dedicated Cursor project root for this conformance worker. The generic
  // tool-approval tests create their target files under options.tmpDir, so the
  // Cursor SDK cwd and the hook-owning project root must be that same directory.
  const testWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-ws-'));
  const connectorWorkspace: ConnectorWorkspace = {
    workspaceDir: testWorkspaceRoot,
    hooksJsonFilePath: writeCursorHooksJson(transportHandle.busUrl, testWorkspaceRoot),
  };

  // Isolate CURSOR_HOME so the SDK does not read or pollute ~/.cursor.
  const previousCursorHome = process.env['CURSOR_HOME'];
  const cursorHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-home-'));
  process.env['CURSOR_HOME'] = cursorHomeDir;

  logEnvironmentSetup(testWorkspaceRoot, cursorHomeDir, transportHandle.busUrl);

  return {
    createConnector: async (options) => {
      logConnectorWorkspace(connectorWorkspace);
      return new CursorSdkConnector(
        await CursorSdkConfig.getConfig(
          resolveTestConfig(
            { ...options, cwd: connectorWorkspace.workspaceDir } as typeof options,
            bus,
            testPreset.provider,
            testPreset.providers,
          ),
        ),
      );
    },
    bus,
    registerToolApprovalHandler,
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true,
      supportsUsageMetrics: true,
    },
    options: {
      defaultTimeout: DEFAULT_TIMEOUTS.completion,
      concurrency: 4,
      tmpDir: testWorkspaceRoot,
      primaryModel: { definitionId: 'cursor', modelName: 'composer-2', reasoningEffort: 'low' },
      secondaryModel: { definitionId: 'cursor', modelName: 'composer-2.5', reasoningEffort: 'low' },
    },
    createAdapter: async (options) => createCursorSdkAdapter(options),
    adapterName: CursorSdkAdapterName,
    testProviderContext: testPreset.providerContext,
    cleanup: async () => {
      if (previousCursorHome !== undefined) {
        process.env['CURSOR_HOME'] = previousCursorHome;
      } else {
        delete process.env['CURSOR_HOME'];
      }
      fs.rmSync(cursorHomeDir, { recursive: true, force: true });
      fs.rmSync(testWorkspaceRoot, { recursive: true, force: true });
      await transportHandle.close();
    },
  };
};

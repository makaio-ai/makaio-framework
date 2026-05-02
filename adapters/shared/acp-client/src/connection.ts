import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream as NodeReadableStream, WritableStream as NodeWritableStream } from 'node:stream/web';
import * as acp from '@agentclientprotocol/sdk';
import type { AcpConnectionHandle, AcpConnectionOptions } from './types.js';
import { waitForSpawn, cleanupFailedProcess } from './proc-utils.js';

/**
 * ACP is typed against lib.dom streams, while Node returns `node:stream/web`
 * declarations from `toWeb()`. The runtime objects are the same WHATWG streams,
 * but TypeScript treats the ACP SDK's DOM types and Node's stream/web types as
 * distinct, so the double cast is the intentional bridge at the SDK boundary.
 * @param stream - Node web readable stream
 * @returns ACP-compatible readable stream
 */
function toAcpReadableStream(stream: NodeReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return stream as unknown as ReadableStream<Uint8Array>;
}

/**
 * ACP is typed against lib.dom streams, while Node returns `node:stream/web`
 * declarations from `toWeb()`. The runtime objects are the same WHATWG streams,
 * but TypeScript treats the ACP SDK's DOM types and Node's stream/web types as
 * distinct, so the double cast is the intentional bridge at the SDK boundary.
 * @param stream - Node web writable stream
 * @returns ACP-compatible writable stream
 */
function toAcpWritableStream(stream: NodeWritableStream<Uint8Array>): WritableStream<Uint8Array> {
  return stream as unknown as WritableStream<Uint8Array>;
}

/**
 * Spawns an ACP agent subprocess and establishes a protocol connection over stdio.
 *
 * The subprocess stdin/stdout are bridged to the ACP SDK via Web Streams using
 * `Readable.toWeb()` / `Writable.toWeb()` (Node.js 16+). The returned handle
 * exposes the {@link acp.ClientSideConnection} for issuing ACP requests along with
 * lifecycle controls.
 * @param clientFactory - Factory called with the negotiated {@link acp.Agent} proxy;
 *   must return the {@link acp.Client} implementation that handles incoming agent requests
 * @param options - Subprocess spawn configuration
 * @returns Handle containing the live connection, a kill function, and an exit promise
 */
export async function createAcpConnection(
  clientFactory: (agent: acp.Agent) => acp.Client,
  options: AcpConnectionOptions,
): Promise<AcpConnectionHandle> {
  const proc = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await waitForSpawn(proc);
  } catch (error) {
    options.onError?.(error as Error);
    throw error;
  }

  if (options.onStderr && proc.stderr) {
    proc.stderr.on('data', (chunk: Buffer) => {
      options.onStderr!(chunk.toString('utf-8'));
    });
  }

  const exited = new Promise<number | null>((resolve) => {
    proc.once('exit', (code) => {
      options.onExit?.(code);
      resolve(code);
    });
  });
  proc.on('error', (error) => {
    options.onError?.(error);
  });

  let connection: acp.ClientSideConnection;
  try {
    // Use Node's stream/web types here so TypeScript doesn't confuse them with
    // the lib.dom declarations when both DOM and Node libs are in scope.
    const readable: NodeReadableStream<Uint8Array> = Readable.toWeb(proc.stdout!);
    const writable: NodeWritableStream<Uint8Array> = Writable.toWeb(proc.stdin!);
    const stream = acp.ndJsonStream(toAcpWritableStream(writable), toAcpReadableStream(readable));
    connection = new acp.ClientSideConnection(clientFactory, stream);
  } catch (error) {
    await cleanupFailedProcess(proc);
    throw error;
  }

  return {
    connection,
    kill: () => proc.kill('SIGTERM'),
    exited,
  };
}

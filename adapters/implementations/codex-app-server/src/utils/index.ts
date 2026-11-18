/**
 * Utilities for Codex App-Server Adapter
 *
 * Provides the app-server transport (the shared JSONL transport with the
 * app-server's options) and the JSON-RPC client for communicating with the
 * codex app-server subprocess.
 */

export {
  APP_SERVER_PROCESS_NAME,
  APP_SERVER_STOP_TIMING,
  createStdioTransport,
  type AppServerStopTiming,
  type CodexStdioTransportOptions,
} from './createStdioTransport.js';
export { createJsonRpcClient, type JsonRpcClient } from './jsonRpcClient.js';
export { formatMessageHistory } from './formatMessageHistory.js';

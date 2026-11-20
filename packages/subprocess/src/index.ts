export { createJsonlTransport } from './jsonl-transport.js';
export type {
  IJsonlTransport,
  JsonlChannel,
  JsonlTransportOptions,
  ListenerErrorPolicy,
  MessageListener,
  ProcessStopTiming,
  SpawnEnvMode,
  StderrMode,
  SubprocessSpawnOptions,
  TransportCloseOptions,
  TransportStatus,
} from './types.js';
export { notifyObserver } from './notify-listeners.js';
export { processStopBudgetMs } from './stop-budget.js';
export { createJsonRpcClient } from './json-rpc-client.js';
export type { IJsonRpcClient, ServerRequestHandler, NotificationHandler } from './json-rpc-client.js';
export { createProcessLifecycle } from './process-lifecycle.js';
export type {
  ProcessLifecycleOptions,
  ProcessLifecycleHandle,
  ProcessRunOutcome,
  ProcessStartOptions,
  ProcessState,
  RestartDecision,
  RestartPolicy,
  RunReadiness,
} from './process-lifecycle.js';
export type { RestartBudgetOptions } from './restart-budget.js';
export { createJsonlDecoder, describeJsonlDrops } from './jsonl-framing.js';
export type {
  JsonlDecoder,
  JsonlDecoderOptions,
  JsonlDecodeBatch,
  JsonlDecodeEnd,
  JsonlLineDrops,
} from './jsonl-framing.js';
export { describeProcessExit, describeTransportEnd, mayHaveLeftProcesses } from './process-end.js';
export type {
  CommunicationFailure,
  DrainOutcome,
  EndCause,
  FinalLinePolicy,
  ObservedProcessExit,
  ProcessExit,
  ProcessTreeEvidence,
  StdoutEndPolicy,
  TransportEnd,
  TreeQuiescenceGap,
  UnobservedExitReason,
} from './process-end.js';
export {
  proveProcessGroupQuiescence,
  signalOwnedProcesses,
  spawnOptionsForOwnership,
  terminateWindowsProcessTree,
  WindowsTreeTerminationError,
} from './process-tree.js';
export type {
  GroupQuiescenceGap,
  GroupQuiescenceOptions,
  GroupQuiescenceProof,
  OwnershipSpawnOptions,
  ProcessSignalPort,
  SignalDelivery,
  StopOwnership,
  WindowsTreeTerminationFailure,
  WindowsTreeTerminationOptions,
} from './process-tree.js';
export { INVALID_LAUNCH_TIMEOUT_MESSAGE, isValidLaunchTimeoutMs, launch } from './launch.js';
export { launchForOutput } from './launch-for-output.js';
export type { LaunchForOutputOptions, LaunchForOutputResult } from './launch-for-output.js';
export type {
  LaunchCapturedOutput,
  LaunchFunction,
  LaunchGroupFacts,
  LaunchOptions,
  LaunchOutput,
  LaunchRefusal,
  LaunchResult,
  LaunchStatus,
  LaunchedProcess,
} from './launch.js';
export type { StopHost } from './stop-escalation.js';

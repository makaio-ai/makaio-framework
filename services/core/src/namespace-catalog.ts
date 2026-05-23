import { AgentRuntimeNamespace } from './agent-runtime/namespace.js';
import { AdapterRuntimeNamespace } from './adapter-runtime/namespace.js';
import { AdapterSubsystemNamespace } from './adapter-subsystem/namespace.js';
import { CodebaseNamespace } from './codebase/namespace.js';
import { CompressionNamespace } from './compression/namespace.js';
import { ContextRulesServiceNamespace } from './context-rules/service-namespace.js';
import { ContextRulesStorageNamespace } from './context-rules/storage-namespace.js';
import { DefinitionNamespace } from './definition/namespace.js';
import { DialogNamespace } from './dialog/namespace.js';
import { DockerNamespace } from './execution-target/container-namespace.js';
import { ExecutionTargetNamespace } from './execution-target/namespace.js';
import { FsNamespace } from './filesystem/namespace.js';
import { HarnessStorageNamespace } from './harness/storage/namespace.js';
import { CLIDetectionNamespace } from './cli-detection/namespace.js';
import { LocalNotificationNamespace } from './local-notification/namespace.js';
import { ModelRegistryNamespace } from './model-registry/namespace.js';
import { ModelRegistryPublicNamespace } from '@makaio/contracts/model-registry';
import { PreferencesNamespace } from './preferences/storage-namespace.js';
import { ProviderRuntimeNamespace } from './provider-runtime/namespace.js';
import { SessionEditorNamespace } from './session-editor/namespace.js';
import { MessageRoutingNamespace } from './session/message-routing/namespace.js';
import { AgentStorageNamespace } from './session/storage/agent-namespace.js';
import { ExtensionConfigStorageNamespace } from './settings/storage/extension-configs/namespace.js';
import { ClientStorageNamespace } from './settings/storage/clients-namespace.js';
import { ProviderStorageNamespace } from './settings/storage/providers-namespace.js';
import { SettingsNamespace, WorkerSettingsNamespace } from './settings/namespace.js';
import { TrayMenuNamespace } from './tray-menu/namespace.js';
import { TurnStorageNamespace } from './turn/namespace.js';
import { WorkerKernelNamespace } from './worker/namespace.js';
import { ImportCursorStorageNamespace } from '@makaio/ai-adapters-core';

/**
 * Framework service namespace definitions registered by runtime composition roots.
 */
export const FrameworkServicesCoreNamespaces = [
  AdapterRuntimeNamespace,
  AdapterSubsystemNamespace,
  AgentRuntimeNamespace,
  AgentStorageNamespace,
  CLIDetectionNamespace,
  ClientStorageNamespace,
  CodebaseNamespace,
  CompressionNamespace,
  ContextRulesServiceNamespace,
  ContextRulesStorageNamespace,
  DefinitionNamespace,
  DialogNamespace,
  DockerNamespace,
  ExecutionTargetNamespace,
  ExtensionConfigStorageNamespace,
  FsNamespace,
  HarnessStorageNamespace,
  ImportCursorStorageNamespace,
  LocalNotificationNamespace,
  MessageRoutingNamespace,
  ModelRegistryNamespace,
  ModelRegistryPublicNamespace,
  PreferencesNamespace,
  ProviderRuntimeNamespace,
  ProviderStorageNamespace,
  SessionEditorNamespace,
  SettingsNamespace,
  TrayMenuNamespace,
  TurnStorageNamespace,
  WorkerKernelNamespace,
  WorkerSettingsNamespace,
] as const;

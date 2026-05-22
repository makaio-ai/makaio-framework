export type {
  HashTrigger,
  HashTriggerContext,
  HashTriggerMetadata,
  HashTriggerSuggestResult,
  HashTriggerStage,
  HashSuggestion,
  GatheredEntry,
  GatheredContext,
} from './hash-trigger-types.js';

export type {
  ExtensionBootstrap,
  BootstrapDiscoverContext,
  BootstrapExportContext,
  BootstrapImportContext,
  BootstrapAsset,
  BootstrapAssetKey,
  BootstrapImportResult,
  BootstrapChoice,
  BootstrapResult,
  BootstrapExportResult,
} from './bootstrap-types.js';
export { getBootstrapAssetKey } from './bootstrap-types.js';

export type {
  SessionEventActionContext,
  SessionEventActionOptions,
  SessionEventActionDeclaration,
  CreateSessionEventActionResult,
  EntrypointConfig,
  EventFilter,
  MessageEventFilter,
  StructuralEventFilter,
  MessageRole,
  WhenContext,
  PickerOpenContext,
  PickerConfig,
  SelectionChangeContext,
  SelectionFeedback,
  ExecuteContext,
  ExecuteResult,
  ActionShortcut,
  ActionShortcutModifiers,
  ActionCategory,
  ActionCategoryMap,
} from './session-event-action-types.js';

export type { TileDeclaration, TileProps, TileRenderers, TileCapabilities, TileIconLoader } from './tile-types.js';

export type { WidgetDeclaration, WidgetDefinition, WidgetProps, WidgetRenderers, WidgetSize } from './widget-types.js';

export type {
  PageDeclaration,
  PageComponentProps,
  PageMode,
  SlotDeclaration,
  SlotContentDeclaration,
  SlotPlacementDeclaration,
  SlotId,
  WidgetSize as PageWidgetSize,
} from './page-types.js';

export type {
  ToolCallFormatterDeclaration,
  PluginFormattedToolCallOutput,
  PluginTransformedContent,
  PluginTransformedContentType,
  PluginToolCallFormatterInput,
} from './tool-formatter-types.js';

export type {
  MakaioWebUiRoute,
  MakaioWebUiLoader,
  MakaioWebUiAction,
  MakaioWebUiActions,
  MakaioWebUiComponentProps,
  PromisifiedActions,
  LoaderContext,
  ExtensionConfigComponentProps,
  ExtensionFieldTypeLoader,
  ExtensionConfigComponentLoader,
} from './web-ui-types.js';

export type {
  UiContextDimension,
  UiContextSnapshot,
  UiContextValueMap,
  UiNavigationLevel,
  UiNavigationLevelMap,
  UiRuntimeNavigationLevel,
  UiScope,
  UiScopeMap,
} from './ui-context-types.js';

export type { ExtensionWorkflowBlocksContribution } from './workflow-block-types.js';

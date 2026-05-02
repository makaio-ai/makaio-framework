import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioSessionEvent } from '../../session/types.js';
import type { SessionMessage } from '../../session/schemas/message.js';
import { SESSION_EVENT_TYPES } from '../../session/schemas/event.js';

/** Keyboard modifier flags for an action shortcut. */
export interface ActionShortcutModifiers {
  /** Meta/Command key. */
  meta?: boolean;
  /** Alt/Option key. */
  alt?: boolean;
  /** Shift key. */
  shift?: boolean;
  /** Control key. */
  ctrl?: boolean;
}

/** Full keyboard shortcut definition including modifiers and display metadata. */
export interface ActionShortcut extends ActionShortcutModifiers {
  /** Primary key character or name. */
  key: string;
  /** Human-readable label shown in keyboard shortcut hints. */
  label: string;
  /** Category grouping for the shortcut. */
  category: ActionCategory;
  /** Optional human-readable description. */
  description?: string;
  /** Whether the shortcut should not activate while focus is in an input field. */
  skipInInputs?: boolean;
  /** Optional context scope string or list of scopes. */
  context?: string | string[];
}

/**
 * Extension point for registering custom action categories.
 *
 * Extend via declaration merging from packages or UI layers.
 * @example
 * ```typescript
 * declare module '@makaio/contracts' {
 *   interface ActionCategoryMap {
 *     timeline: true;
 *   }
 * }
 * ```
 */
export interface ActionCategoryMap {
  /** Default category for uncategorized actions. */
  general: true;
}

type RegisteredActionCategory = keyof ActionCategoryMap & string;

/** Resolved action category type, extensible via {@link ActionCategoryMap} declaration merging. */
export type ActionCategory = RegisteredActionCategory;

/** Allowed message role values for event action entrypoints. */
export type MessageRole = 'user' | 'assistant';

/** Event filter that matches message events with optional role restriction. */
export interface MessageEventFilter {
  /** Discriminant: must be `'message'`. */
  eventType: 'message';
  /** Optional list of message roles this filter applies to. */
  messageRole?: MessageRole[];
}

/** All core session event types except `'message'`. */
type StructuralEventType = Exclude<(typeof SESSION_EVENT_TYPES)[number], 'message'>;

/** Event filter that matches structural (non-message) session events. */
export interface StructuralEventFilter {
  /** The specific structural event type to match. */
  eventType: StructuralEventType;
}

/** Union of message and structural event filters. */
export type EventFilter = MessageEventFilter | StructuralEventFilter;

/** Context passed to a session event action factory. */
export interface SessionEventActionContext {
  /** Bus instance for registering action handlers. */
  bus: IMakaioBus;
  /** Name of the extension registering the action. */
  extensionName: string;
  /**
   * Register one executable action with the owning session-event-action service.
   *
   * The service package owns the bus subjects and callback plumbing; extension
   * contributors receive this factory through the contribution context instead
   * of importing service implementation modules directly.
   * @param options - Action declaration and runtime callbacks.
   * @returns Serializable declaration plus unregister hook.
   */
  createAction: <TMode extends 'single' | 'multi', TRoles extends MessageRole[]>(
    options: SessionEventActionOptions<TMode, TRoles>,
  ) => CreateSessionEventActionResult;
}

/** Context passed to a session event action's `when` predicate. */
export interface WhenContext<TRoles extends MessageRole[] = MessageRole[]> {
  /** The message event that triggered the predicate check. */
  message: SessionMessage & { role: TRoles[number] };
  /** Active session identifier. */
  sessionId: string;
  /** Bus instance for runtime queries. */
  bus: IMakaioBus;
}

/** Context passed to a session event action's `onPickerOpen` callback. */
export interface PickerOpenContext<TRoles extends MessageRole[] = MessageRole[]> {
  /** Entrypoint information for the action. */
  entrypoint: {
    /** The message that was actioned. */
    messageId: string;
    /** Full message object. */
    message: SessionMessage & { role: TRoles[number] };
  };
  /** Active session identifier. */
  sessionId: string;
  /** Active project identifier. */
  projectId?: string;
  /** Bus instance for runtime queries. */
  bus: IMakaioBus;
}

/** Configuration returned by `onPickerOpen` to control the event picker UI. */
export interface PickerConfig {
  /** Event IDs that should be pre-selected when the picker opens. */
  preSelectedEventIds?: string[];
  /** Maximum number of events that can be selected. */
  maxSelections?: number;
  /** Custom title for the picker dialog. */
  title?: string;
}

/** Context passed to a session event action's `onSelectionChange` callback. */
export interface SelectionChangeContext {
  /** Currently selected session events. */
  selectedEvents: MakaioSessionEvent[];
  /** Entrypoint information for the action. */
  entrypoint: {
    /** The message that was actioned. */
    messageId: string;
    /** Full message object. */
    message: SessionMessage;
  };
  /** Active session identifier. */
  sessionId: string;
  /** Bus instance for runtime queries. */
  bus: IMakaioBus;
}

/** Feedback returned by `onSelectionChange` to inform the picker UI. */
export interface SelectionFeedback {
  /** Estimated token count for the selected events. */
  tokenEstimate?: number;
  /** Warning message to display in the picker. */
  warning?: string;
  /** Error message that blocks confirmation. */
  error?: string;
}

/** Context passed to a session event action's `onExecute` callback. */
export interface ExecuteContext<
  TMode extends 'single' | 'multi' = 'single' | 'multi',
  TRoles extends MessageRole[] = MessageRole[],
> {
  /** Entrypoint information for the action. */
  entrypoint: {
    /** The message that was actioned. */
    messageId: string;
    /** Full message object. */
    message: SessionMessage & { role: TRoles[number] };
  };
  /** Selected events when in multi-selection mode, otherwise `undefined`. */
  selectedEvents: TMode extends 'multi' ? MakaioSessionEvent[] : undefined;
  /** Active session identifier. */
  sessionId: string;
  /** Active project identifier. */
  projectId?: string;
  /** Bus instance for runtime queries. */
  bus: IMakaioBus;
}

/** Result returned by a session event action's `onExecute` callback. */
export interface ExecuteResult {
  /** Whether execution succeeded. */
  success: boolean;
  /** Human-readable error message when `success` is `false`. */
  error?: string;
}

/** Configuration for a session event action's message entrypoint. */
export interface EntrypointConfig<TRoles extends MessageRole[] = MessageRole[]> {
  /** Allowed message roles that can trigger this action. */
  messageRole: TRoles;
}

/** Full options for defining a session event action. */
export interface SessionEventActionOptions<
  TMode extends 'single' | 'multi' = 'single' | 'multi',
  TRoles extends MessageRole[] = MessageRole[],
> {
  /** Unique action identifier within the registering package. */
  id: string;
  /** Display label for the action. */
  label: string;
  /** Optional human-readable description. */
  description?: string;
  /** Optional icon identifier. */
  icon?: string;
  /** Message entrypoint configuration. */
  entrypoint: EntrypointConfig<TRoles>;
  /** Whether this action operates on a single event or multiple events. */
  selectionMode: TMode;
  /** Event type filters for multi-selection mode. */
  applicableTo?: TMode extends 'multi' ? EventFilter[] : never;
  /**
   * Optional predicate that determines whether the action is available.
   * @param ctx - Context with the triggering message.
   * @returns `true` when the action should be shown.
   */
  when?: (ctx: WhenContext<TRoles>) => Promise<boolean>;
  /**
   * Optional callback invoked when the event picker opens.
   * @param ctx - Context with entrypoint and session info.
   * @returns Picker configuration, `false` to cancel, or `void`.
   */
  onPickerOpen?: TMode extends 'multi'
    ? (ctx: PickerOpenContext<TRoles>) => Promise<PickerConfig | false | void>
    : never;
  /**
   * Optional callback invoked when the event selection changes.
   * @param ctx - Context with selected events.
   * @returns Selection feedback to display in the picker.
   */
  onSelectionChange?: TMode extends 'multi'
    ? (ctx: SelectionChangeContext) => Promise<SelectionFeedback | void>
    : never;
  /** Category grouping for this action. */
  category?: ActionCategory;
  /** Optional keyboard shortcut. */
  shortcut?: ActionShortcut;
  /**
   * Main execution callback invoked when the action is confirmed.
   * @param ctx - Context with entrypoint, selected events, and bus.
   * @returns Execution result, or `void` on success.
   */
  onExecute: (ctx: ExecuteContext<TMode, TRoles>) => Promise<ExecuteResult | void>;
}

/** Serializable declaration stored in registries and emitted over the bus. */
export interface SessionEventActionDeclaration {
  /** Unique action identifier. */
  id: string;
  /** Display label. */
  label: string;
  /** Optional description. */
  description?: string;
  /** Optional icon identifier. */
  icon?: string;
  /** Entrypoint configuration. */
  entrypoint: EntrypointConfig;
  /** Selection mode. */
  selectionMode: 'single' | 'multi';
  /** Event type filters (multi mode only). */
  applicableTo?: EventFilter[];
  /** Whether a `when` predicate was provided. */
  hasWhenPredicate: boolean;
  /** Whether an `onPickerOpen` callback was provided. */
  hasPickerOpenCallback: boolean;
  /** Whether an `onSelectionChange` callback was provided. */
  hasSelectionChangeCallback: boolean;
  /** Resolved action category. */
  category: ActionCategory;
  /** Optional keyboard shortcut. */
  shortcut?: ActionShortcut;
}

/** Return value from `createSessionEventAction` — declaration plus unregister hook. */
export interface CreateSessionEventActionResult {
  /** Serializable declaration for registry and bus publication. */
  declaration: SessionEventActionDeclaration;
  /** Unregisters the action and cleans up bus subscriptions. */
  unregister: () => void;
}

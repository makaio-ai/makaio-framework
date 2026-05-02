import type { ComponentType } from 'react';
import type { FormFieldProps } from '../../shared/ui-config.js';
import type { UiContextSnapshot } from './ui-context-types.js';

/**
 * Request context passed to a WebUI loader function.
 *
 * Provides visibility-aware context so loaders can filter data by the active
 * host UI context. URL params are forwarded from the route match so loaders can
 * access path segments and query strings.
 */
export interface LoaderContext {
  /**
   * Active session identifier, if a session is selected.
   *
   * `undefined` when no session is currently active.
   */
  sessionId?: string;
  /** Active host UI context for the matched route. */
  uiContext: UiContextSnapshot;
  /**
   * URL parameters from the matched route, including path segments and query
   * strings.
   *
   * Forwarded from the router so loaders can read route-specific identifiers.
   */
  params: Record<string, string>;
}

/**
 * Loader function that fetches data for a WebUI route.
 *
 * Receives a {@link LoaderContext} with active session, UI context, and URL
 * params so loaders can return visibility-appropriate data. The resolved data
 * is passed to the component as `loaderData`.
 * @typeParam TData - Type of data returned by the loader.
 * @param context - Request context with session, UI context, and URL params.
 * @returns Promise resolving to the loader data.
 */
export type MakaioWebUiLoader<TData = unknown> = (context: LoaderContext) => Promise<TData>;

/**
 * Action function that performs server-side operations.
 * @typeParam TData - Type of data returned by the action.
 * @typeParam TArgs - Tuple type of arguments accepted by the action.
 * @param args - Arguments passed to the action.
 * @returns Promise resolving to the action result.
 */
export type MakaioWebUiAction<TData = unknown, TArgs extends unknown[] = unknown[]> = (
  ...args: TArgs
) => Promise<TData>;

/**
 * Record of named actions available to a WebUI route.
 *
 * Each action can return different data types.
 */
export type MakaioWebUiActions = Record<string, MakaioWebUiAction<unknown, unknown[]>>;

/**
 * Transforms server-side action definitions into client-side Promise-based
 * executors.
 *
 * Used in component props to provide an async/await API for actions.
 * @typeParam TActions - The server-side action record shape.
 */
export type PromisifiedActions<TActions extends MakaioWebUiActions> = {
  [K in keyof TActions]: TActions[K] extends (...args: infer Args) => Promise<infer Result>
    ? (...args: Args) => Promise<Result>
    : never;
};

/**
 * Props passed to a WebUI component.
 *
 * Provides type-safe access to loader data, Promise-based action executors,
 * and the {@link LoaderContext} that was active when the loader ran.
 * @typeParam TLoaderData - Type of data returned by the loader.
 * @typeParam TActions - Record of available actions.
 */
export type MakaioWebUiComponentProps<
  TLoaderData = unknown,
  TActions extends MakaioWebUiActions = MakaioWebUiActions,
> = {
  /** Data resolved by the loader before the component was rendered. */
  loaderData: TLoaderData;
  /** Promisified action executors for mutating server-side state. */
  actions: TActions extends MakaioWebUiActions ? PromisifiedActions<TActions> : Record<string, never>;
  /** The loader context that was active when the loader ran. */
  loaderContext: LoaderContext;
};

/**
 * WebUI route definition for packages.
 *
 * Defines a route with path, optional loader/actions, and a lazy-loaded React
 * component. Provides full TypeScript inference for component props.
 * @typeParam TLoaderData - Type of data returned by the loader.
 * @typeParam TActions - Record of available actions (or `undefined` if none).
 */
export interface MakaioWebUiRoute<TLoaderData = unknown, TActions extends MakaioWebUiActions | undefined = undefined> {
  /** Route path relative to the package mount point. */
  path: string;
  /** Optional data loader. */
  loader?: MakaioWebUiLoader<TLoaderData>;
  /** Optional action handlers. */
  actions?: TActions;
  /**
   * Lazy component loader — called only browser-side.
   *
   * Must return a module with a default export of a React component that
   * accepts the inferred {@link MakaioWebUiComponentProps}.
   */
  component: () => Promise<{
    default: ComponentType<
      MakaioWebUiComponentProps<TLoaderData, TActions extends MakaioWebUiActions ? TActions : Record<string, never>>
    >;
  }>;
}

/**
 * Props for custom extension configuration components.
 *
 * When an extension provides `ui.configComponent`, the loaded component receives
 * these props to interact with the extension configuration system.
 * @typeParam TConfig - Extension configuration type.
 */
export interface ExtensionConfigComponentProps<TConfig = unknown> {
  /** Current configuration values. */
  config: TConfig;
  /**
   * Called when configuration values change.
   * @param config - Updated configuration.
   */
  onChange: (config: TConfig) => void;
  /** Called when the user confirms the save action. */
  onSave: () => Promise<void>;
  /** Whether a save is currently in progress. */
  isSaving: boolean;
  /** Validation errors keyed by field name. */
  errors?: Record<string, string>;
}

/**
 * Async loader for registering custom form field types.
 *
 * Must return a module with a default export of a React component that accepts
 * {@link FormFieldProps}.
 */
export type ExtensionFieldTypeLoader = () => Promise<{ default: ComponentType<FormFieldProps> }>;

/**
 * Async loader for a custom extension configuration component.
 *
 * Must return a module with a default export of a React component that accepts
 * {@link ExtensionConfigComponentProps}.
 * @typeParam TConfig - Extension configuration type.
 */
export type ExtensionConfigComponentLoader<TConfig = unknown> = () => Promise<{
  default: ComponentType<ExtensionConfigComponentProps<TConfig>>;
}>;

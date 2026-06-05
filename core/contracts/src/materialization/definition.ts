import type { SurfaceBindingRegistration } from './schemas.js';

/**
 * A surface binding definition with a serializable registration record.
 *
 * Created by {@link defineSurfaceBinding}. The definition retains the original
 * options and produces a bus-transportable {@link SurfaceBindingRegistration}
 * via `toRegistration()`.
 *
 * The interface is intentionally opaque: only `id` is exposed directly so
 * that callers have a stable, lightweight handle. All other properties are
 * accessible exclusively through `toRegistration()`, keeping the contract
 * aligned with the bus registration shape.
 */
export interface SurfaceBindingDefinition {
  /** Stable identifier for this surface binding (e.g. `'github.status.field'`). */
  readonly id: string;
  /**
   * Produces a serializable registration record suitable for bus transport.
   * @returns A {@link SurfaceBindingRegistration} snapshot with `target`
   *   deep-cloned and all array fields copied to prevent shared-reference
   *   mutation.
   */
  readonly toRegistration: () => SurfaceBindingRegistration;
}

/**
 * Options for {@link defineSurfaceBinding}.
 *
 * Structurally identical to {@link SurfaceBindingRegistration} — every field
 * is included in the serializable registration output.
 */
type DefineSurfaceBindingOptions = SurfaceBindingRegistration;

/**
 * Creates a surface binding definition with a serializable registration.
 *
 * The returned definition exposes the `id` identifier directly and produces
 * a bus-transportable {@link SurfaceBindingRegistration} via `toRegistration()`.
 * The `target` object is deep-cloned via `structuredClone` (consistent with
 * how {@link SurfaceBindingRegistry} clones at storage boundaries), and array
 * fields (`appliesTo`) are defensively copied so callers cannot mutate the
 * registration snapshot.
 * @param options - Surface binding registration options including provider,
 *   namespace, target, and entity classes the binding applies to.
 * @returns A {@link SurfaceBindingDefinition} with a `toRegistration` method.
 * @example
 * ```ts
 * export const githubStatusFieldBinding = defineSurfaceBinding({
 *   id: 'github.status.field',
 *   provider: 'github',
 *   namespace: 'status',
 *   target: { kind: 'field', name: 'Status' },
 *   appliesTo: ['workpiece'],
 *   valueMapping: { pending: 'In Progress', completed: 'Done' },
 * });
 * ```
 */
export function defineSurfaceBinding(options: DefineSurfaceBindingOptions): SurfaceBindingDefinition {
  return {
    id: options.id,
    toRegistration: (): SurfaceBindingRegistration => ({
      id: options.id,
      provider: options.provider,
      namespace: options.namespace,
      target: structuredClone(options.target),
      appliesTo: [...options.appliesTo],
      ...(options.valueMapping !== undefined ? { valueMapping: { ...options.valueMapping } } : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
    }),
  };
}

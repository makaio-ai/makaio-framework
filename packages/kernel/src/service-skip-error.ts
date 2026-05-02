/**
 * Thrown from a service factory to signal that the service intentionally opts
 * out of starting in the current runtime context (e.g. wrong role, disabled
 * feature flag).
 *
 * {@link ExtensionCoordinator} catches this error and routes the package to
 * the skipped list instead of the failed list, emitting
 * `kernel:boot.service.skipped` instead of `kernel:boot.service.failed`.
 *
 * **Contract:** Only valid for non-critical services.
 * Throwing `ServiceSkipError` from a critical service is treated as a real
 * failure to prevent silent startup holes.
 * @example
 * ```typescript
 * factory: async (ctx) => {
 *   const { config } = await ctx.bus.request(ConfigSubjects.get, {});
 *   if (config.role !== 'main-dev-machine') {
 *     throw new ServiceSkipError(`role=${String(config.role)}, expected main-dev-machine`);
 *   }
 *   return new CronTriggerEvaluator(ctx.bus);
 * }
 * ```
 */
export class ServiceSkipError extends Error {
  /**
   * Human-readable reason why the service chose to skip.
   * Included in the `service.skipped` bus event.
   */
  public readonly reason: string;

  /**
   * @param reason - Human-readable explanation for why the service is skipping
   */
  public constructor(reason: string) {
    super(reason);
    this.name = 'ServiceSkipError';
    this.reason = reason;
  }
}

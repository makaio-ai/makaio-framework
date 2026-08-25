import { removeProgramRoot, type ProgramRootLease } from './virtual-program-materializer.js';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// Tracks the temporary program roots a provider still owes a removal.
//
// A root is only ever unremovable for a reason that is expected to pass: an
// aborted invocation settles before its worker thread has finished exiting, and
// a file the program still holds open blocks unlink — reliably on Windows. The
// removal itself retries, but only briefly, because a settled outcome must
// never wait for a filesystem. When those attempts run out the root is still
// there, holding submitted source.
//
// Forgetting it at that point would leak it permanently and let repeated
// cancellations accumulate one root each. This turns it into outstanding work
// instead: it is retried opportunistically while the provider keeps running,
// and mandatorily when the provider is disposed — which is the moment the
// handle that blocked it is guaranteed to be gone, because every worker thread
// is down by then.

/**
 * Minimum interval between opportunistic re-attempts of the same stuck root, in milliseconds.
 *
 * A root that fails removal usually does so because a worker thread still holds an open file
 * handle. That condition is expected to clear on its own, but not necessarily within a single
 * invocation cycle. Re-attempting on every completion while the condition persists creates
 * O(N·R) background filesystem work (N completions × R stuck roots) against directories that
 * are failing for the same persistent reason. A per-root cooldown reduces that to one fresh
 * attempt every few seconds, while the mandatory dispose-time round via
 * {@link RetainedProgramRoots.retryAll} still tries every root unconditionally.
 */
export const OPPORTUNISTIC_RETRY_COOLDOWN_MS = 5_000;

/** Program roots whose removal failed and is therefore still owed. */
export class RetainedProgramRoots {
  /**
   * Retained roots mapped to the timestamp of their last removal attempt, in milliseconds
   * since the Unix epoch. A freshly retained root carries the timestamp of the attempt that
   * first failed; a root retried by {@link retry} carries the timestamp of that attempt
   * instead, updated each time it is not skipped by the cooldown.
   */
  private readonly roots = new Map<string, number>();

  /** One removal attempt per root; concurrent retry paths join its result. */
  private readonly attempts = new Map<string, Promise<boolean>>();

  /**
   * @param removeRoot - Removal function used for opportunistic and disposal retries.
   *   Defaults to {@link removeProgramRoot}. Pass a counting wrapper in tests to observe
   *   retry-attempt counts without reaching the filesystem.
   */
  public constructor(private readonly removeRoot: (root: string) => Promise<boolean> = removeProgramRoot) {}

  /**
   * Roots still owed a removal, in retention order.
   *
   * A snapshot: taking one before releasing an invocation is what lets a caller
   * retry the roots of *earlier* invocations without also repeating the
   * attempts that have only just run out for the current one.
   * @returns The retained roots at this instant.
   */
  public get pending(): readonly string[] {
    return [...this.roots.keys()];
  }

  /**
   * Remove one invocation's program root, retaining it when that fails.
   *
   * The failure is announced once, here, rather than on every later retry: it
   * marks the point at which the root became outstanding work, and repeating it
   * per attempt would turn a recoverable condition into log noise.
   * @param programRoot - Program root lease whose root is to be removed.
   * @returns Promise that resolves once the root is gone or retained.
   */
  public async release(programRoot: ProgramRootLease): Promise<void> {
    if (await this.attempt(programRoot.root, () => programRoot.cleanup())) return;
    console.warn('[code-execution] Retained a program root for a later removal attempt: %s', programRoot.root);
  }

  /**
   * Retry a snapshot of retained roots, skipping any root whose last removal attempt falls
   * within the {@link OPPORTUNISTIC_RETRY_COOLDOWN_MS} window.
   *
   * Bounded by construction: the removal's own retry policy is a few short attempts, so this
   * can never become the reason a disposal does not finish.
   * @param roots - Retained roots to attempt again.
   * @returns Promise that resolves once each eligible root has been retried.
   */
  public async retry(roots: readonly string[]): Promise<void> {
    const now = Date.now();
    await this.retryRoots(
      roots.filter((root) => {
        const lastAttempt = this.roots.get(root);
        return lastAttempt !== undefined && now - lastAttempt >= OPPORTUNISTIC_RETRY_COOLDOWN_MS;
      }),
    );
  }

  /**
   * Retry everything still retained and report what survived.
   *
   * Unlike the opportunistic {@link retry}, this path is unconditional: it bypasses the
   * {@link OPPORTUNISTIC_RETRY_COOLDOWN_MS} cooldown because it runs at dispose time, when
   * every worker thread is down and the handles that blocked earlier attempts are guaranteed
   * to be gone.
   * @returns The roots that are still on disk afterwards.
   */
  public async retryAll(): Promise<readonly string[]> {
    await this.retryRoots(this.pending);
    return this.pending;
  }

  /**
   * Attempt a selected set of retained roots in parallel.
   * @param roots - Retained roots selected by the caller's retry policy.
   * @returns Promise that resolves once every selected attempt has settled.
   */
  private async retryRoots(roots: readonly string[]): Promise<void> {
    await Promise.all(
      roots.filter((root) => this.roots.has(root)).map((root) => this.attempt(root, () => this.removeRoot(root))),
    );
  }

  /**
   * Run one removal attempt and update the retained set from its answer.
   *
   * Never throws. A removal that rejects is treated exactly like one that
   * reported failure — the root is still on disk either way, and losing track of
   * it would be the worse answer.
   * @param root - Absolute program root the attempt targets.
   * @param remove - Removal to attempt; resolves to whether the root is gone.
   * @returns Whether the root is gone.
   */
  private async attempt(root: string, remove: () => Promise<boolean>): Promise<boolean> {
    const active = this.attempts.get(root);
    if (active !== undefined) return active;

    const attempt = this.runAttempt(root, remove);
    this.attempts.set(root, attempt);
    try {
      return await attempt;
    } finally {
      if (this.attempts.get(root) === attempt) this.attempts.delete(root);
    }
  }

  /**
   * Execute the sole active removal attempt for one root.
   * @param root - Absolute program root the attempt targets.
   * @param remove - Removal to attempt; resolves to whether the root is gone.
   * @returns Whether the root is gone.
   */
  private async runAttempt(root: string, remove: () => Promise<boolean>): Promise<boolean> {
    let removed = false;
    try {
      removed = await remove();
    } catch (error) {
      console.warn('[code-execution] Failed to release a program root: %s', error);
    }
    if (removed) this.roots.delete(root);
    else this.roots.set(root, Date.now());
    return removed;
  }
}

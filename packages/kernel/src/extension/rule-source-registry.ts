import type { RuleSourceContribution, RulesCapability, RulesTriggerReader } from '@makaio/contracts/rules';
import { jsonEquals } from '@makaio/contracts/shared';
import { type ExtensionName, ownsCanonicalContributionName } from '@makaio/core';

/** Independent release handle for a single source registration. */
type SourceLease = {
  release(): void;
};

/** One source registration owned by a specific extension activation. */
type SourceRegistration = {
  readonly owner: ExtensionName;
  readonly lifetime: AbortSignal;
  readonly contribution: RuleSourceContribution;
  readonly lease: SourceLease;
  readonly unsubscribe: () => void;
};

/**
 * Compare trigger snapshots by value, including repeated declarations.
 * @param previous - The last published snapshot.
 * @param next - The newly read snapshot, in any order.
 * @returns Whether both snapshots contain the same trigger declarations.
 */
function sameTriggers(previous: ReturnType<RulesTriggerReader['current']>, next: typeof previous): boolean {
  if (previous.length !== next.length) return false;
  const unmatched = [...previous];
  return next.every((trigger) => {
    const index = unmatched.findIndex((candidate) => jsonEquals(candidate, trigger));
    if (index === -1) return false;
    unmatched.splice(index, 1);
    return true;
  });
}

/** Single-slot registry for the host's rule source and its trigger readers. */
export class RuleSourceRegistry {
  /** Single source and its upstream subscription. */
  private current: SourceRegistration | undefined;

  /** Refresh callbacks and their lifetime cleanup, independent of the source's lifetime. */
  private readonly readers = new Map<() => void, () => void>();

  /** @param validate - Host validator, when this composition provides rule evaluation. */
  public constructor(private readonly validate?: RulesCapability['validate']) {}

  /**
   * Installs the declared rule source for a live activation.
   * The kernel generation owns both the registration and its removal.
   * @param owner - The extension declaring the source.
   * @param contribution - The complete source contribution.
   * @param lifetime - The kernel's per-activation signal for this identity.
   * @returns An idempotent handle that releases this registration only.
   * @throws If the activation has ended or another live activation owns the source.
   */
  public register(owner: ExtensionName, contribution: RuleSourceContribution, lifetime: AbortSignal): SourceLease {
    lifetime.throwIfAborted();
    const previous = this.current;
    if (previous !== undefined && !previous.lifetime.aborted) {
      throw new Error(
        `Rule source is already registered by extension '${previous.owner}'; ` +
          `extension '${owner}' cannot register a second one`,
      );
    }

    const lease: SourceLease = {
      release: () => {
        const current = this.current;
        if (current?.lease !== lease) return;
        this.current = undefined;
        this.releaseSource(current);
      },
    };
    const unsubscribe = contribution.onTriggersChanged(() => {
      if (this.current?.lease === lease) this.refreshReaders();
    });
    // The upstream can run synchronous code while installing the listener.
    if (lifetime.aborted || this.current !== previous) {
      unsubscribe();
      lifetime.throwIfAborted();
      throw new Error('Rule source changed while a subscription was being installed');
    }
    // Listen on a private signal so other listeners cannot stop propagation to this cleanup.
    const cleanupSignal = AbortSignal.any([lifetime]);
    cleanupSignal.addEventListener('abort', lease.release, { once: true });
    this.current = {
      owner,
      lifetime,
      contribution,
      lease,
      unsubscribe: () => {
        cleanupSignal.removeEventListener('abort', lease.release);
        unsubscribe();
      },
    };
    this.releaseSource(previous);
    return lease;
  }

  /**
   * Withdraws the source before its service is destroyed, without ending the
   * other capabilities of the activation.
   * @param lifetime - Generation of the activation being stopped.
   */
  public release(lifetime: AbortSignal): void {
    const current = this.current;
    if (current?.lifetime === lifetime) current.lease.release();
  }

  /**
   * Resolves the rule source.
   * @returns The complete registered contribution, if present.
   */
  public get(): RuleSourceContribution | undefined {
    return this.current?.lifetime.aborted ? undefined : this.current?.contribution;
  }

  /**
   * Creates a live view of the trigger kinds owned by an extension.
   * @param owner - The extension reading its own trigger kinds.
   * @param lifetime - The signal for this extension's activation.
   * @returns A trigger reader that stops reading and listening when the activation ends.
   */
  public triggersFor(owner: ExtensionName, lifetime: AbortSignal): RulesTriggerReader {
    const current = (): ReturnType<RulesTriggerReader['current']> =>
      lifetime.aborted
        ? []
        : structuredClone(
            this.get()
              ?.ruleTriggers()
              .filter((trigger) => ownsCanonicalContributionName(owner, trigger.kind)) ?? [],
          );

    return {
      current,
      onChange: (listener) => this.subscribe(current, lifetime, listener),
    };
  }

  /**
   * Binds the rule capability to an activation.
   * @param owner - Extension receiving the capability.
   * @param lifetime - The kernel's generation signal.
   * @returns Rule operations for that generation.
   */
  public capabilityFor(owner: ExtensionName, lifetime: AbortSignal): RulesCapability {
    return {
      validate: async (input) => {
        lifetime.throwIfAborted();
        if (!this.validate) throw new Error('Rule-set validation is unavailable on this host');
        const findings = await this.validate(input);
        lifetime.throwIfAborted();
        return findings;
      },
      triggers: () => this.triggersFor(owner, lifetime),
    };
  }

  /**
   * Tracks the filtered snapshot for one listener across source changes.
   * @param current - Reads the extension's current trigger snapshot.
   * @param lifetime - The extension's activation lifetime.
   * @param listener - Receives notifications when the snapshot changes.
   * @returns An idempotent unsubscribe function.
   */
  private subscribe(current: RulesTriggerReader['current'], lifetime: AbortSignal, listener: () => void): () => void {
    if (lifetime.aborted) return () => {};
    let snapshot = current();
    if (lifetime.aborted) return () => {};
    const cleanupSignal = AbortSignal.any([lifetime]);
    const refresh = (): void => {
      const next = current();
      if (lifetime.aborted || sameTriggers(snapshot, next)) return;
      snapshot = next;
      listener();
    };
    const unsubscribe = (): void => {
      this.readers.delete(refresh);
      cleanupSignal.removeEventListener('abort', unsubscribe);
    };
    cleanupSignal.addEventListener('abort', unsubscribe, { once: true });
    this.readers.set(refresh, unsubscribe);
    return unsubscribe;
  }

  /**
   * Detaches the old upstream subscription and publishes the new view.
   * @param previous - The outgoing source registration, when present.
   */
  private releaseSource(previous: typeof this.current): void {
    try {
      previous?.unsubscribe();
    } catch (error) {
      console.error('[RuleSourceRegistry] Failed to unsubscribe from the rule source:', error);
    }
    this.refreshReaders();
  }

  /** Refreshes live readers independently so a failing listener cannot interrupt the source lifecycle. */
  private refreshReaders(): void {
    for (const refresh of [...this.readers.keys()]) {
      if (!this.readers.has(refresh)) continue;
      try {
        refresh();
      } catch (error) {
        console.error('[RuleSourceRegistry] Failed to refresh a trigger reader:', error);
      }
    }
  }
}

import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';

/**
 * Create the default native-session detector used by log importers.
 * @returns Function that checks whether an adapter session belongs to a native Makaio session
 */
export function createDefaultCheckMakaioManaged(): (sessionId: string) => Promise<boolean> {
  return async (adapterSessionId: string): Promise<boolean> => {
    try {
      const result = await MakaioBus.request(SessionSubjects.getByAdapterSessionId, {
        adapterSessionId,
      });
      return result.session !== null && !result.session.isImported;
    } catch {
      return false;
    }
  };
}

/**
 * Caches and deduplicates Makaio-managed session checks per adapter session.
 */
export class MakaioManagedSessionCache {
  private readonly checkedSessions = new Map<string, boolean>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  /**
   * Check whether an adapter session should be skipped, reusing in-flight work.
   * @param adapterSessionId - External adapter session identifier
   * @param checkMakaioManaged - Detector function for native Makaio sessions
   * @param onSkipped - Callback invoked when the session should be skipped
   * @returns Promise resolving to true when the session should be skipped
   */
  public async isSkipped(
    adapterSessionId: string,
    checkMakaioManaged: (adapterSessionId: string) => Promise<boolean>,
    onSkipped: (adapterSessionId: string) => void,
  ): Promise<boolean> {
    const cached = this.checkedSessions.get(adapterSessionId);
    if (cached !== undefined) {
      return cached;
    }

    let pending = this.inFlight.get(adapterSessionId);
    if (!pending) {
      pending = checkMakaioManaged(adapterSessionId)
        .then((isManaged) => {
          this.checkedSessions.set(adapterSessionId, isManaged);
          if (isManaged) {
            onSkipped(adapterSessionId);
          }
          return isManaged;
        })
        .finally(() => {
          this.inFlight.delete(adapterSessionId);
        });
      this.inFlight.set(adapterSessionId, pending);
    }

    return pending;
  }

  /** Clear cached and in-flight session checks. */
  public clear(): void {
    this.checkedSessions.clear();
    this.inFlight.clear();
  }
}

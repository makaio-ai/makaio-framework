import type { HostDatabase } from '@makaio/contracts';
import type { ReaderContribution } from '@makaio/contracts/journal';
import { MAKAIO_RULES_PARTY_KIND } from '@makaio/core';
import { getHostDatabaseWake } from '@makaio/storage-drizzle';
import type { RuleEvaluator } from './rule-evaluator.js';
import { retryDelay } from './storage/decision-store.js';
import { deferFailedRuleWork, nextRuleWork } from './storage/next-rule-work.js';
import { RULE_OCCASION_WAKE_TOPIC, storeRuleOccasion } from './storage/store-occasion.js';

/**
 * Create the built-in reader that pins effective rules with journal progress.
 * @param evaluator - Supplies the evaluator once contributions have started.
 * @returns The host's journal reader.
 */
export function createRuleJournalReader(evaluator: () => RuleEvaluator | undefined): ReaderContribution {
  return {
    reader: MAKAIO_RULES_PARTY_KIND,
    description: 'Prepare rule evaluations for recorded events',
    startAt: 'beginning',
    subjects: () => ['*'],
    async handle(_call, { entryId, position, subject, origin, payload }) {
      const active = evaluator();
      if (!active) return { state: 'retry', reason: 'rule-source-unavailable' };
      const prepared = await active.prepare({
        id: entryId,
        event: { cause: { entryId, position }, subject, origin, facts: {} },
        payload,
      });
      if (prepared.state === 'source-unavailable') return { state: 'retry', reason: 'rule-source-unavailable' };
      if (prepared.state === 'no-match') return { state: 'done' };
      return {
        state: 'done',
        async commit(tx) {
          await storeRuleOccasion(tx, prepared.work);
        },
      };
    },
  };
}

/**
 * Recover committed occasions at startup, on database wakes, and when durable work becomes due.
 * @param database - Database shared with the journal reader.
 * @param evaluator - Host evaluator for committed occasions.
 * @returns Teardown that stops selection and drains the active evaluation.
 */
export function startRuleJournalEvaluation(
  database: HostDatabase,
  evaluator: Pick<RuleEvaluator, 'evaluate'>,
): () => Promise<void> {
  const stop = new AbortController();
  const wakeSource = getHostDatabaseWake(database);
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  /** Rescan once current work yields. */
  function wake(): void {
    if (stop.signal.aborted) return;
    pending = true;
    clearTimeout(timer);
    running ??= drain()
      .catch(() => {
        console.error('[Rules] Journal evaluation failed');
        schedule(Date.now() + retryDelay(1));
      })
      .finally(() => {
        running = undefined;
        if (pending) wake();
      });
  }

  /** Select durable work again after each completed evaluation. */
  async function drain(): Promise<void> {
    pending = false;
    while (!stop.signal.aborted) {
      const next = await nextRuleWork(database);
      if (stop.signal.aborted || next === undefined) return;
      if (next.due > Date.now()) {
        schedule(next.due);
        return;
      }
      try {
        await evaluator.evaluate(next.id, stop.signal);
      } catch {
        if (stop.signal.aborted) return;
        console.error('[Rules] Journal occasion evaluation failed');
        await deferFailedRuleWork(database, next.id, Date.now());
      }
    }
  }

  /** @param at - Earliest due time in epoch milliseconds. */
  function schedule(at: number): void {
    if (!stop.signal.aborted) timer = setTimeout(wake, Math.max(0, at - Date.now()));
  }

  // New occasions wake peers here. A peer waiting on a claimed decision or reaction
  // rescans at the stored deadline or on resync, even if the claiming host exits after settling.
  const unsubscribe = wakeSource.subscribe(RULE_OCCASION_WAKE_TOPIC, wake);
  const unsubscribeResync = wakeSource.onResync(wake);
  void wakeSource.ready().then(wake, () => console.error('[Rules] Database wake unavailable'));
  wake();
  return async () => {
    stop.abort();
    unsubscribe();
    unsubscribeResync();
    clearTimeout(timer);
    await running;
  };
}

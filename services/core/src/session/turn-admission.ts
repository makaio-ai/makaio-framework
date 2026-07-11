import type { TurnCompletionResult } from './turn-completion.js';
import type {
  PreparedTurnMessageAdmissionLease,
  TurnMessageAdmissionLease,
  TurnPreparationLease,
} from './turn-slot-registry.js';

/** Lifecycle hooks owned by SessionTurnManager around one prepared admission. */
export interface TurnAdmissionHooks {
  completePreparation(lease: TurnPreparationLease): void;
  failPreparation(lease: TurnPreparationLease, error: Error): void;
  beginSetupFailure(admission: TurnMessageAdmissionLease, result: TurnCompletionResult): void;
  finalizeSetupFailure(admission: TurnMessageAdmissionLease, result: TurnCompletionResult): Promise<void>;
  finalizeCompletedLedger(admission: TurnMessageAdmissionLease, result: TurnCompletionResult): Promise<void>;
}

/**
 * Compose atomic message admission with the turn's one-time preparation gate.
 * @param admission - Pair-ledger admission created while the turn is routable.
 * @param preparation - First-message owner lease or an already-prepared joiner lease.
 * @param hooks - Manager-owned state transitions around preparation and finalization.
 * @returns Admission lease whose commit and rollback preserve preparation ordering.
 */
export function composePreparedTurnAdmission(
  admission: TurnMessageAdmissionLease,
  preparation: TurnPreparationLease,
  hooks: TurnAdmissionHooks,
): PreparedTurnMessageAdmissionLease {
  return {
    ...admission,
    isPreparationOwner: preparation.isOwner,
    commit: () => {
      admission.commit();
      if (preparation.isOwner) hooks.completePreparation(preparation);
    },
    rollback: async (errorCode = `message-setup-failed:${admission.messageId}`) => {
      const rollback = admission.rollback();
      if (preparation.isOwner) {
        const result = { success: false, errors: [errorCode] };
        hooks.beginSetupFailure(admission, result);
        hooks.failPreparation(preparation, new Error(`Message ${admission.messageId} setup failed`));
        await rollback;
        await hooks.finalizeSetupFailure(admission, result);
        return;
      }
      await rollback;
      if (admission.turn.isComplete()) {
        await hooks.finalizeCompletedLedger(admission, admission.turn.getResult());
      }
    },
  };
}

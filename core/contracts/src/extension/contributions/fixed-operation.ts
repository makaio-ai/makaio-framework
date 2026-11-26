import type { OwnerQuiescence, ProcessLaunchOptions, SiteLaunchResult } from '@makaio/core';
import type { JsonValue } from '../../shared/json-value.js';
import type { WorkflowRunResult } from '../../workflow/index.js';

/** Runtime phases during which a worker can invoke a contributed operation. */
export type FixedOperationPhase = 'workflow-source' | 'before-steps' | 'after-steps';

/** JSON facts are isolated to the contributing extension. */
export type FixedOperationFacts = Readonly<Record<string, JsonValue>>;

/** One operation's ports, scoped to its run and owner. */
export interface FixedOperationContext {
  readonly declaration: JsonValue;
  readonly block: JsonValue | undefined;
  readonly facts: FixedOperationFacts;
  readonly workspace: string;
  /** Run-owned directory available for preparing a checkout outside the step workspace. */
  readonly sourceDirectory: string;
  readonly workflowRoot?: string;
  /** Verified checkout for the resolver and source-bound follow-ups. */
  readonly verifiedSource?: {
    readonly checkoutRoot: string;
    readonly checkoutId: string;
    readonly revision: string;
  };
  readonly quiescence?: OwnerQuiescence;
  readonly stepStatus?: WorkflowRunResult['status'] | 'not-started';
  readonly definitions: (kind: string, ids?: readonly string[]) => Promise<readonly JsonValue[]>;
  readonly launch: (request: Omit<ProcessLaunchOptions, 'stdin'>) => { readonly result: Promise<SiteLaunchResult> };
  readonly addresses: {
    readonly open: (purpose: string) => Promise<string>;
    readonly close: (purpose: string) => Promise<void>;
  };
  readonly signal: AbortSignal;
}

export type FixedOperationOutcome =
  | { readonly ok: true; readonly facts: FixedOperationFacts; readonly workflowRoot?: string }
  | { readonly ok: false; readonly facts: FixedOperationFacts; readonly detail: string };

/** An operation contributed under a name qualified by its owning extension. */
export interface FixedOperationContribution {
  readonly name: string;
  readonly phase: FixedOperationPhase;
  /** Require the verified checkout for an after-steps operation outside the source provider or resolver. */
  readonly requiresVerifiedSource?: true;
  /** Synchronous, side-effect-free selection against the admitted declaration. An explicitly named resolver skips selection. */
  readonly applies: (declaration: JsonValue) => boolean;
  readonly run: (context: FixedOperationContext) => Promise<FixedOperationOutcome>;
}

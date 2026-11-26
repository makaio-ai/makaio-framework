/** A step execution or a fixed operation owned by the worker. */
export type ProcessOwner =
  | { readonly kind: 'step'; readonly stepId: string; readonly execution: number }
  | { readonly kind: 'runtime'; readonly operation: string };

/** A command resolved within the selected execution site. */
export interface ProcessLaunchOptions {
  readonly command: string;
  readonly args?: readonly string[];
  /** Directory relative to the site's workspace. */
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdin?: 'none' | 'pipe';
  readonly output: { readonly kind: 'ignore' } | { readonly kind: 'capture'; readonly limitBytes: number };
}

/** A launch request with the owner and cancellation chosen by the execution site caller. */
export interface OwnerLaunchOptions extends ProcessLaunchOptions {
  readonly owner: ProcessOwner;
  readonly signal?: AbortSignal;
}

/** Extent of the site isolation verified by the site. Machine includes containers and virtual machines. */
export type ContainmentBoundary = 'process-group' | 'user' | 'machine';

/** A quiescence claim is scoped to the selected site's containment boundary. */
export type OwnerQuiescence =
  | { readonly kind: 'quiescent'; readonly boundary: ContainmentBoundary }
  | {
      readonly kind: 'unproven';
      readonly boundary: ContainmentBoundary;
      readonly reason: 'members-remain' | 'observation-unavailable' | 'termination-unconfirmed';
    };

export type SiteLaunchRefusal =
  | 'invalid-timeout'
  | 'invalid-output-limit'
  | 'command-not-found'
  | 'spawn-error'
  | 'unsupported-site'
  | 'invalid-owner'
  | 'owner-closed'
  | 'cwd-outside-workspace'
  | 'reserved-entry'
  | 'home-unavailable';

export type SiteLaunchStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'output-limit'
  | 'spawn-failed'
  | 'stop-failed';

/** Status and containment evidence returned by an execution site. */
export type SiteProcessOutcome = {
  readonly exitCode?: number;
  readonly containment?: OwnerQuiescence;
  readonly refusal?: SiteLaunchRefusal;
} & (
  | {
      readonly status: 'cancelled';
      /** Owner shutdown, or cancellation through the request's signal. */
      readonly cancellationSource: 'owner' | 'request';
    }
  | { readonly status: Exclude<SiteLaunchStatus, 'cancelled'>; readonly cancellationSource?: never }
);

/** Terminal outcome with optional captured output. */
export type SiteLaunchResult = SiteProcessOutcome & {
  readonly output?: { readonly stdout: string; readonly stderr: string };
};

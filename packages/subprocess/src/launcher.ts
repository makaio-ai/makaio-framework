import type { ReadableStream, WritableStream } from 'node:stream/web';

/** A step execution or a fixed operation owned by the worker. */
export type ProcessOwner =
  | { readonly kind: 'step'; readonly stepId: string; readonly execution: number }
  | { readonly kind: 'runtime'; readonly operation: string };

/** A command resolved within the selected execution site. */
export interface OwnerLaunchOptions {
  readonly owner: ProcessOwner;
  readonly command: string;
  readonly args?: readonly string[];
  /** Directory relative to the site's workspace. */
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly stdin?: 'none' | 'pipe';
  readonly output: { readonly kind: 'ignore' } | { readonly kind: 'capture'; readonly limitBytes: number };
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

/** Execution-site handle. The site owns process identifiers and stop mechanics. */
export interface ExecutionSiteHandle {
  readonly result: Promise<SiteLaunchResult>;
  readonly stdin?: WritableStream<Uint8Array>;
  readonly stdout?: ReadableStream<Uint8Array>;
  readonly stderr?: ReadableStream<Uint8Array>;
}

/** Worker-facing process lifecycle at an execution site. */
export interface Launcher {
  readonly boundary: ContainmentBoundary;
  launch(options: OwnerLaunchOptions): ExecutionSiteHandle;
  closeOwner(owner: ProcessOwner): Promise<OwnerQuiescence>;
  /** Close all step owners; fixed runtime operations remain available. */
  closeAll(): Promise<OwnerQuiescence>;
}

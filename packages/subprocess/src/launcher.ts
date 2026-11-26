import type { ReadableStream, WritableStream } from 'node:stream/web';

import type {
  ContainmentBoundary,
  OwnerLaunchOptions,
  OwnerQuiescence,
  ProcessOwner,
  SiteLaunchResult,
} from '@makaio/core';

export type {
  ContainmentBoundary,
  OwnerLaunchOptions,
  OwnerQuiescence,
  ProcessOwner,
  SiteLaunchRefusal,
  SiteLaunchResult,
  SiteLaunchStatus,
  SiteProcessOutcome,
} from '@makaio/core';

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

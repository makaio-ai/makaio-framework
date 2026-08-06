/**
 * The lifecycle behaviour both connector doubles in this package are configured
 * with.
 *
 * There are two doubles because there are two layers to drive: the agent tests
 * hold a `Partial<AIAgentConnector>` they hand to a factory, the adapter tests
 * hold a real `AIAgentConnector` subclass the adapter constructs. Their *state
 * machines* are the same one, though — a close that counts itself, honours a gate
 * and then either reports a class or raises a failure; an initialize that honours
 * a gate and then either returns or rolls back. Two copies of that is how two
 * suites end up disagreeing about what a failing close looks like, which is
 * exactly the thing the teardown taxonomy is asserted through.
 * @packageDocumentation
 */
import type { ConnectorTeardownResult } from '@makaio/contracts';

/** Close behaviour a test configures on a connector double. */
export interface ConfiguredClose {
  /**
   * How many times this generation's close ran.
   *
   * A count rather than a flag because a boolean cannot express single-flight:
   * "one close" and "two closes of the same connector" are both `true`.
   */
  closeCount: number;
  /**
   * What this connector's teardown reports, or the failure it raises instead.
   *
   * Defaults to `released` on both doubles, which is what they are: they hold no
   * process and no subscription, so nothing can still be speaking once close has
   * run. An `Error` makes the close **throw**, which the layer above reports as
   * `unknown`. One field for both outcomes, because a close either reports or
   * fails and there is no third thing to model.
   */
  closeOutcome: ConnectorTeardownResult | Error;
  /** Held until the test releases it, so a second caller arrives mid-teardown. */
  closeGate: Promise<void> | undefined;
}

/** Initialization behaviour a test configures on a connector double. */
export interface ConfiguredInitialize {
  /** Held until released, so a replacement is provably still in flight. */
  initializeGate: Promise<void> | undefined;
  /** Raised by `initialize()`, so a replacement provably rolls back. */
  initializeFailure: Error | undefined;
}

/**
 * Run the close the test configured, counting it first.
 *
 * The count is taken **before** the gate is awaited: a test that holds a close
 * open asserts that a second caller found the first one already in flight, and a
 * count incremented after the gate could not tell that from two sequential
 * closes.
 * @param state - The double whose close behaviour is being run.
 * @returns The configured teardown result.
 * @throws The configured failure, when one was configured instead of a result.
 */
export async function runConfiguredClose(state: ConfiguredClose): Promise<ConnectorTeardownResult> {
  state.closeCount += 1;
  await state.closeGate;
  if (state.closeOutcome instanceof Error) throw state.closeOutcome;
  return state.closeOutcome;
}

/**
 * Run the initialization the test configured.
 *
 * Real connectors set their adapter session ID here, which is why it is the one
 * step every replacement runs and therefore the one a test can hold open or fail.
 * @param state - The double whose initialization behaviour is being run.
 * @throws The configured failure, when one was configured.
 */
export async function runConfiguredInitialize(state: ConfiguredInitialize): Promise<void> {
  await state.initializeGate;
  if (state.initializeFailure !== undefined) throw state.initializeFailure;
}

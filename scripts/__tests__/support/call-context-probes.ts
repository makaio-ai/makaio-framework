/**
 * Shared probes of the call-context guard tests.
 *
 * The guard is five rules: `no-own-call-in-handler`, `no-held-call`, `no-kernel-api-import`,
 * `no-process-bus-import` and `no-own-alias`. A test lints each probe through a real ESLint run, as the
 * process-start guard's tests do (see `process-start-probes.ts`, whose linter driver is reused here), so a rule that
 * is present but not mounted, or mounted at paths that resolve nowhere, fails the test.
 *
 * Every probe is a source string that is linted as if it sat at a given path; the files need not exist. The
 * framework config's test and the root config's test import the same probes, so the two stay the same cases. The
 * paths are written relative to the repository layer a config is rooted at; {@link probePath} puts the prefix of
 * the config under test in front.
 */
import { frameworkRoot, lintProbe } from './process-start-probes';

export { frameworkRoot, lintProbe };

/** The names of the five rules of the call-context guard, as the rule files are named. */
export const CALL_CONTEXT_RULES = [
  'no-own-call-in-handler',
  'no-held-call',
  'no-kernel-api-import',
  'no-process-bus-import',
  'no-own-alias',
] as const;

/** One of the five rule names. */
export type CallContextRuleName = (typeof CALL_CONTEXT_RULES)[number];

/** A probe: what it shows, and the source that is linted. */
export type CallContextProbe = readonly [label: string, source: string];

/**
 * Whether a reported rule ID is the given rule of the guard. The plugin namespace the guard mounts the rules under
 * is the mounting config's choice, so the ID is matched by the rule name after the namespace.
 * @param ruleId - Rule ID of one lint message.
 * @param rule - The rule name to look for.
 * @returns True when the message belongs to the rule.
 */
export function isReportOf(ruleId: string | null, rule: CallContextRuleName): boolean {
  return ruleId !== null && (ruleId === rule || ruleId.endsWith(`/${rule}`));
}

/**
 * Lint one probe and tell whether the given rule reported on it.
 * @param cwd - Directory ESLint runs in; its `eslint.config.mjs` is the config under test.
 * @param rule - The rule whose report is looked for.
 * @param source - Probe source to lint.
 * @param relativePath - Path the probe is linted as, from `cwd`.
 * @returns True when the rule reported at least once.
 */
export async function reportsRule(
  cwd: string,
  rule: CallContextRuleName,
  source: string,
  relativePath: string,
): Promise<boolean> {
  const ruleIds = await lintProbe(cwd, source, relativePath);
  return ruleIds.some((ruleId) => isReportOf(ruleId, rule));
}

/**
 * Put the prefix of the config under test in front of a probe path.
 * @param prefix - Directory of the config's root below the repository root: `''` for the framework config,
 *   `'framework'` or `'product'` for the root config, which lints both trees.
 * @param path - A probe path from {@link PROBE_PATHS}, relative to the layer.
 * @returns The path to lint the probe as, from the config's directory.
 */
export function probePath(prefix: string, path: string): string {
  return prefix === '' ? path : `${prefix}/${path}`;
}

/** Paths (relative to a layer) the path-sensitive rules are probed at. */
export const PROBE_PATHS = {
  /** An arbitrary extension source: no name of the kernel and no process-wide bus is allowed here. */
  extensionSource: 'extensions/zz-call-context-probe/src/zz-guard-probe.ts',
  /** A test file in an extension path: a named root, never reported. */
  extensionTest: 'extensions/zz-call-context-probe/src/__tests__/zz-guard-probe.test.ts',
  /** A source in the kernel: the kernel names are allowed here. */
  kernelSource: 'core/bus-core/src/zz-guard-probe.ts',
  /** A source of a composition root where the process-wide bus is allowed. */
  applicationSource: 'apps/zz-call-context-probe/src/zz-guard-probe.ts',
  /** A source of the test utilities: both the kernel names and the process-wide bus are allowed. */
  testUtilsSource: 'packages/test-utils/src/zz-guard-probe.ts',
  /** A source of a transport: raw `BusTransport.send` is allowed. */
  transportSource: 'transports/zz-call-context-probe/src/zz-guard-probe.ts',
} as const;

/** Handler-body probes: `.own(...)` inside a function that handles a message is refused. */
export const OWN_IN_HANDLER_PROBES: readonly CallContextProbe[] = [
  ['an `.on` handler', "bus.on('a.b', async (payload, ctx) => { await bus.emit(bus.own('x'), 'c.d', payload); });"],
  ['a `registerHandler` handler', "registerHandler(S, async () => { bus.own('x'); });"],
  ['an `.intercept` handler', "bus.intercept('a.b', async () => { bus.own('x'); });"],
  ['a function with a typed context', "export function handle(ctx: RequestContext) { return ctx.bus.own('x'); }"],
];

/** Handler-body probes that are fine: the handler sends with `ctx.call`, or `.own(...)` sits outside a handler. */
export const OWN_OUTSIDE_HANDLER_PROBES: readonly CallContextProbe[] = [
  [
    'a handler that sends with ctx.call',
    "bus.on('a.b', async (payload, ctx) => { await bus.emit(ctx.call, 'c.d', payload); });",
  ],
  ['a start routine', "export async function start(bus: Bus) { await bus.emit(bus.own('start'), 'a.b', {}); }"],
];

/** Held-call probes: a field or module variable that keeps a call context is refused. */
export const HELD_CALL_PROBES: readonly CallContextProbe[] = [
  ['a service field typed CallContext', 'export class Service { private call: CallContext; }'],
  ['a constructor parameter property', 'export class Service { constructor(private readonly call: CallContext) {} }'],
  [
    'an assignment of ctx.call to a field',
    'export class Service { held = null; keep(ctx: Ctx) { this.held = ctx.call; } }',
  ],
  ['a module variable', "export const held = bus.own('x');"],
  ['a mutable call in a holder type', 'export class MessageHandle { call: CallContext; }'],
];

/** Held-call probes that are fine: the one-operation holders with a `readonly call`. */
export const HELD_CALL_ALLOWED_PROBES: readonly CallContextProbe[] = [
  ['a readonly call in MessageHandle', 'export class MessageHandle { readonly call: CallContext; }'],
  ['a readonly call in ProceduralTurnConfig', 'export interface ProceduralTurnConfig { readonly call: CallContext; }'],
];

/** Kernel-name probes: an import of a kernel name outside the allowed paths is refused. */
export const KERNEL_NAME_PROBES: readonly CallContextProbe[] = [
  [
    'mintCallContext',
    "import { mintCallContext } from '@makaio/bus-core/kernel-api';\nexport const probe = mintCallContext;",
  ],
  [
    'callFromReceive',
    "import { callFromReceive } from '@makaio/bus-core/kernel-api';\nexport const probe = callFromReceive;",
  ],
];

/** A kernel-name import that is fine where the kernel names are allowed. */
export const KERNEL_NAME_SOURCE = KERNEL_NAME_PROBES[0][1];

/** Process-bus probes: the process-wide bus or a fresh instance, imported by an extension, is refused. */
export const PROCESS_BUS_PROBES: readonly CallContextProbe[] = [
  ['MakaioBus', "import { MakaioBus } from '@makaio/bus-core';\nexport const probe = MakaioBus;"],
  [
    'createBusInstance',
    "import { createBusInstance } from '@makaio/bus-core';\nexport const probe = createBusInstance;",
  ],
  [
    'a type import of MakaioBus',
    "import type { MakaioBus } from '@makaio/bus-core';\nexport type Probe = typeof MakaioBus;",
  ],
];

/** A process-bus import that is fine where the process-wide bus is allowed. */
export const PROCESS_BUS_SOURCE = PROCESS_BUS_PROBES[0][1];

/** Alias probes: `own` is used in any form but a direct method call. */
export const OWN_ALIAS_PROBES: readonly CallContextProbe[] = [
  ['destructuring', 'const { own } = bus;\nexport const probe = own;'],
  ['a renamed destructuring', 'const { own: acquire } = bus;\nexport const probe = acquire;'],
  ['bracket access', "export const probe = bus['own']('x');"],
  ['a reference that is not called', 'export const probe = bus.own;'],
];

/** Alias probes that are fine: the direct call with a string literal. */
export const OWN_DIRECT_PROBES: readonly CallContextProbe[] = [
  ['a direct call', "export const probe = bus.own('x');"],
  ['a direct call over a line break', "export const probe = bus\n  .own('x');"],
];

import { Reporter, TestCase, TestModule, TestSuite } from 'vitest/node';
import { TestError } from 'vitest';
import { colors, TaskChild, TaskContext } from './types.js';
import { parseAndWriteLogs } from './log-parser.js';
import { discoverAdapters } from './discovery.js';

type ColorOutput = { colorCode: string; out: NodeJS.WriteStream };

const KNOWN_ADAPTERS = discoverAdapters();

export default class AdapterReporter implements Reporter {
  private adapterStats = new Map<string, { passed: number; failed: number; skipped: number; duration: number }>();
  private lastDotColor: string | null = null;

  public onInit() {
    for (const adapter of KNOWN_ADAPTERS) {
      this.adapterStats.set(adapter, { passed: 0, failed: 0, skipped: 0, duration: 0 });
    }
  }

  public onTestCaseResult(testCase: TestCase) {
    const result = testCase.result();
    const state = result.state;
    const env = testCase.project.globalConfig.env ?? process.env;
    const isVerbose = env.VERBOSE === 'true';

    if (!isVerbose) {
      const color = state === 'failed' ? colors.red : state === 'skipped' ? colors.yellow : colors.green;
      const out = state === 'failed' ? process.stderr : process.stdout;
      // Only emit color code when it changes to reduce ANSI overhead
      if (color !== this.lastDotColor) {
        out.write(color);
        this.lastDotColor = color;
      }
      out.write('+');
      return;
    }

    const colorCode = state === 'failed' ? colors.red : state === 'skipped' ? colors.yellow : colors.green;
    const out = state === 'failed' ? process.stderr : process.stdout;
    const adapterName = env.MAKAIO_TEST_ADAPTER!;

    out.write(`${colorCode}[${adapterName}] ${state}${colors.reset}: ${testCase.fullName}`);

    const duration = testCase.diagnostic()?.duration;
    if (duration) out.write(` (${duration.toFixed(0)}ms)`);

    this.writeErrors(result.errors, out);
    process.stdout.write('\n');
  }

  public async onTestSuiteResult(testSuite: TestSuite) {
    if (testSuite.parent?.type === 'module' && testSuite.state() !== 'skipped') {
      try {
        await this.processChildren(testSuite, 0);
        this.lastDotColor = null;
        process.stdout.write(colors.reset);
      } catch (e) {
        process.stderr.write(`${e}\n`);
      }
    }
  }

  public onTestModuleEnd(testModule: TestModule) {
    if (testModule.state() !== 'failed') return;

    const moduleErrors = testModule.errors();
    if (moduleErrors.length === 0) return;

    const env = testModule.project.globalConfig.env ?? process.env;
    const adapterName = env.MAKAIO_TEST_ADAPTER ?? 'unknown';

    process.stderr.write(`\n${colors.red}[${adapterName}] fail${colors.reset}: ${testModule.relativeModuleId}`);
    for (const error of moduleErrors) {
      const message = error.message ?? 'Module failed to load';
      process.stderr.write(` - ${message.split('//')[0]}`);
    }
    process.stderr.write(`\n`);
  }

  private writeErrors(errors: readonly TestError[] | undefined, out: NodeJS.WriteStream) {
    if (!errors?.length) return;
    for (const error of errors) {
      out.write(` - ${error.message.split('//')[0]}`);
      const stack = error.stacks?.[0];
      if (stack) out.write(` (${stack.file}:${stack.line})`);
    }
  }

  private getContextInfo(node: TaskChild): TaskContext {
    let parent = node.parent as TaskChild | undefined;
    const meta: TaskContext | undefined = node.meta?.() ?? node.task?.meta;
    const contexts: TaskContext[] = meta ? [meta] : [];

    while (parent) {
      const parentMeta: TaskContext | undefined = parent.meta?.() ?? parent.task?.meta;
      if (parentMeta) contexts.unshift(parentMeta);
      parent = parent.parent as TaskChild | undefined;
    }

    const context: TaskContext = {};
    for (const c of contexts) Object.assign(context, c);
    return context;
  }

  private formatMeta(meta: TaskContext): string {
    const items: string[] = [];
    for (const [prop, value] of Object.entries(meta)) {
      if (prop !== 'busLogs') {
        items.push(Array.isArray(value) && value.length > 1 ? `${prop}: [${value}]` : `${prop}: ${value}`);
      }
    }
    return items.length ? ` (${items.join(', ')})` : '';
  }

  private writeNestedErrors(errors: TestError[] | undefined, level: number, out: NodeJS.WriteStream) {
    if (!errors?.length) return;
    for (const error of errors) {
      process.stdout.write('\n');
      out.write(`${' '.repeat(level * 2)}      ${colors.red}`);

      const cause = error.cause?.stack;
      if (cause) {
        out.write(cause);
      } else {
        out.write(error.message.split('//')[0]);
        const stack = error.stacks?.[0];
        if (stack) out.write(` (${stack.file}:${stack.line})`);
      }

      out.write(colors.reset);
    }
  }

  private getStateLabel(parent: TaskChild): 'pass' | 'fail' | 'skip' | 'unknown' | undefined {
    let state: string | undefined = typeof parent.state === 'function' ? parent.state() : undefined;
    if (!state) state = parent.task?.result?.state;
    if (state === 'passed') return 'pass';
    if (state === 'failed') return 'fail';
    if (state === 'skipped') return 'skip';
    return state as 'unknown';
  }

  private getColorAndOutput(stateLabel: string | undefined): ColorOutput {
    const colorCode = stateLabel === 'fail' ? colors.red : stateLabel === 'skip' ? colors.yellow : colors.green;
    const out = stateLabel === 'fail' ? process.stderr : process.stdout;
    return { colorCode, out };
  }

  private collectAllLogs(node: TaskChild): Array<{ content: string; time: number; type: string; size: number }> {
    const ownLogs = (node.task?.logs ?? []) as Array<{ content: string; time: number; type: string; size: number }>;
    const childLogs: Array<{ content: string; time: number; type: string; size: number }> = [];

    for (const child of node.children ?? []) {
      childLogs.push(...this.collectAllLogs(child as TaskChild));
    }

    return [...ownLogs, ...childLogs];
  }

  private async processChildren(parent: TaskChild, level: number): Promise<void> {
    const env = parent.project.globalConfig.env ?? process.env;
    const isVerbose = env.VERBOSE === 'true';
    const stateLabel = this.getStateLabel(parent);

    if (!isVerbose && (stateLabel !== 'fail' || !stateLabel)) return;

    const { colorCode, out } = this.getColorAndOutput(stateLabel);
    // Collect logs from this node and all descendants
    const allLogs = this.collectAllLogs(parent);
    const logFile = allLogs.length ? await parseAndWriteLogs(allLogs) : undefined;

    if (level === 0) {
      this.writeRootLevel(parent, env, colorCode, stateLabel, logFile, parent.task?.result?.errors, out);
    } else {
      this.writeNestedLevel(parent, colorCode, stateLabel, logFile, level, parent.task?.result?.errors, out);
    }

    if (stateLabel !== 'skip') {
      for (const child of parent.children ?? []) {
        await this.processChildren(child as TaskChild, level + 1);
      }
    }
  }

  private writeRootLevel(
    parent: TaskChild,
    env: Record<string, string | undefined>,
    colorCode: string,
    stateLabel: string | undefined,
    logFile: string | undefined,
    errors: TestError[] | undefined,
    out: NodeJS.WriteStream,
  ) {
    const adapterName = env.MAKAIO_TEST_ADAPTER!;
    const testFile = parent.task?.file?.name;
    out.write(`\n\n[${adapterName}] ${colorCode}${stateLabel}${colors.reset}: ${parent.name}`);
    if (testFile) out.write(` - ${testFile}`);
    if (logFile) out.write(` (log: ${logFile})`);
    this.writeErrors(errors, out);
    out.write(`\n`);
  }

  private writeNestedLevel(
    parent: TaskChild,
    colorCode: string,
    stateLabel: string | undefined,
    logFile: string | undefined,
    level: number,
    errors: TestError[] | undefined,
    out: NodeJS.WriteStream,
  ) {
    const meta = this.getContextInfo(parent);
    process.stdout.write(`${' '.repeat(level * 2)}${colorCode}${stateLabel}${colors.reset}: ${parent.name}`);
    if (logFile) out.write(` (log: ${logFile})`);
    if (Object.keys(meta).length) process.stdout.write(this.formatMeta(meta));
    this.writeNestedErrors(errors, level, out);
    process.stdout.write('\n');
  }
}

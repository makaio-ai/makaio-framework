/**
 * Characterisation of the `no-send-without-call` rule through a real ESLint run with only this rule mounted: what it
 * reports where a call context is in reach, what it accepts as a forwarded call, and the documented limits of a
 * name-based rule, each pinned as an explicit case with its documented outcome.
 */
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCallContextRuleLinter, type CallContextRuleLinter } from './support/call-context-rule-linter';
import { frameworkRoot } from './support/process-start-probes';

let linter: CallContextRuleLinter;

beforeAll(async () => {
  linter = await createCallContextRuleLinter(resolve(frameworkRoot, 'scripts/eslint-rules/no-send-without-call.js'));
});

/**
 * Wrap a statement into a registered handler body, where a call context is always in reach.
 * @param statement - Statement placed inside the handler.
 * @returns Source text of the probe.
 */
function inHandler(statement: string): string {
  return `bus.on('a.b', async (ctx) => { ${statement} });`;
}

/**
 * Assert that a source gets exactly the given number of reports, all of them `sendWithoutCall`.
 * @param source - Source text of the probe.
 * @param count - Expected number of reports.
 */
async function expectReports(source: string, count: number): Promise<void> {
  const reports = await linter.lint(source);
  expect(reports).toHaveLength(count);
  for (const report of reports) expect(report.messageId).toBe('sendWithoutCall');
}

describe('no-send-without-call', () => {
  describe('reports a send without call', () => {
    it.each([
      ['a registered handler', inHandler('await bus.request(Subject, {});')],
      ['a function with a parameter named call', 'async function f(call: X) { await bus.request(Subject, {}); }'],
      ['a function with a parameter typed CallContext', 'const f = (c: CallContext) => bus.request(Subject, {});'],
      ['a function with a call parameter that has a default', 'const f = (call = other) => bus.emit(Subject, {});'],
      [
        'a function with a parameter property typed CallContext',
        'class A { constructor(private c: CallContext) { bus.emit(Subject, {}); } }',
      ],
      [
        'a function with a parameter typed with a qualified CallContext',
        'function f(c: ns.CallContext) { bus.emit(Subject, {}); }',
      ],
    ])('in %s', async (_label, source) => {
      await expectReports(source, 1);
    });

    it.each([['request'], ['requestOptional'], ['emit'], ['broadcast']])('for %s', async (operation) => {
      await expectReports(inHandler(`bus.${operation}(Subject, {});`), 1);
    });

    it.each([
      ['bus'],
      ['sessionBus'],
      ['this.bus'],
      ['ctx.bus'],
      ['channel'],
      ['directChannel'],
      ['this.channel'],
    ])('on the receiver %s', async (receiver) => {
      await expectReports(inHandler(`${receiver}.request(Subject, {});`), 1);
    });

    it('through optional chaining and a non-null assertion on the receiver', async () => {
      await expectReports(inHandler('bus?.request(Subject, {}); bus!.emit(Subject, {});'), 2);
    });

    it('in a function nested inside a handler body', async () => {
      await expectReports(inHandler('const helper = () => { bus.request(Subject, {}); }; helper();'), 1);
    });

    it('for every send of one handler body', async () => {
      await expectReports(inHandler('bus.request(A, {}); bus.emit(B, {});'), 2);
    });

    it('with the operation name in the message data', async () => {
      const [report] = await linter.lint(inHandler('bus.requestOptional(Subject, {});'));
      expect(report?.message).toContain("'requestOptional'");
    });

    it.each([
      ['(Subject as X)', 'bus.request((Subject as X), {});'],
      ['Subject!', 'bus.request(Subject!, {});'],
      ['<X>Subject', 'bus.request(<X>Subject, {});'],
      ['Subject satisfies X', 'bus.request(Subject satisfies X, {});'],
    ])('for a subject wrapped as %s in a handler', async (_label, statement) => {
      await expectReports(inHandler(statement), 1);
    });
  });

  describe('accepts a forwarded call as first argument', () => {
    it.each([
      ['ctx.call', 'bus.request(ctx.call, Subject, {});'],
      ['(ctx.call)', 'bus.request((ctx.call), Subject, {});'],
      ['ctx.call!', 'bus.request(ctx.call!, Subject, {});'],
      ['ctx.call as CallContext', 'bus.request(ctx.call as CallContext, Subject, {});'],
      ['a plain call identifier', 'bus.request(call, Subject, {});'],
      ['a name ending in Call', 'bus.request(forwardedCall, Subject, {});'],
      ['this.call', 'bus.request(this.call, Subject, {});'],
      ['bus.own(shared-work)', "bus.request(bus.own('shared-work'), Subject, {});"],
      ['bus.own(observer) through a receiver', "ctx.bus.emit(ctx.bus.own('observer'), Subject, {});"],
    ])('in a handler: %s', async (_label, statement) => {
      expect(await linter.lint(inHandler(statement))).toEqual([]);
    });

    it.each([
      ['plain', 'function f(forwarded: CallContext) { bus.request(forwarded, Subject, {}); }'],
      ['as CallContext', 'function f(forwarded: CallContext) { bus.request(forwarded as CallContext, Subject, {}); }'],
      ['with a non-null assertion', 'function f(forwarded: CallContext) { bus.request(forwarded!, Subject, {}); }'],
      ['qualified type', 'function f(forwarded: ns.CallContext) { bus.request(forwarded, Subject, {}); }'],
      [
        'declared as a variable',
        'function f(c: CallContext) { const fwd: CallContext = c; bus.request(fwd, Subject, {}); }',
      ],
    ])('for an identifier annotated CallContext: %s', async (_label, source) => {
      expect(await linter.lint(source)).toEqual([]);
    });

    it('for every operation', async () => {
      const source = inHandler(
        'bus.request(ctx.call, A, {}); bus.requestOptional(ctx.call, A, {}); bus.emit(ctx.call, A, {}); bus.broadcast(ctx.call, A, {});',
      );
      expect(await linter.lint(source)).toEqual([]);
    });
  });

  describe('reports nothing where no call context is in reach', () => {
    it.each([
      ['root code', 'await bus.request(Subject, {});'],
      [
        'a plain function without call',
        'function plain() { return bus.request(Subject, {}); }\nconst arrow = () => bus.emit(Subject, {});',
      ],
      ['a function passed to a call that is not a registration', 'run(() => { bus.request(Subject, {}); });'],
      ['a function after a handler was left', "bus.on('a.b', async (ctx) => {});\nbus.request(Subject, {});"],
      [
        'a function after a call-parameter function was left',
        'function f(call: X) {}\nfunction g() { bus.request(Subject, {}); }',
      ],
    ])('in %s', async (_label, source) => {
      expect(await linter.lint(source)).toEqual([]);
    });

    it('stops reporting after the handler body is left', async () => {
      const reports = await linter.lint("bus.on('a.b', async () => { bus.request(A, {}); });\nbus.request(B, {});");
      expect(reports).toHaveLength(1);
      expect(reports[0]?.line).toBe(1);
    });
  });

  describe('foreign APIs', () => {
    it.each([
      ['octokit.request', "octokit.request('GET /x');"],
      ['emitter.emit', "emitter.emit('x');"],
      ['telemetry.emit', "telemetry.emit('x', { a: 1 });"],
      ['a method that is not a send on a bus', 'bus.on(Subject, () => {}); bus.own(x);'],
    ])('does not report %s in a handler', async (_label, statement) => {
      expect(await linter.lint(inHandler(statement))).toEqual([]);
    });
  });

  describe('name collisions', () => {
    it('does not accept a name that merely ends in the letters call', async () => {
      await expectReports(inHandler('bus.request(recall, Subject, {});'), 1);
    });

    it('does not accept a member that merely ends in the letters call', async () => {
      await expectReports(inHandler('bus.request(ctx.recall, Subject, {});'), 1);
    });

    it('reports a foreign API whose receiver matches the name pattern', async () => {
      await expectReports(inHandler("eventBus.emit('x');"), 1);
    });

    it('does not take a receiver that only contains bus in the middle', async () => {
      expect(await linter.lint(inHandler('busLike.request(Subject, {}); omnibusX.emit(Subject, {});'))).toEqual([]);
    });

    it('accepts any .own(...) call as first argument, whatever its receiver', async () => {
      expect(await linter.lint(inHandler("bus.request(registry.own('x'), Subject, {});"))).toEqual([]);
    });
  });

  describe('documented limits', () => {
    it('does not report a spread first argument (cannot be judged)', async () => {
      expect(await linter.lint(inHandler('bus.request(...args);'))).toEqual([]);
    });

    it('reports a send without arguments', async () => {
      await expectReports(inHandler('bus.request();'), 1);
    });

    it('does not accept an identifier annotated CallContext | undefined as a call context', async () => {
      await expectReports(
        inHandler('const maybe: CallContext | undefined = ctx.call; bus.request(maybe, Subject, {});'),
        1,
      );
    });

    it('does not make a call scope of a parameter annotated CallContext | undefined', async () => {
      expect(await linter.lint('function f(maybe: CallContext | undefined) { bus.request(Subject, {}); }')).toEqual([]);
    });

    it('does not accept the result of a helper call, whatever its name', async () => {
      await expectReports(inHandler('bus.request(buildCall(ctx), Subject, {});'), 1);
    });

    it('does not see a send in a helper whose context has no call in the name and no annotation', async () => {
      expect(await linter.lint('function helper(context: Ctx) { bus.request(Subject, {}); }')).toEqual([]);
    });

    it('does not accept a context returned by such a helper as first argument', async () => {
      await expectReports(inHandler('const context = getContext(); bus.request(context, Subject, {});'), 1);
    });

    it('checks a class sending through this.bus only inside handlers and call-parameter functions', async () => {
      const source = 'class A { m() { this.bus.request(Subject, {}); } n(call: X) { this.bus.request(Subject, {}); } }';
      expect(await linter.lint(source)).toHaveLength(1);
    });

    it('does not see a callback that is declared outside the handler body', async () => {
      const source = "const later = () => { bus.request(Subject, {}); };\nbus.on('a.b', async () => { run(later); });";
      expect(await linter.lint(source)).toEqual([]);
    });

    it('does not recognise bracket access with a non-literal key', async () => {
      expect(await linter.lint(inHandler('bus[name](Subject, {});'))).toEqual([]);
    });

    it('recognises bracket access with a string literal key', async () => {
      await expectReports(inHandler("bus['request'](Subject, {});"), 1);
    });

    it('does not recognise a destructured method', async () => {
      expect(await linter.lint(inHandler('const { request } = bus; request(Subject, {});'))).toEqual([]);
    });

    it('does not recognise an alias of the bus under another name', async () => {
      expect(await linter.lint(inHandler('const b = bus; b.request(Subject, {});'))).toEqual([]);
    });

    it('does not make a call scope of a destructured parameter', async () => {
      expect(await linter.lint('const f = ({ call }: Carrier) => bus.request(Subject, {});')).toEqual([]);
    });
  });
});

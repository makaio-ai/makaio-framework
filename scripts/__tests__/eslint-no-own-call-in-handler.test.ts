/**
 * Characterisation of the `no-own-call-in-handler` rule: what it reports today, through a real ESLint run with only
 * this rule mounted. The depth cases pin how a nested function relates to the handler body around it.
 */
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCallContextRuleLinter, type CallContextRuleLinter } from './support/call-context-rule-linter';
import { OWN_IN_HANDLER_PROBES, OWN_OUTSIDE_HANDLER_PROBES } from './support/call-context-probes';
import { frameworkRoot } from './support/process-start-probes';
import { CONCURRENT_OWN_WORK_PURPOSES } from '../../core/bus-core/src/call-context/own-work';
import { CONCURRENT_OWN_PURPOSES } from '../eslint-rules/no-own-call-in-handler.js';

let linter: CallContextRuleLinter;

beforeAll(async () => {
  linter = await createCallContextRuleLinter(resolve(frameworkRoot, 'scripts/eslint-rules/no-own-call-in-handler.js'));
});

describe('no-own-call-in-handler', () => {
  it.each(OWN_IN_HANDLER_PROBES)('reports .own(...) in %s', async (_label, source) => {
    const reports = await linter.lint(source);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.messageId).toBe('ownInHandler');
  });

  it.each(OWN_OUTSIDE_HANDLER_PROBES)('reports nothing for %s', async (_label, source) => {
    expect(await linter.lint(source)).toEqual([]);
  });

  describe('function depth', () => {
    it('reports .own(...) in a function nested inside a handler body', async () => {
      const source = "bus.on('a.b', async () => { const helper = () => { bus.own('x'); }; helper(); });";
      expect(await linter.lint(source)).toHaveLength(1);
    });

    it('reports .own(...) in a function declaration nested inside a handler body', async () => {
      const source = "bus.on('a.b', async () => { function helper() { bus.own('x'); } helper(); });";
      expect(await linter.lint(source)).toHaveLength(1);
    });

    it('stops reporting after the handler body is left', async () => {
      const source = "bus.on('a.b', async () => { bus.own('x'); });\nexport const after = bus.own('y');";
      const reports = await linter.lint(source);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.line).toBe(1);
    });

    it('keeps the outer handler counted after a nested handler is left', async () => {
      const source = "bus.on('a.b', async () => { bus.on('c.d', async () => {}); bus.own('x'); });";
      expect(await linter.lint(source)).toHaveLength(1);
    });

    it('does not count a plain function that is not a handler', async () => {
      const source = "function plain() { return bus.own('x'); }\nconst arrow = () => bus.own('y');";
      expect(await linter.lint(source)).toEqual([]);
    });

    it('does not count a function passed to a call that is not a registration', async () => {
      expect(await linter.lint("run(() => { bus.own('x'); });")).toEqual([]);
    });

    it('reports every .own(...) in one handler body', async () => {
      const source = "bus.once('a.b', () => { bus.own('x'); bus.own('y'); });";
      expect(await linter.lint(source)).toHaveLength(2);
    });
  });

  describe('handler recognition', () => {
    it.each([['once'], ['intercept'], ['registerHandler'], ['useBusEvent']])('recognises %s', async (name) => {
      expect(await linter.lint(`bus.${name}('a.b', () => { bus.own('x'); });`)).toHaveLength(1);
    });

    it.each([
      ['EventContext'],
      ['WildcardContext'],
      ['InterceptorContext'],
      ['BaseMessageContext'],
    ])('recognises a first parameter typed %s', async (type) => {
      expect(await linter.lint(`const h = (ctx: ${type}) => ctx.bus.own('x');`)).toHaveLength(1);
    });

    it('recognises a qualified context type name', async () => {
      expect(await linter.lint("function h(ctx: ns.RequestContext) { bus.own('x'); }")).toHaveLength(1);
    });

    it('only reads the first parameter for the context type', async () => {
      expect(await linter.lint("function h(a: string, ctx: RequestContext) { bus.own('x'); }")).toEqual([]);
    });

    it('does not report own called through bracket access with a non-literal key', async () => {
      expect(await linter.lint("bus.on('a.b', () => { bus[name]('x'); });")).toEqual([]);
    });

    it('reports own called through bracket access with a string literal', async () => {
      expect(await linter.lint("bus.on('a.b', () => { bus['own']('x'); });")).toHaveLength(1);
    });
  });

  describe('concurrent purposes', () => {
    const ALLOWED = ['shared-work', 'schedule', 'observer', 'stop'] as const;
    const REPORTED_ARGUMENTS: readonly (readonly [string, string])[] = [
      ['root', "'root'"],
      ['start', "'start'"],
      ['an unknown literal', "'x'"],
      ['an identifier', 'purpose'],
      ['a call', 'pick()'],
      ['a template literal with expressions', '`shared-${suffix}`'],
      ['no argument', ''],
    ];

    /**
     * Wrap an own call in the two handler shapes the rule recognises.
     * @param argument - Source text of the `.own(...)` argument list.
     * @returns Labelled probe sources.
     */
    function handlerShapes(argument: string): readonly (readonly [string, string])[] {
      return [
        ['an .on handler', `bus.on('a.b', async () => { bus.own(${argument}); });`],
        ['a function with a typed context', `function h(ctx: RequestContext) { return ctx.bus.own(${argument}); }`],
      ];
    }

    it('lists exactly the concurrent purposes of the bus core', () => {
      expect([...CONCURRENT_OWN_PURPOSES].sort()).toEqual([...CONCURRENT_OWN_WORK_PURPOSES].sort());
    });

    it.each(ALLOWED)('allows the literal %s', async (purpose) => {
      for (const [, source] of handlerShapes(`'${purpose}'`)) {
        expect(await linter.lint(source)).toEqual([]);
      }
    });

    it.each(ALLOWED)('allows a template literal without expressions for %s', async (purpose) => {
      for (const [, source] of handlerShapes(`\`${purpose}\``)) {
        expect(await linter.lint(source)).toEqual([]);
      }
    });

    it.each(REPORTED_ARGUMENTS)('still reports %s', async (_label, argument) => {
      for (const [shape, source] of handlerShapes(argument)) {
        const reports = await linter.lint(source);
        expect(reports, shape).toHaveLength(1);
        expect(reports[0]?.messageId).toBe('ownInHandler');
      }
    });
  });
});

/**
 * Minimal ambient declaration for the untyped `jexl` base package.
 *
 * `jexl-extended` ships its own `.d.ts` that imports `{ Jexl }` from `'jexl'`,
 * but `jexl` itself has no type definitions. This ambient declaration fills
 * that gap so `jexl-extended`'s own types resolve correctly — including its
 * default export and the `Monaco` namespace re-export.
 *
 * Covers only the surface used by this codebase; extend as needed.
 */
declare module 'jexl' {
  /** A compiled jexl expression ready for repeated evaluation. */
  export class Expression {
    /**
     * Evaluate the expression asynchronously.
     * @param context - variable map passed to the expression
     */
    public eval(context?: object): Promise<unknown>;
    /**
     * Evaluate the expression synchronously.
     * @param context - variable map passed to the expression
     */
    public evalSync(context?: object): unknown;
    /** Pre-parse the expression string into an AST. Returns `this`. */
    public compile(): this;
  }

  /** The main Jexl class. */
  export class Jexl {
    /**
     * Evaluate a jexl expression string asynchronously.
     * @param expression - jexl expression
     * @param context - variable map
     */
    public eval(expression: string, context?: object): Promise<unknown>;
    /**
     * Evaluate a jexl expression string synchronously.
     * @param expression - jexl expression
     * @param context - variable map
     */
    public evalSync(expression: string, context?: object): unknown;
    /**
     * Compile a jexl expression string into a reusable Expression object.
     * @param expression - jexl expression
     */
    public compile(expression: string): Expression;
    /**
     * Add a named transform function.
     * @param name - transform name used in expressions
     * @param fn - transform implementation
     */
    public addTransform(name: string, fn: (...args: unknown[]) => unknown): void;
    /**
     * Add a named function.
     * @param name - function name used in expressions
     * @param fn - function implementation
     */
    public addFunction(name: string, fn: (...args: unknown[]) => unknown): void;
    /**
     * Add a binary operator.
     * @param operator - operator symbol
     * @param precedence - operator precedence
     * @param fn - operator implementation
     */
    public addBinaryOp(operator: string, precedence: number, fn: (left: unknown, right: unknown) => unknown): void;
  }
}

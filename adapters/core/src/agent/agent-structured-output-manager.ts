import Ajv, { type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  AgentSubjects,
  type ResponseSchemaDescriptor,
  type StructuredOutputValidation,
  type StructuredOutputValidationError,
} from '@makaio/contracts';

/**
 * Constructor arguments for {@link AgentStructuredOutputManager}.
 */
export interface AgentStructuredOutputManagerConfig {
  /** Global bus used to dispatch retryPolicy and enforce RPC requests. */
  bus: IMakaioBus;
  /** Stable identifier of the owning agent. */
  agentId: string;
  /** Runtime identifier of the owning adapter. */
  adapterId: string;
  /** Capability tags reported by the adapter. */
  adapterCapabilities: string[];
}

/**
 * Input for {@link AgentStructuredOutputManager.validateTerminalResult}.
 */
export interface ValidateTerminalResultInput {
  /** Schema descriptor that the terminal output must conform to. */
  responseSchema: ResponseSchemaDescriptor;
  /** Raw terminal message string, or undefined when the turn produced no output. */
  message: string | undefined;
  /** Session identifier forwarded to the enforce RPC handler. */
  sessionId?: string;
  /**
   * Callback invoked for each retry attempt. Receives the 1-based attempt
   * number and the validation errors from the preceding attempt. Should
   * return the new raw output string from a re-run of the turn.
   *
   * When absent, the retry loop is skipped even if `maxRetries > 0`.
   * @param input - Retry context including attempt number and prior errors
   * @returns Raw output string from the retried turn
   */
  retryTurn?: (input: {
    attemptNumber: number;
    validationErrors: StructuredOutputValidationError[];
  }) => Promise<string>;
}

/**
 * Output from {@link AgentStructuredOutputManager.validateTerminalResult}.
 */
export interface ValidateTerminalResultOutput {
  /** Final message string after optional enforcement. */
  message: string | undefined;
  /** Structured-output validation result for this turn. */
  structuredOutputValidation: StructuredOutputValidation;
}

const DRAFT_2019_09_SCHEMA_URIS = new Set([
  'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2019-09/schema#',
]);

const DRAFT_2020_12_SCHEMA_URIS = new Set([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
]);

interface ValidatorCompiler {
  compile(schema: AnySchemaObject): ValidateFunction;
}

interface ValidatorCompileTarget {
  compiler: ValidatorCompiler;
  schema: AnySchemaObject;
}

/**
 * Manages structured-output validation for terminal agent turns.
 *
 * Responsibilities:
 * - Validate a terminal message against a JSON Schema using Ajv.
 * - Request enforcement via `agent.structuredOutput.enforce` when validation fails
 *   and retry budget is exhausted.
 * - Provide default bus handlers for `agent.structuredOutput.retryPolicy` that can
 *   be overridden by the host layer.
 *
 * The manager is stateless between turns; all context is passed through
 * {@link validateTerminalResult}.
 */
export class AgentStructuredOutputManager {
  private readonly bus: IMakaioBus;
  private readonly agentId: string;
  private readonly adapterId: string;
  private readonly adapterCapabilities: string[];

  /**
   * Ajv instances with a per-schema {@link ValidateFunction} cache.
   * `allErrors: true` collects every violation per call; `strict: false` avoids
   * Ajv warnings for JSON-Schema keywords that are valid but not in its strict-mode
   * allow-list (e.g. `$schema`, extra `format` values).
   */
  private readonly draft07Ajv = new Ajv({ allErrors: true, strict: false });
  private readonly draft2019Ajv = new Ajv2019({ allErrors: true, strict: false });
  private readonly draft2020Ajv = new Ajv2020({ allErrors: true, strict: false });

  /**
   * WeakMap keyed by schema objects so validator functions are compiled once per
   * unique schema reference and garbage-collected with the descriptor.
   */
  private readonly validatorCache = new WeakMap<object, ValidateFunction>();

  /**
   * Create a new manager instance.
   * @param config - Manager configuration
   */
  public constructor(config: AgentStructuredOutputManagerConfig) {
    this.bus = config.bus;
    this.agentId = config.agentId;
    this.adapterId = config.adapterId;
    this.adapterCapabilities = config.adapterCapabilities;
  }

  /**
   * Register default bus handlers for structured-output RPC subjects.
   *
   * The default `retryPolicy` handler disables replay. It is registered at a
   * low priority so host/product handlers registered with the default priority
   * can opt into retries through normal bus dispatch when their turns are
   * known to be side-effect-safe.
   * The default `enforce` handler always returns `enforced: false` (no-op),
   * allowing host layers to override with real enforcement logic.
   *
   * Call this from the owning agent's `init()` and push the returned cleanups
   * into `busHandlerCleanups`.
   * @returns Cleanup functions for all registered handlers
   */
  public registerDefaultHandlers(): Array<() => void> {
    const filteredBus = this.bus.withFilter({ agentId: this.agentId });

    const retryPolicyCleanup = filteredBus.on(
      AgentSubjects.structuredOutput.retryPolicy,
      (ctx) => {
        ctx.setResult({ maxRetries: 0 });
      },
      { priority: -1000 },
    );

    const enforceCleanup = filteredBus.on(
      AgentSubjects.structuredOutput.enforce,
      (ctx) => {
        ctx.setResult({ enforced: false, error: 'No enforce handler registered' });
      },
      { priority: -1000 },
    );

    return [retryPolicyCleanup, enforceCleanup];
  }

  /**
   * Validate a terminal message against the active response schema.
   *
   * Flow:
   * 1. Parse the message as JSON; produce validation errors on parse failure.
   * 2. Validate the parsed value against the schema using Ajv.
   * 3. If valid → return `status: 'passed'`.
   * 4. If invalid → consult the retry policy via `agent.structuredOutput.retryPolicy`.
   *    - For each permitted retry, invoke `input.retryTurn` and re-validate.
   *    - If any retry succeeds → return `status: 'passed'`.
   * 5. After retries are exhausted → request enforcement via `agent.structuredOutput.enforce`.
   *    - If enforced and the result is valid → return `status: 'enforced'` with the corrected message.
   *    - Otherwise → return `status: 'failed'` with accumulated errors.
   * @param input - Validation input including schema descriptor, message, and optional retry callback
   * @returns Resolved message and structured-output validation metadata
   */
  public async validateTerminalResult(input: ValidateTerminalResultInput): Promise<ValidateTerminalResultOutput> {
    const { responseSchema, message, sessionId } = input;

    const firstValidation = this.validate(responseSchema, message);

    if (firstValidation.valid) {
      return { message, structuredOutputValidation: { status: 'passed' } };
    }

    let latestMessage = message ?? '';
    let latestErrors = firstValidation.errors;

    if (input.retryTurn) {
      // Consult the retry policy before enforcement. Default to maxRetries: 0
      // when no handler is registered so callers without a retryPolicy handler
      // fall through directly to enforcement.
      const retryPolicyOptional = await this.bus.requestOptional(AgentSubjects.structuredOutput.retryPolicy, {
        agentId: this.agentId,
        adapterId: this.adapterId,
        adapterCapabilities: this.adapterCapabilities,
        responseSchema,
        attemptNumber: 1,
      });

      const maxRetries = retryPolicyOptional.handled ? retryPolicyOptional.data.maxRetries : 0;

      for (let attemptNumber = 1; attemptNumber <= maxRetries; attemptNumber += 1) {
        latestMessage = await input.retryTurn({ attemptNumber, validationErrors: latestErrors });
        const retryValidation = this.validate(responseSchema, latestMessage);
        if (retryValidation.valid) {
          return { message: latestMessage, structuredOutputValidation: { status: 'passed' } };
        }
        latestErrors = retryValidation.errors;
      }
    }

    // Retries exhausted — attempt enforcement via bus
    const enforceOptional = await this.bus.requestOptional(AgentSubjects.structuredOutput.enforce, {
      agentId: this.agentId,
      adapterId: this.adapterId,
      sessionId,
      responseSchema,
      rawOutput: latestMessage,
      validationErrors: latestErrors,
      adapterHasCapability: this.adapterCapabilities.includes('structuredOutput'),
    });

    if (
      enforceOptional.handled &&
      enforceOptional.data.enforced === true &&
      enforceOptional.data.output !== undefined
    ) {
      // Re-validate the enforced output to confirm conformance
      const { valid: enforcedValid } = this.validate(responseSchema, enforceOptional.data.output);
      if (enforcedValid) {
        return {
          message: enforceOptional.data.output,
          structuredOutputValidation: { status: 'enforced' },
        };
      }
    }

    return {
      message: latestMessage,
      structuredOutputValidation: { status: 'failed', errors: latestErrors },
    };
  }

  /**
   * Validate a raw output string against a JSON Schema descriptor.
   *
   * Parses the string as JSON first; a parse failure produces a synthetic
   * validation error so callers always receive a uniform error shape.
   * @param descriptor - Schema descriptor containing the JSON Schema document
   * @param raw - Raw string to validate, or undefined for empty output
   * @returns Validation result with errors (empty array on success)
   */
  private validate(
    descriptor: ResponseSchemaDescriptor,
    raw: string | undefined,
  ): { valid: true; errors: [] } | { valid: false; errors: StructuredOutputValidationError[] } {
    if (raw === undefined || raw === '') {
      return {
        valid: false,
        errors: [{ message: 'Expected JSON output but received empty string', instancePath: '', schemaPath: '#' }],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        valid: false,
        errors: [{ message: `Output is not valid JSON: ${raw.slice(0, 120)}`, instancePath: '', schemaPath: '#' }],
      };
    }

    const validateFn = this.getValidator(descriptor);
    const isValid = validateFn(parsed);

    if (isValid) {
      return { valid: true, errors: [] };
    }

    const errors = this.normalizeErrors(validateFn.errors ?? []);
    if (errors.length === 0) {
      errors.push({ message: 'Schema validation failed', instancePath: '', schemaPath: '#' });
    }

    return { valid: false, errors };
  }

  /**
   * Retrieve or compile an Ajv {@link ValidateFunction} for the given schema descriptor.
   *
   * Validator functions are cached by the schema object reference so the expensive
   * compilation step runs at most once per unique schema instance.
   * @param descriptor - Schema descriptor whose `schema` field is compiled
   * @returns Compiled Ajv validate function
   */
  private getValidator(descriptor: ResponseSchemaDescriptor): ValidateFunction {
    const cached = this.validatorCache.get(descriptor.schema);
    if (cached !== undefined) return cached;

    const target = this.getValidatorCompileTarget(descriptor.schema);
    let validateFn: ValidateFunction;
    try {
      validateFn = target.compiler.compile(target.schema);
    } catch (error) {
      validateFn = this.createCompileFailureValidator(error);
    }
    this.validatorCache.set(descriptor.schema, validateFn);
    return validateFn;
  }

  /**
   * Create a non-throwing validator for schema documents Ajv cannot compile.
   * @param error - Error thrown by Ajv while compiling the response schema
   * @returns Validate function that reports the compile failure as a validation error
   */
  private createCompileFailureValidator(error: unknown): ValidateFunction {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errors: ErrorObject[] = [
      {
        keyword: 'schema',
        instancePath: '',
        schemaPath: '#',
        params: {},
        message: `Failed to compile response schema: ${errorMessage}`,
      },
    ];
    const fallbackSchemaValidator = this.draft07Ajv.compile({});
    return Object.assign((_data: unknown): _data is unknown => false, {
      errors,
      schema: fallbackSchemaValidator.schema,
      schemaEnv: fallbackSchemaValidator.schemaEnv,
    });
  }

  /**
   * Pick the Ajv instance that matches the schema document's advertised draft.
   * @param schema - JSON Schema document from the response schema descriptor
   * @returns Ajv compiler and schema document to compile
   */
  private getValidatorCompileTarget(schema: ResponseSchemaDescriptor['schema']): ValidatorCompileTarget {
    const schemaUri = this.readSchemaUri(schema);
    const draft202012Uri = schemaUri === undefined ? undefined : this.normalizeDraft202012Uri(schemaUri);
    const draft201909Uri = schemaUri === undefined ? undefined : this.normalizeDraft201909Uri(schemaUri);

    if (draft202012Uri !== undefined && DRAFT_2020_12_SCHEMA_URIS.has(draft202012Uri)) {
      return {
        compiler: this.draft2020Ajv,
        schema: this.withSchemaUri(schema, draft202012Uri),
      };
    }

    if (draft201909Uri !== undefined && DRAFT_2019_09_SCHEMA_URIS.has(draft201909Uri)) {
      return {
        compiler: this.draft2019Ajv,
        schema: this.withSchemaUri(schema, draft201909Uri),
      };
    }

    return {
      compiler: this.draft07Ajv,
      schema: this.withoutSchemaUri(schema),
    };
  }

  /**
   * Read the `$schema` value when it is a string URI.
   * @param schema - JSON Schema document from the response schema descriptor
   * @returns `$schema` URI when present and string-like
   */
  private readSchemaUri(schema: ResponseSchemaDescriptor['schema']): string | undefined {
    const schemaUri = schema.$schema;
    return typeof schemaUri === 'string' ? schemaUri : undefined;
  }

  /**
   * Normalize equivalent draft 2020-12 metaschema URI variants to Ajv's registered URI.
   * @param schemaUri - `$schema` URI advertised by the schema document
   * @returns URI compatible with the draft 2020-12 Ajv instance
   */
  private normalizeDraft202012Uri(schemaUri: string): string {
    return schemaUri.replace(/^http:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/, (uri) =>
      uri.replace('http://', 'https://'),
    );
  }

  /**
   * Normalize equivalent draft 2019-09 metaschema URI variants to Ajv's registered URI.
   * @param schemaUri - `$schema` URI advertised by the schema document
   * @returns URI compatible with the draft 2019-09 Ajv instance
   */
  private normalizeDraft201909Uri(schemaUri: string): string {
    return schemaUri.replace(/^http:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/, (uri) =>
      uri.replace('http://', 'https://'),
    );
  }

  /**
   * Return a schema object with the Ajv-compatible `$schema` URI.
   * @param schema - Original JSON Schema document
   * @param schemaUri - Normalized metaschema URI
   * @returns Original schema when the URI already matches; otherwise a normalized shallow copy
   */
  private withSchemaUri(schema: ResponseSchemaDescriptor['schema'], schemaUri: string): AnySchemaObject {
    if (schema.$schema === schemaUri) return schema as AnySchemaObject;
    return { ...schema, $schema: schemaUri } as AnySchemaObject;
  }

  /**
   * Return a draft-07 fallback schema without root `$schema` metadata.
   *
   * Ajv resolves the root `$schema` during compilation, so an unsupported URI
   * would fail before validation can produce the manager's normal failed result.
   * @param schema - Original JSON Schema document
   * @returns Shallow schema copy without the root `$schema` declaration
   */
  private withoutSchemaUri(schema: ResponseSchemaDescriptor['schema']): AnySchemaObject {
    if (schema.$schema === undefined) return schema as AnySchemaObject;

    const schemaWithoutUri = { ...schema };
    delete schemaWithoutUri.$schema;
    return schemaWithoutUri as AnySchemaObject;
  }

  /**
   * Map Ajv {@link ErrorObject} instances to the contract's normalized error shape.
   * @param errors - Raw Ajv error objects
   * @returns Normalized validation errors
   */
  private normalizeErrors(errors: ErrorObject[]): StructuredOutputValidationError[] {
    return errors.map((err) => ({
      message: err.message ?? 'Validation error',
      instancePath: err.instancePath,
      schemaPath: err.schemaPath,
    }));
  }
}

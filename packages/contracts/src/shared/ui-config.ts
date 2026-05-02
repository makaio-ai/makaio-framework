import { z } from 'zod';

// ─────────────────────────────────────────────────────────
// Widget Types (extensible via declaration merging)
// ─────────────────────────────────────────────────────────

/**
 * Builtin widget types provided by web/components
 * - tags: Comma-separated input that converts to array
 * - textarea-array: Multi-line textarea that converts to array
 * - password: Password input field
 * - slider: Numeric slider input
 * - capability-picker: Grouped three-state capability selector with raw tool overrides
 * - prompt-editor: Multi-line textarea with `{{prompt:name}}` template reference highlighting
 */
export type BuiltinWidget = 'tags' | 'textarea-array' | 'password' | 'slider' | 'capability-picker' | 'prompt-editor';

/**
 * Plugin widget registry - augment to add custom widgets.
 * @example Augmenting from a plugin
 * ```typescript
 * // extensions/loop/src/types.ts
 * declare module '@makaio/contracts' {
 *   interface PluginWidgetRegistry {
 *     'success-criteria': true;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty interface for declaration merging
export interface PluginWidgetRegistry {}

/**
 * All available widget types (builtin + plugin-registered)
 */
export type FieldWidget = BuiltinWidget | keyof PluginWidgetRegistry;

// ─────────────────────────────────────────────────────────
// Shared Option Schema
// ─────────────────────────────────────────────────────────

/**
 * Option for select-type fields.
 *
 * Each option represents a selectable choice in dropdown/select fields.
 */
export const FieldOptionSchema = z.object({
  /** The value to be stored when this option is selected. */
  value: z.string(),
  /** The display label for this option. */
  label: z.string(),
});

/**
 * Option for select-type fields.
 *
 * Each option represents a selectable choice in dropdown/select fields.
 */
export type FieldOption = z.infer<typeof FieldOptionSchema>;

// ─────────────────────────────────────────────────────────
// Field Override Schema
// ─────────────────────────────────────────────────────────

/**
 * Zod schema for field override (runtime validation - accepts any string for widget)
 */
export const FieldOverrideSchema = z
  .object({
    /**
     * Custom widget to use for this field
     * Runtime accepts any string, but type-safe code should use FieldWidget
     */
    widget: z.string().optional(),
    /**
     * Delimiter for splitting array input (default varies by widget)
     */
    delimiter: z.string().optional(),
    /**
     * Placeholder text for empty fields
     */
    placeholder: z.string().optional(),
    /**
     * Help text displayed near the field.
     * Applied UI field definitions expose this value via `FieldDefinition.description`.
     */
    helpText: z.string().optional(),
    /**
     * Minimum value for slider widget
     */
    min: z.number().finite().optional(),
    /**
     * Maximum value for slider widget
     */
    max: z.number().finite().optional(),
    /**
     * Step increment for slider widget
     */
    step: z.number().finite().positive().optional(),
    /**
     * Options for select-type fields
     */
    options: z.array(FieldOptionSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`min` must be less than or equal to `max`',
        path: ['min'],
      });
    }
  });

/**
 * Field override type - inferred from schema
 * Note: widget is string at runtime, use FieldWidget type for type-safe code
 */
export type FieldOverride = z.infer<typeof FieldOverrideSchema>;

// ─────────────────────────────────────────────────────────
// Entity UI Config (uses extracted types)
// ─────────────────────────────────────────────────────────

/**
 * UI configuration for entity forms
 * Defines how the entity should be displayed and edited in the UI
 */
export const EntityUIConfigSchema = z.object({
  /**
   * The editing mode for this entity
   * - inline: Edit directly in the list/card
   * - slidePanel: Edit in a slide-out panel
   * - fullPage: Edit on a dedicated full page
   */
  editMode: z.enum(['inline', 'slidePanel', 'fullPage']).default('fullPage'),
  /**
   * Fields to hide from the form UI
   * These fields will not be rendered and cannot be edited
   */
  hiddenFields: z.array(z.string()).optional(),
  /**
   * Fields that are read-only in edit mode
   * These fields are visible but cannot be modified during editing
   */
  readOnlyInEditMode: z.array(z.string()).optional(),
  /**
   * Field-specific overrides for custom widgets and behavior
   * Maps field name to widget configuration
   */
  fieldOverrides: z.record(z.string(), FieldOverrideSchema).optional(),
  /**
   * Optional form sections for grouping related fields.
   * When provided, fields are rendered in the given section order.
   */
  sections: z
    .array(
      z.object({
        /** Stable identifier for the section */
        id: z.string(),
        /** Display title for the section */
        title: z.string(),
        /** Optional descriptive text shown under the title */
        description: z.string().optional(),
        /** Field keys to include in this section */
        fields: z.array(z.string()),
      }),
    )
    .optional(),
});

/**
 * Entity UI configuration type - inferred from schema
 * Note: widget values are string at runtime, use FieldWidget type for type-safe widget handling
 */
export type EntityUIConfig = z.infer<typeof EntityUIConfigSchema>;

// ─────────────────────────────────────────────────────────
// Form Field Types (shared between framework and host UI)
// ─────────────────────────────────────────────────────────

/**
 * Field type options for form inputs.
 *
 * These types correspond to standard HTML input types and provide
 * type-safe rendering of different form field variants. Slider-style numeric
 * controls continue to use `type: 'number'` with `widget: 'slider'`.
 *
 * Use `'custom'` when field rendering is fully delegated to the widget
 * specified in `widget` — SchemaForm will route the field to the registered
 * widget and ignore the type for rendering purposes.
 */
export type FieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'array' | 'custom';

/**
 * Shared properties for all form field definitions.
 *
 * This interface provides the seam for extensible form generation.
 * Fields can be generated from JSON Schema, hardcoded registries,
 * or any other source that can produce this structure.
 */
export interface BaseFieldDefinition {
  /** Unique key for the field (used as form field name). */
  key: string;
  /** Display label for the field. */
  label: string;
  /** Delimiter for array-type fields (default varies by widget). */
  delimiter?: string;
  /** Minimum numeric value (for numeric fields, including the slider widget). */
  min?: number;
  /** Maximum numeric value (for numeric fields, including the slider widget). */
  max?: number;
  /** Step increment for numeric fields, including the slider widget. */
  step?: number;
  /** Placeholder text for text-based inputs. */
  placeholder?: string;
  /** Help text/description shown below the input, including mapped override help text. */
  description?: string;
  /** Whether the field is required. */
  required?: boolean;
  /** Options for select-type fields. */
  options?: FieldOption[];
  /** Default value for the field. */
  defaultValue?: unknown;
  /** Whether the field is disabled. */
  disabled?: boolean;
}

/** Field definition for builtin field types. */
export interface StandardFieldDefinition extends BaseFieldDefinition {
  /** Type of input to render. */
  type: Exclude<FieldType, 'custom'>;
  /** Custom widget for specialized rendering (e.g., tags for arrays). */
  widget?: FieldWidget;
}

/** Field definition for widgets that render through the custom field path. */
export interface CustomFieldDefinition extends BaseFieldDefinition {
  /** Custom fields always render through an explicit widget. */
  type: 'custom';
  /** Builtin or plugin-registered widget used to render the custom field. */
  widget: FieldWidget;
}

/**
 * Definition for a form field.
 *
 * Builtin field types may omit `widget` and fall back to their type renderer.
 * Custom field types must provide a registered widget so render-time lookup
 * never falls back to the literal `'custom'` type.
 */
export type FieldDefinition = StandardFieldDefinition | CustomFieldDefinition;

/**
 * Props for form field components.
 *
 * Defines the contract between the form rendering infrastructure and
 * individual field components. Both framework extensions and host UI
 * implement components that accept this interface.
 * @param field - Field definition describing what to render
 * @param value - Current value of the field
 * @param onChange - Callback when the field value changes
 * @param className - Optional additional CSS class
 * @param idPrefix - Optional id prefix (defaults to 'field')
 * @param error - Error state message (when present, field shows error styling)
 */
export interface FormFieldProps {
  /** Field definition describing what to render. */
  field: FieldDefinition;
  /** Current value of the field. */
  value: unknown;
  /** Callback when the field value changes. */
  onChange: (value: unknown) => void;
  /** Optional additional CSS class. */
  className?: string;
  /** Optional id prefix (defaults to 'field'). */
  idPrefix?: string;
  /** Error message (when present, field shows error styling). */
  error?: string;
}

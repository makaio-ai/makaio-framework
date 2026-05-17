/**
 * Profile and session-config schemas for the client domain.
 *
 * Covers the `ClientProfile` entity, the `profile.*` command–response pairs
 * for CRUD and default-selection, the `sessionConfig.*` lifecycle subjects
 * for per-session configuration isolation, and the setup-delegation request
 * schema passed to client-owned setup handlers.
 * @packageDocumentation
 */

import { z } from 'zod';
import { AbsolutePathSchema, EpochMillisecondsSchema, NonEmptyStringSchema } from './primitives.js';

/**
 * Filesystem-safe profile name.
 *
 * Profile names are used as directory names under the client profile root, so
 * they must be a single path component. The character set intentionally stays
 * conservative until a concrete UX need requires broader display names.
 */
export const ClientProfileNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Profile name must be a safe path component');

/**
 * Filesystem-safe session config directory name.
 *
 * Session IDs flow into ephemeral config directory paths. They are restricted
 * to the same single-component form as profile names to prevent path escape.
 */
export const SessionConfigIdSchema = ClientProfileNameSchema;

/**
 * A named, persistent configuration profile for a client.
 *
 * Profiles allow multiple configuration environments (e.g., work vs. personal)
 * to coexist under the same `clientId`. One profile per client is marked as
 * the default and is selected when no explicit profile name is provided. When
 * no default exists, session setup falls back to the client's immutable native
 * config source and copies/materializes it into the session directory.
 */
export const ClientProfileSchema = z.object({
  /** Stable unique identifier for this profile record. */
  id: NonEmptyStringSchema,
  /** Stable client identifier (e.g. `'claude-code'`). */
  clientId: NonEmptyStringSchema,
  /** Filesystem-safe profile name (e.g. `'work'`, `'personal'`). */
  name: ClientProfileNameSchema,
  /** Optional description for this profile. */
  description: z.string().nullable(),
  /** Absolute path to the directory that holds this profile's config files. */
  configDir: AbsolutePathSchema,
  /** Whether this profile is the default for its `clientId`. */
  isDefault: z.boolean(),
  /** Unix epoch timestamp in milliseconds when the profile was created. */
  createdAt: EpochMillisecondsSchema,
  /** Unix epoch timestamp in milliseconds when the profile was last updated. */
  updatedAt: EpochMillisecondsSchema,
});

export type ClientProfile = z.infer<typeof ClientProfileSchema>;

/**
 * Environment variables map for a session's isolated config environment.
 */
export const SessionConfigEnvSchema = z.record(z.string(), z.string());

/**
 * Policy for materializing a session config directory from a base client config.
 */
export const SessionConfigInheritanceSchema = z.enum(['auth-only', 'full', 'empty']);

export type SessionConfigInheritance = z.infer<typeof SessionConfigInheritanceSchema>;

/**
 * Request and response schemas for `client.profile.*` operations.
 *
 * Provides typed bus subjects for creating, listing, retrieving, updating,
 * deleting, and setting the default profile for a given client.
 */
export const ClientProfileSchemas = {
  /**
   * Create a new profile for a client.
   */
  'profile.create': {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyStringSchema,
      /** Filesystem-safe name for the new profile. */
      name: ClientProfileNameSchema,
      /** Optional description for the new profile. */
      description: z.string().optional(),
    }),
    response: z.object({
      /** The newly created profile. */
      profile: ClientProfileSchema,
    }),
  },

  /**
   * List all profiles for a client.
   */
  'profile.list': {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyStringSchema,
    }),
    response: z.object({
      /** All profiles registered for this client. */
      profiles: z.array(ClientProfileSchema),
    }),
  },

  /**
   * Get a profile by client ID and name.
   *
   * Returns `null` in the response when no matching profile exists rather
   * than throwing, so callers can handle the absent-profile case inline.
   */
  'profile.get': {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyStringSchema,
      /** Profile name to look up. */
      name: ClientProfileNameSchema,
    }),
    response: z.object({
      /** The matching profile, or `null` when not found. */
      profile: ClientProfileSchema.nullable(),
    }),
  },

  /**
   * Update an existing profile's mutable fields.
   */
  'profile.update': {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyStringSchema,
      /** Name of the profile to update. */
      name: ClientProfileNameSchema,
      /** Replacement description; omit to leave unchanged. */
      description: z.string().optional(),
    }),
    response: z.object({
      /** The profile after the update has been applied. */
      profile: ClientProfileSchema,
    }),
  },

  /**
   * Delete a profile by client ID and name.
   */
  'profile.delete': {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyStringSchema,
      /** Name of the profile to delete. */
      name: ClientProfileNameSchema,
    }),
    response: z.object({
      /** `true` when the profile was found and deleted successfully. */
      success: z.boolean(),
    }),
  },

  /**
   * Mark a profile as the default for its client.
   */
  'profile.setDefault': {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyStringSchema,
      /** Name of the profile to promote to default. */
      name: ClientProfileNameSchema,
    }),
    response: z.object({
      /** The profile after being set as default. */
      profile: ClientProfileSchema,
    }),
  },
};

/**
 * Request and response schemas for `client.sessionConfig.*` operations.
 *
 * Manages per-session configuration isolation: creating a temporary working
 * directory seeded from a named profile, tearing it down after a session ends,
 * and bulk-cleaning stale session directories.
 */
export const ClientSessionConfigSchemas = {
  /**
   * Create an isolated configuration directory for a session.
   *
   * The service seeds the directory from the named profile (or the client
   * default when `profileName` is omitted) and returns the path together
   * with any environment variables the client process should inherit.
   */
  'sessionConfig.create': {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyStringSchema,
      /** Framework session ID for which config isolation is requested. */
      sessionId: SessionConfigIdSchema,
      /** Profile name to use as the config source; defaults to the client default. */
      profileName: ClientProfileNameSchema.optional(),
      /** Override for the base config directory used during setup. */
      baseConfigDir: AbsolutePathSchema.optional(),
      /** Project directory the client process will start in, when relevant. */
      projectDir: AbsolutePathSchema.optional(),
      /** Policy for inheriting settings and auth from the resolved base config. */
      configInheritance: SessionConfigInheritanceSchema.optional(),
    }),
    response: z.object({
      /** Absolute path to the isolated session config directory. */
      sessionDir: AbsolutePathSchema,
      /** Environment variables the client process should inherit. */
      env: SessionConfigEnvSchema,
    }),
  },

  /**
   * Destroy the isolated configuration directory for a session.
   */
  'sessionConfig.destroy': {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyStringSchema,
      /** Framework session ID whose config directory should be removed. */
      sessionId: SessionConfigIdSchema,
    }),
    response: z.object({
      /** `true` when the directory was found and removed successfully. */
      success: z.boolean(),
    }),
  },

  /**
   * Clean up stale session config directories.
   *
   * When `clientId` is supplied only that client's orphaned directories are
   * removed; omit it to clean across all clients.
   */
  'sessionConfig.cleanup': {
    request: z.object({
      /** Optional client ID to scope cleanup; all clients when absent. */
      clientId: NonEmptyStringSchema.optional(),
    }),
    response: z.object({
      /** Absolute paths of all directories that were removed. */
      removed: z.array(AbsolutePathSchema),
    }),
  },
};

/**
 * Schema for the setup-delegation request passed to client-owned session
 * config setup handlers.
 *
 * Each client's setup handler receives this payload and is responsible for
 * populating `sessionDir` with the correct config files for the given
 * `baseConfigDir` on the target platform.
 */
export const SessionConfigSetupRequestSchema = z.object({
  /** Absolute path to the isolated session config directory to populate. */
  sessionDir: AbsolutePathSchema,
  /** Absolute path to the profile's base config directory used as the source. */
  baseConfigDir: AbsolutePathSchema,
  /** Project directory the client process will start in, when relevant. */
  projectDir: AbsolutePathSchema.optional(),
  /** Host operating system platform. */
  platform: z.enum(['darwin', 'linux', 'win32']),
  /** Policy for inheriting settings and auth from the resolved base config. */
  configInheritance: SessionConfigInheritanceSchema,
});

export type SessionConfigSetupRequest = z.infer<typeof SessionConfigSetupRequestSchema>;

/**
 * Schema for the teardown-delegation request passed to client-owned session
 * config destroy handlers.
 *
 * Each client's destroy handler receives the concrete session directory before
 * `clients-core` removes it and is responsible for cleaning any native
 * credential material associated with that directory.
 */
export const SessionConfigTeardownRequestSchema = z.object({
  /** Absolute path to the isolated session config directory being destroyed. */
  sessionDir: AbsolutePathSchema,
  /** Host operating system platform. */
  platform: z.enum(['darwin', 'linux', 'win32']),
});

export type SessionConfigTeardownRequest = z.infer<typeof SessionConfigTeardownRequestSchema>;

/** Response schema for the teardown-delegation request. */
export const SessionConfigTeardownResponseSchema = z.object({
  /** `true` when the client-owned teardown completed successfully. */
  success: z.boolean(),
});

export type SessionConfigTeardownResponse = z.infer<typeof SessionConfigTeardownResponseSchema>;

/**
 * Response schema for the setup-delegation request.
 *
 * The setup handler may return environment variables that the client process
 * should inherit for the isolated session directory.  When absent, no extra
 * environment variables are added beyond those already in the spawn environment.
 */
export const SessionConfigSetupResponseSchema = z.object({
  /** Environment variables the client process should inherit for this session. */
  env: z.record(z.string(), z.string()).optional(),
});

export type SessionConfigSetupResponse = z.infer<typeof SessionConfigSetupResponseSchema>;

// Inferred request/response types for key profile subjects
export type ProfileCreateRequest = z.infer<(typeof ClientProfileSchemas)['profile.create']['request']>;
export type ProfileCreateResponse = z.infer<(typeof ClientProfileSchemas)['profile.create']['response']>;
export type ProfileListRequest = z.infer<(typeof ClientProfileSchemas)['profile.list']['request']>;
export type ProfileListResponse = z.infer<(typeof ClientProfileSchemas)['profile.list']['response']>;
export type ProfileGetRequest = z.infer<(typeof ClientProfileSchemas)['profile.get']['request']>;
export type ProfileGetResponse = z.infer<(typeof ClientProfileSchemas)['profile.get']['response']>;
export type ProfileUpdateRequest = z.infer<(typeof ClientProfileSchemas)['profile.update']['request']>;
export type ProfileUpdateResponse = z.infer<(typeof ClientProfileSchemas)['profile.update']['response']>;
export type ProfileDeleteRequest = z.infer<(typeof ClientProfileSchemas)['profile.delete']['request']>;
export type ProfileDeleteResponse = z.infer<(typeof ClientProfileSchemas)['profile.delete']['response']>;
export type ProfileSetDefaultRequest = z.infer<(typeof ClientProfileSchemas)['profile.setDefault']['request']>;
export type ProfileSetDefaultResponse = z.infer<(typeof ClientProfileSchemas)['profile.setDefault']['response']>;

// Inferred request/response types for key sessionConfig subjects
export type SessionConfigCreateRequest = z.infer<
  (typeof ClientSessionConfigSchemas)['sessionConfig.create']['request']
>;
export type SessionConfigCreateResponse = z.infer<
  (typeof ClientSessionConfigSchemas)['sessionConfig.create']['response']
>;
export type SessionConfigDestroyRequest = z.infer<
  (typeof ClientSessionConfigSchemas)['sessionConfig.destroy']['request']
>;
export type SessionConfigDestroyResponse = z.infer<
  (typeof ClientSessionConfigSchemas)['sessionConfig.destroy']['response']
>;
export type SessionConfigCleanupRequest = z.infer<
  (typeof ClientSessionConfigSchemas)['sessionConfig.cleanup']['request']
>;
export type SessionConfigCleanupResponse = z.infer<
  (typeof ClientSessionConfigSchemas)['sessionConfig.cleanup']['response']
>;

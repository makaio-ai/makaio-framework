/**
 * Variant bus schemas — pure Zod, no side effects.
 *
 * Defines Zod schemas for the `host:variant.*` bus namespace, which lets extensions
 * query which build variant (base/cef) the Electrobun host is running. This
 * namespace is host-specific: only the Electrobun desktop host registers
 * handlers for it.
 *
 * Import this module when you only need types or validation shapes without
 * registering the namespace on the bus. To register the namespace and obtain
 * typed subjects, import `./namespace` instead.
 * @packageDocumentation
 */

import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Supported build variant identifiers for the Electrobun desktop host.
 *
 * - `'base'` — system WebView (no bundled CEF)
 * - `'cef'` — Chromium Embedded Framework bundled into the distributable
 */
export const MakaioVariantSchema = z.enum(['base', 'cef']);

/** Inferred TypeScript type for a variant identifier. */
export type MakaioVariant = z.infer<typeof MakaioVariantSchema>;

/**
 * Upgrade status values emitted during a variant upgrade operation.
 *
 * - `'downloading'` — initiating download
 * - `'progress'` — download in progress
 * - `'applying'` — applying the downloaded files
 * - `'complete'` — upgrade finished successfully
 * - `'error'` — upgrade failed
 */
export const VariantUpgradeStatusSchema = z.enum(['downloading', 'progress', 'applying', 'complete', 'error']);

/** Inferred TypeScript type for an upgrade status value. */
export type VariantUpgradeStatus = z.infer<typeof VariantUpgradeStatusSchema>;

/**
 * Variant domain bus schemas.
 *
 * Each key becomes a subject identifier as `host:variant.<key>`.
 */
export const VariantSchemas = {
  /**
   * Query the current variant configuration from the host.
   *
   * Request: empty — the handler reads the resolved variant at startup.
   * Response: full variant info — identifier, CEF-bundle flag, and default renderer.
   *
   * Subject: `host:variant.getInfo`
   * Type: Request (RPC)
   */
  getInfo: {
    request: z.object({}),
    response: z.object({
      /** The resolved variant identifier. */
      variant: MakaioVariantSchema,
      /** Whether the Chromium Embedded Framework is bundled into the distributable. */
      bundleCEF: z.boolean(),
      /** Default renderer backend when no explicit override is provided. */
      defaultRenderer: z.enum(['native', 'cef']),
    }),
  },

  /**
   * Request a variant switch on the host.
   *
   * The host may accept or decline the request. When accepted it may report
   * the estimated download size so the caller can display a confirmation UI.
   * A declined response must include a human-readable `message` explaining why.
   *
   * Subject: `host:variant.requestUpgrade`
   * Type: Request (RPC)
   */
  requestUpgrade: {
    request: z.object({
      /** The target variant to switch to. */
      targetVariant: MakaioVariantSchema,
    }),
    response: z.union([
      z.object({
        /** Whether the host accepted the upgrade request. */
        accepted: z.literal(true),
        /**
         * Estimated download size in bytes, when the host accepted the request
         * and a download is required.
         */
        downloadSizeBytes: z.number().int().nonnegative().optional(),
        /** Optional human-readable status message from the host. */
        message: z.string().optional(),
      }),
      z.object({
        /** Whether the host declined the upgrade request. */
        accepted: z.literal(false),
        /** Human-readable refusal message from the host. */
        message: z.string().min(1),
      }),
    ]),
  },

  /**
   * Emitted by the host while a variant upgrade is in progress.
   *
   * Consumers subscribe to track download and apply progress for display
   * in the UI (e.g. a progress bar).
   *
   * Subject: `host:variant.upgradeProgress`
   * Type: Event
   */
  upgradeProgress: z.object({
    /** Current upgrade phase. */
    status: VariantUpgradeStatusSchema,
    /**
     * Completion percentage (0–100).
     * Present during `'progress'` and `'applying'` phases.
     */
    percent: z.number().min(0).max(100).optional(),
    /**
     * Human-readable status message from the host.
     * Present on `'complete'` and `'error'` phases.
     */
    message: z.string().optional(),
  }),
} satisfies SchemaRecord;

// ── Type exports ──────────────────────────────────────────────────────────────

/** Response payload for `host:variant.getInfo`. */
export type VariantGetInfoResponse = z.infer<(typeof VariantSchemas)['getInfo']['response']>;

/** Request payload for `host:variant.requestUpgrade`. */
export type VariantRequestUpgradeRequest = z.infer<(typeof VariantSchemas)['requestUpgrade']['request']>;

/** Response payload for `host:variant.requestUpgrade`. */
export type VariantRequestUpgradeResponse = z.infer<(typeof VariantSchemas)['requestUpgrade']['response']>;

/** Payload of the `host:variant.upgradeProgress` event. */
export type VariantUpgradeProgressEvent = z.infer<(typeof VariantSchemas)['upgradeProgress']>;

/**
 * Browser-safe entry for `@makaio/services-core/filesystem`.
 *
 * Empty browser entry — no runtime exports are needed by the web layer.
 * Exists solely to prevent Vite from bundling {@link FileSystemService}
 * (which imports `node:fs`, `node:child_process`, etc.) into the renderer.
 * @packageDocumentation
 */

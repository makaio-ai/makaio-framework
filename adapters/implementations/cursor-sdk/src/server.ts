/**
 * Server entrypoint for the Cursor SDK adapter.
 *
 * Re-exports the {@link MakaioExtension} descriptor as the module default so
 * the runtime coordinator can load this adapter via its standard package
 * discovery mechanism.
 * @see ./package.js for the full descriptor declaration.
 */
export { cursorSdkPackage as default } from './package.js';

import { describe, expectTypeOf, it } from 'vitest';
import type {
  ExtensionCliBeforeRunContext as PublicExtensionCliBeforeRunContext,
  ExtensionCliBeforeRunResult as PublicExtensionCliBeforeRunResult,
  ExtensionCliContribution as PublicExtensionCliContribution,
  ExtensionCliHandlerContext as PublicExtensionCliHandlerContext,
  ExtensionCliInteractiveContext as PublicExtensionCliInteractiveContext,
  ExtensionCliOutputWriter as PublicExtensionCliOutputWriter,
  ExtensionCliSubcommandEntry as PublicExtensionCliSubcommandEntry,
} from '../index.js';
import type {
  ExtensionCliBeforeRunContext as InternalExtensionCliBeforeRunContext,
  ExtensionCliBeforeRunResult as InternalExtensionCliBeforeRunResult,
  ExtensionCliContribution as InternalExtensionCliContribution,
  ExtensionCliHandlerContext as InternalExtensionCliHandlerContext,
  ExtensionCliInteractiveContext as InternalExtensionCliInteractiveContext,
  ExtensionCliOutputWriter as InternalExtensionCliOutputWriter,
  ExtensionCliSubcommandEntry as InternalExtensionCliSubcommandEntry,
} from '../extension-cli.js';

describe('extension CLI public surface', () => {
  it('re-exports the extension-local CLI types from the extension entrypoint', () => {
    expectTypeOf<PublicExtensionCliOutputWriter>().toEqualTypeOf<InternalExtensionCliOutputWriter>();
    expectTypeOf<PublicExtensionCliHandlerContext>().toEqualTypeOf<InternalExtensionCliHandlerContext>();
    expectTypeOf<PublicExtensionCliInteractiveContext>().toEqualTypeOf<InternalExtensionCliInteractiveContext>();
    expectTypeOf<PublicExtensionCliSubcommandEntry>().toEqualTypeOf<InternalExtensionCliSubcommandEntry>();
    expectTypeOf<PublicExtensionCliContribution>().toEqualTypeOf<InternalExtensionCliContribution>();
    expectTypeOf<PublicExtensionCliBeforeRunContext>().toEqualTypeOf<InternalExtensionCliBeforeRunContext>();
    expectTypeOf<PublicExtensionCliBeforeRunResult>().toEqualTypeOf<InternalExtensionCliBeforeRunResult>();
  });
});

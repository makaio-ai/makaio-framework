# @makaio/storage-core

Factory for creating bus-integrated storage namespaces with `storage:` prefix convention.

## Quick Index

- `./src/create-storage-namespace.ts` – factory function for storage namespaces
- `./src/create-extension-storage-namespace.ts` – extension namespace helper that creates
  `storage:extension:{name}` subjects
- `./src/types.ts` – type definitions and extension interfaces
- `./src/index.ts` – public exports

## Key Contracts

```ts
// ./src/types.ts
export interface StorageNamespace<
  N extends string = string,
  Subjects extends SubjectRecord = SubjectRecord,
  FilterPayload = unknown,
  Ext extends StorageNamespaceExtensions = StorageNamespaceExtensions,
  Schemas extends SchemaRecord = SchemaRecord,
> extends BusNamespace<`storage:${N}`, Subjects, FilterPayload, Schemas> {
  readonly domain: N;
  readonly extensions: Ext;
}

export interface StorageNamespaceConfig<
  Schemas extends SchemaRecord,
  Ext extends StorageNamespaceExtensions = StorageNamespaceExtensions,
> {
  schemas: Schemas;
  extensions?: Ext;
}

// Extension point for extensions (declaration merging)
export interface StorageNamespaceExtensions {}
```

## Usage Workflow

1. **Define Zod schemas** for your bus RPC contract:
   ```ts
   const schemas = {
     get: {
       request: z.object({ id: z.string() }),
       response: z.object({ item: ItemSchema.nullable() }),
     },
     set: {
       request: z.object({ id: z.string(), item: ItemSchema }),
       response: z.object({ success: z.boolean() }),
     },
   };
   ```

2. **Create storage namespace** with optional extensions:
   ```ts
   import { createStorageNamespace } from '@makaio/storage-core';

   export const ItemStorageNamespace = createStorageNamespace('item', {
     schemas,
     extensions: {
       drizzle: { items: itemsTable },
     },
   });

   // Bus namespace is registered as 'storage:item'
   // ItemStorageNamespace.domain remains 'item'
   // Subjects: storage:item.get, storage:item.set
   ```

3. **Export typed subjects** for consumers:
   ```ts
   export const ItemStorageSubjects = ItemStorageNamespace.subjects;
   ```

4. **Implement handler** with mappers:
   ```ts
   export function registerDrizzleItemStorage(bus: IMakaioBus, db: MakaioDatabase) {
     return bus.on(ItemStorageSubjects.get, async (ctx) => {
       const [row] = await db.select().from(items).where(eq(items.id, ctx.payload.id)).limit(1);
       ctx.setResult({ item: row ? mapToItem(row) : null });
     });
   }
   ```

5. **Consume via bus** (storage backend is transparent):
   ```ts
   const { item } = await bus.request(ItemStorageSubjects.get, { id: '123' });
   ```

## Architectural Responsibilities

- **Prefix convention** – `createStorageNamespace()` registers typed bus subjects under
  `storage:{domain}` while preserving the namespace `domain` property as the unprefixed domain
- **Schema ownership** – Zod schemas define the bus contract; handlers own the mapping
- **Handler ownership** – Storage namespace creation does not register request handlers; each
  storage package must register handlers separately
- **Extension points** – `StorageNamespaceExtensions` interface enables type-safe plugin data

## Seams & Extension Points

### Backend Swapping

Same namespace, different handlers:

```ts
// Tests
registerInMemoryItemStorage(bus);

// Production
registerDrizzleItemStorage(bus, db);
```

### Extension Augmentation

Extend `StorageNamespaceExtensions` for type-safe metadata:

```ts
// In @makaio/storage-drizzle
declare module '@makaio/storage-core' {
  interface StorageNamespaceExtensions {
    drizzle?: DrizzleSchemaRecord;
  }
}

// Now available with types
ItemStorageNamespace.extensions.drizzle?.items
```

### Custom Storage Domains

Create new storage domains without modifying core:

```ts
export const CacheStorageNamespace = createStorageNamespace('cache', {
  schemas: { ... },
  extensions: { redis: redisConfig },
});
// → storage:cache.get, storage:cache.set, etc.
```

### Extension Storage Domains

Use `createExtensionStorageNamespace()` for extension-owned storage so extension subject names stay
under `storage:extension:{extensionName}`:

```ts
import { createExtensionStorageNamespace } from '@makaio/storage-core';

export const TerminalStorageNamespace = createExtensionStorageNamespace('terminal', {
  schemas,
});
// → storage:extension:terminal.get, storage:extension:terminal.set, etc.
```

Pass the unprefixed extension name. The helper rejects empty names and names that already include
`extension:` so callers cannot accidentally double-prefix the domain.

## Related

- [@makaio/storage-drizzle](../drizzle/) – Drizzle/libSQL client factory
- [@makaio/bus-core](../../bus-core/README.md) – underlying bus infrastructure

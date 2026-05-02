# @makaio/preferences

User preference storage handlers for browser `localStorage`, Drizzle, and hybrid browser/database
coordination.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ @makaio/services-core/preferences owns PreferencesSubjects   │
│  preferences.get / preferences.set / preferences.delete /   │
│  preferences.list                                           │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────┐  ┌─────────────────┐  ┌──────────────────┐
│ BrowserHandler     │  │ DrizzleHandler  │  │ HybridHandler    │
│ (localStorage)     │  │ (SQLite)        │  │ (local + Drizzle)│
└────────────────────┘  └─────────────────┘  └──────────────────┘
         │
         ▼
  StorageCoordinator + ConflictResolvers
```

`@makaio/preferences` does not define the bus subjects. `PreferencesSubjects` and
`PreferencesNamespace` are owned by `@makaio/services-core/preferences`; consumers and hosts that
request or register preference handlers need that dependency.

## Preference Key Structure

```typescript
interface PreferenceKey {
  scope: string;       // 'global' or projectId
  surface?: 'ui' | 'app';      // SEAM: undefined = all (Phase 1)
  context?: string;            // SEAM: widget layout focus
  viewport?: 'desktop' | 'tablet' | 'mobile'; // SEAM: unused in Phase 1
}
```

## Bus Subjects

| Subject | Description |
|---------|-------------|
| `preferences.get` | Fetch value by `{ key, category }` |
| `preferences.set` | Store `{ key, category, value }` |
| `preferences.delete` | Remove a preference |
| `preferences.list` | List preferences with optional filter |

## Storage Backends

| Backend | Environment | Source of truth |
|---------|-------------|-----------------|
| `BrowserHandler` | Browser — `localStorage` only | `localStorage` |
| `DrizzleHandler` | Node/Electron — SQLite via Drizzle | Database |
| `HybridHandler` | Hybrid app — `localStorage` plus Drizzle coordination | Database |

`HybridHandler` uses `StorageCoordinator` to read from the Drizzle database as the durable source of
truth, write through to both `localStorage` and the database, and reconcile legacy local entries
through conflict resolution. `localStorage` remains a fast local cache and migration bridge; the DB
owns persisted state. The coordinator and conflict resolver are the current sync seam for future
multi-device coordination.

## Usage

```typescript
import { PreferencesSubjects } from '@makaio/services-core/preferences';

await bus.request(PreferencesSubjects.set, {
  key: { scope: 'global' },
  category: 'layout',
  value: { sidebarWidth: 280 },
});

const { value } = await bus.request(PreferencesSubjects.get, {
  key: { scope: 'global' },
  category: 'layout',
});
```

## Entry Points

| Entry | Description |
|-------|-------------|
| `@makaio/preferences` | Node barrel — all exports including Drizzle |
| `@makaio/preferences/browser` | Browser-safe — no Drizzle dependencies |
| `@makaio/preferences/package` | MakaioExtension manifest |

## SEAMS (Extension Points)

- `surface`, `context`, `viewport` key fields — prepared for Phase 2 use
- `StorageCoordinator` + `ConflictResolvers` — local cache/database reconciliation and future sync seam

# @makaio/storage-conformance

Dual-dialect storage conformance suite. Every suite asserts the public storage contracts on a live database — SQLite by default, Postgres when opted in.

## Purpose

Each test file wraps its content in `describeStorageConformance(title, suite)`. The harness provisions a fresh isolated database per suite (a temp-file for SQLite, a dedicated schema on Postgres), applies the central migration chain, runs assertions against the live database, and destroys the isolation unit when the suite finishes.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MAKAIO_STORAGE_TEST_DIALECT` | `sqlite` | Active dialect. Valid values: `sqlite`, `postgres`. |
| `MAKAIO_STORAGE_TEST_URL` | — | Postgres connection URL. Required when dialect is `postgres`. |

## Running against SQLite (default)

No configuration required. Tests discover and run automatically:

```sh
yarn test storage/conformance
```

## Running against Postgres

Set both environment variables before running:

```sh
MAKAIO_STORAGE_TEST_DIALECT=postgres \
MAKAIO_STORAGE_TEST_URL=postgres://postgres:postgres@localhost:5432/makaio_storage_conformance \
yarn test storage/conformance
```

Any local PostgreSQL 18+ server works — the harness creates and drops a dedicated schema per suite so it never touches other data in the database.

If the dialect is `postgres` but `MAKAIO_STORAGE_TEST_URL` is missing, plain `vitest` invocations log a warning and skip every conformance suite. `yarn test` instead fails fast: the test wrapper runs with CI semantics (`CI=true`), and a CI run must never go green by silently skipping the Postgres suites.

### Starting Postgres with Docker

```sh
docker run --rm -d --name makaio-storage-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=makaio_storage_conformance \
  -p 5432:5432 postgres:18-alpine
```

## Isolation model

Each suite receives its own isolated database:

- **SQLite**: a new temp-file database (`os.tmpdir()/makaio-conformance-<uuid>.db`), deleted after the suite.
- **Postgres**: a dedicated schema (`conformance_<12 hex chars>`) created on the shared database before the suite and dropped with `DROP SCHEMA … CASCADE` after. This model is valid because all framework DDL uses unqualified table names that land in whichever schema is first in the `search_path`.

If qualified DDL ever enters the migration chain (e.g. `public.sessions`), the Postgres isolation model must fall back to `CREATE DATABASE` per suite. Report such cases immediately.

## `pg` as a devDependency

`pg` is listed as a `devDependency` here precisely because it is consumer-provided: published framework manifests never declare it as a dependency. This private, never-published package is the sanctioned location where `pg` is installed so that the dynamic `import('pg')` inside `@makaio/storage-drizzle`'s Postgres client resolves at test time.

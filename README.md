# Synora

A local-first, end-to-end encrypted sync service for Obsidian vaults.
Obsidian stays the primary editor; the service coordinates encrypted file
versions across devices without ever being able to read vault content.

See [docs/protocol-spec.md](docs/protocol-spec.md) for the sync protocol
(encryption format, versioning, conflict rules) this implementation follows.

## Status

Phase 0 (protocol spec), Phase 1 (sync backend), and an initial Phase 2
(Obsidian plugin) are implemented, plus the recovery-key device
enrollment flow from Phase 3 (a device with no other trusted device
around can regain vault access using the recovery code shown once at
vault creation — no server-side recovery of the vault key itself, by
design). The plugin's crypto, queue, sync engine, and three-way text
merge for Markdown conflicts have real test coverage, and the recovery
flow is verified end-to-end against the live backend; the Obsidian-UI
glue (`main.ts`, `settings-tab.ts`) type-checks and bundles but hasn't
been run inside Obsidian itself (attempted via Playwright and native GUI
automation; both were blocked by this environment, not by the plugin).
Mobile testing and the web workspace (Phases 4-5) haven't been started.

## Packages

- [packages/backend](packages/backend) — the sync API: Cloudflare Workers +
  Hono, Postgres (via Hyperdrive) for metadata, R2 for encrypted blobs.
- [packages/plugin](packages/plugin) — the Obsidian plugin: client-side
  encryption, device/vault key management, a durable local sync queue, and
  the engine that uploads local edits and applies remote changes.

## Getting started

```sh
cd packages/backend
npm install
docker compose up -d        # local Postgres on :5435
npm run db:generate         # generate SQL migration from schema.ts
npm run db:migrate          # apply it
npm test                    # run the test suite (needs the DB above)
npm run dev                 # wrangler dev, http://localhost:8787
```

```sh
cd packages/plugin
npm install
npm test                    # crypto, queue, and sync engine tests
npm run build                # type-checks and bundles to main.js
# To actually run it: symlink this folder into a test vault's
# .obsidian/plugins/synora-sync/ and enable it in Obsidian.
```

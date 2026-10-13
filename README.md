# Synora

Synora is a self-hosted, end-to-end encrypted sync service for Obsidian
vaults. Obsidian stays the editor you already use, on every device; Synora
is the backend that keeps your notes in sync between them — without ever
being able to read the notes themselves.

The idea: your laptop and your phone each encrypt their own edits before
anything leaves the device, upload the ciphertext to your own Cloudflare
account, and pull down whatever other devices have uploaded. The server
coordinates *which version is current* and *resolves conflicts* — it never
sees plaintext content, filenames, or folder paths.

## How it works

- **Client-side encryption.** Every note and attachment is encrypted
  (XChaCha20-Poly1305) on-device before upload, using a vault key that's
  generated locally and never sent to the server in the clear.
- **Conflict-safe versioning.** Each file is a chain of immutable, ordered
  versions. A device committing against a stale version is rejected
  (checked transactionally, race-condition-safe) rather than silently
  overwritten — see [docs/protocol-spec.md](docs/protocol-spec.md) for
  the exact wire protocol.
- **Automatic merging.** Two devices editing different parts of the same
  note merge automatically (three-way text merge); genuinely overlapping
  edits are preserved as a conflict copy instead of picking a winner.
- **Device trust, not device-to-device connections.** Every device syncs
  independently with the server on an interval — your phone doesn't need
  your laptop to be online, or vice versa.
- **Recovery without a password reset.** Losing every trusted device
  doesn't lock you out: a one-time recovery code, shown once when a vault
  is created, lets a brand-new device regain access on its own.

### Architecture

```
Obsidian (laptop) ──┐                      ┌── R2 (encrypted blobs)
                     ├── Cloudflare Worker ─┤
Obsidian (phone)  ───┘    (Hono API)        └── Postgres (versions, devices)
```

- **`packages/backend`** — the sync API. Cloudflare Workers + Hono,
  Postgres (via Hyperdrive) for metadata/version history/device records,
  R2 for the encrypted file blobs themselves.
- **`packages/plugin`** — the Obsidian plugin. Generates and manages keys,
  encrypts/decrypts on-device, runs the local sync queue, and talks to the
  backend. Works on desktop and mobile.

Nothing server-side — not the database, not R2, not the people operating
the Cloudflare account — can read vault content. See
[docs/protocol-spec.md](docs/protocol-spec.md) for the full threat model
and wire protocol.

## Running your own instance

### 1. Backend

```sh
cd packages/backend
npm install

# Local development
docker compose up -d        # local Postgres on :5435
npm run db:generate         # generate SQL migration from schema.ts
npm run db:migrate          # apply it (DATABASE_URL from .env, see below)
npm test                    # run the test suite
npm run dev                 # wrangler dev, http://localhost:8787
```

Create `packages/backend/.env` (gitignored) with your Postgres connection
string for local migrations:

```
DATABASE_URL=postgres://user:pass@host:port/db
```

**Deploying to production:**

```sh
wrangler login
wrangler r2 bucket create <your-bucket-name>
wrangler hyperdrive create <name> --connection-string="<your-postgres-url>"
# update wrangler.toml's r2_buckets.bucket_name and hyperdrive.id to match
wrangler secret put JWT_SECRET     # paste a long random value
DATABASE_URL=<your-postgres-url> npm run db:migrate
wrangler deploy
```

A GitHub Actions workflow (`.github/workflows/keep-db-alive.yml`) pings the
database every 12 hours so a free-tier Postgres instance isn't auto-paused
for inactivity — set the `DATABASE_URL` repository secret for it to run.

### 2. Obsidian plugin

```sh
cd packages/plugin
npm install
npm test                    # crypto, queue, merge, and sync engine tests
npm run build                # type-checks and bundles to main.js
```

**Installing it in Obsidian** (the plugin isn't published to the official
Community Plugin directory — it's distributed via GitHub releases):

1. In Obsidian: Settings → Community plugins → Browse → install **BRAT**
2. In BRAT's settings → "Add beta plugin" → enter this repo
   (`Manoo07/Synora`)
3. BRAT installs the latest tagged release automatically, on both desktop
   and mobile

**Cutting a release** (after bumping `version` in `packages/plugin/manifest.json`,
copying that same change to the root-level `manifest.json` — BRAT's
first-time "Add beta plugin" check requires one there, separate from the
real one used to build/release — and adding the matching entry to
`versions.json`):

```sh
npm run build
git tag -a X.Y.Z -m "Synora Sync plugin vX.Y.Z"
git push origin X.Y.Z
gh release create X.Y.Z manifest.json main.js --title "Synora Sync X.Y.Z" --notes "..."
```

**First-time setup inside Obsidian:** open the plugin's settings, set the
Server URL to your deployed Worker, register an account, create a vault
(save the one-time recovery code it shows you), then on each additional
device use "Recover vault access" with that same code to join it.

## Status

- **Backend**: deployed and live-tested end-to-end (register → create
  vault → upload → commit → download, and the full recovery flow).
- **Plugin**: installable via BRAT on both desktop and mobile; crypto,
  sync queue, conflict engine, and merge logic have test coverage.
- **Not built yet**: the official Community Plugin directory listing, a
  private web workspace, and web-based editing (these are later-phase
  ideas from the original design, not in progress).

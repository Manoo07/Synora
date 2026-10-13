# Synora

Synora keeps your Obsidian vault in sync across devices — laptop, phone,
anywhere you use Obsidian — without any third-party service ever being able
to read your notes. You run your own backend (free, on Cloudflare), install
one plugin, and your devices stay in sync automatically in the background.

## What you need

- An Obsidian vault (desktop and/or mobile)
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- A free Postgres database (e.g. [Aiven](https://aiven.io/) or
  [Neon](https://neon.tech) have free tiers) — only needed once, during setup
- [Node.js](https://nodejs.org) and the [GitHub CLI](https://cli.github.com/)
  installed on the machine you're setting this up from

## Setup guide

### 1. Deploy your own backend

This is a one-time setup. You're deploying your own private copy of the
Synora server to your own Cloudflare account — nobody else can see or use it.

```sh
cd packages/backend
npm install

npx wrangler login
npx wrangler r2 bucket create <pick-a-bucket-name>
npx wrangler hyperdrive create <pick-a-name> --connection-string="<your-postgres-connection-string>"
```

Open `wrangler.toml` and update `r2_buckets.bucket_name` and
`hyperdrive.id` to match what the two commands above printed. Then:

```sh
npx wrangler secret put JWT_SECRET      # paste any long random string
DATABASE_URL=<your-postgres-connection-string> npm run db:migrate
npx wrangler deploy
```

The last command prints your server's URL, something like
`https://synora-backend.<your-name>.workers.dev`. Save it — you'll enter it
into the plugin in step 3.

If your Postgres provider auto-pauses idle databases on its free tier, set
up the included GitHub Actions workflow
(`.github/workflows/keep-db-alive.yml`) by adding a `DATABASE_URL`
repository secret — it pings the database every 12 hours to keep it awake.

### 2. Install the plugin

Synora isn't on the official Community Plugins list (yet), so it installs
through [BRAT](https://github.com/TfTHacker/obsidian42-brat), a plugin that
installs other plugins directly from GitHub:

1. In Obsidian: **Settings → Community plugins → Browse** → install **BRAT**
2. In BRAT's settings → **Add beta plugin** → enter `Manoo07/Synora`
3. BRAT installs the latest release — do this on every device you want to
   sync (desktop and mobile both work)

### 3. Connect your first device

1. Open **Settings → Synora Sync**
2. Set **Server URL** to the URL from step 1
3. Register an account (your email + a password)
4. **Create a vault** — this shows you a one-time **recovery code**. Save it
   somewhere safe (a password manager is ideal). It's the only way to add a
   new device if you ever lose access to all your existing ones.

### 4. Connect every other device

On each additional device, install the plugin the same way (step 2), then
in **Settings → Synora Sync**:

- If it's a brand new device: sign in, then **Recover vault access** using
  the recovery code from step 3.
- If this device already synced with this vault before (e.g. you
  disconnected and reconnected it): it'll show up under **"This device
  already has access to"** — just tap **Attach**, no recovery code needed.

## Using it

Once connected, sync runs automatically in the background on an interval —
there's nothing to click. Edit a note on your phone, it shows up on your
laptop within a sync cycle, and vice versa. Your laptop doesn't need to be
open for your phone to sync, or the other way around.

- Two devices editing **different parts** of the same note merge
  automatically.
- Two devices editing the **same part** of a note at the same time keep
  both versions — your edit is saved as a `(conflict)` copy next to the
  original, so nothing is ever silently lost.
- A small status indicator in the plugin settings shows whether everything
  is fully synced or if changes are still pending.

## Status

- Live and working day-to-day across desktop and Android.
- Not on the official Community Plugins list — install via BRAT (above).
- Not built yet: a web-based editor, multi-vault management in one view.

## Known limitations

- **Storage is capped, not metered or billed.** Each account gets a free
  250MB storage allowance (shown as a usage line in the plugin settings),
  and a global ceiling (`GLOBAL_STORAGE_CEILING_BYTES` in `wrangler.toml`,
  defaulting to 8GB — 80% of Cloudflare's free R2 tier) stops new signups
  before total usage could run up a real bill. There's no paid tier or
  billing integration yet — every account is free until that's built.

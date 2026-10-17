# Synora

Synora keeps your Obsidian vault in sync across devices — laptop, phone,
anywhere you use Obsidian — without any third-party service ever being able
to read your notes. You run your own backend on a server you control, install
one plugin, and your devices stay in sync automatically in the background.

## What you need

- An Obsidian vault (desktop and/or mobile)
- Somewhere to run Node 22+ (an EC2 instance, a VPS, a container host)
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account — used only
  for R2 object storage, which holds your encrypted files
- A free Postgres database (e.g. [Aiven](https://aiven.io/) or
  [Neon](https://neon.tech) have free tiers) — only needed once, during setup
- [Node.js](https://nodejs.org) and the [GitHub CLI](https://cli.github.com/)
  installed on the machine you're setting this up from

## Setup guide

### 1. Deploy your own backend

This is a one-time setup. You're deploying your own private copy of the
Synora server — nobody else can see or use it. It runs as an ordinary
Node service, so anything that runs Node will do: an EC2 instance, a
small VPS, or a container host.

**You need:** somewhere to run Node 22+, a Postgres database, and an R2
bucket for encrypted file storage.

Create the R2 bucket in the Cloudflare dashboard, then an API token
under **R2 → Manage R2 API Tokens** with *Object Read & Write* on it.
Note the access key id, secret, and your account id.

```sh
cd packages/backend
npm ci

cp .env.example .env     # then fill it in - every value is explained there
npm run db:migrate       # creates the schema
npm run build
npm start
```

The server listens on port 8787 by default. Put TLS in front of it —
nginx, Caddy, or an AWS load balancer — and point a hostname at it. The
plugin talks to that hostname, so it needs a real certificate.

To keep it running across reboots, either use the included `Dockerfile`,
or the `synora-backend.service` systemd unit. For a full EC2 walkthrough
— instance, TLS, systemd and cut-over — see
[`docs/deploy-ec2.md`](docs/deploy-ec2.md).

Save the public URL — you'll enter it into the plugin in step 3.

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

## For developers

- [`docs/architecture.md`](docs/architecture.md) — how the system works and
  why it makes the tradeoffs it does, including what has gone wrong in
  production and what it changed. Start here before touching sync code.
- [`docs/protocol-spec.md`](docs/protocol-spec.md) — the wire contract
  between plugin and backend.

## Known limitations

- **Storage is capped, not metered or billed.** Each account gets a free
  250MB storage allowance (shown as a usage line in the plugin settings),
  and a global ceiling (`GLOBAL_STORAGE_CEILING_BYTES` in the backend's
  defaulting to 8GB — 80% of Cloudflare's free R2 tier) stops new signups
  before total usage could run up a real bill. There's no paid tier or
  billing integration yet — every account is free until that's built.

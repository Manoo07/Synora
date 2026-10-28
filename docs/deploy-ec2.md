# Deploying the Synora backend on EC2

The backend is a plain Node service. It needs three things: somewhere to
run Node 22+, a Postgres database, and an R2 bucket. Cloudflare is used
for the bucket and nothing else.

Work through this top to bottom. The cut-over step at the end is the
only one that interrupts syncing.

---

## 1. The instance

A `t4g.small` is comfortable for a single-user vault — the service is
idle most of the time and its heaviest moment is hashing an upload.

Security group:

| port | source | why |
|---|---|---|
| 443 | anywhere | what the plugin talks to |
| 22 | your IP only | administration |

Nothing needs to reach port 8787 from outside; TLS terminates in front
of it and proxies to localhost.

```sh
sudo apt update && sudo apt install -y nginx git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## 2. The database

Either keep the managed Postgres you already have, or run one on the
instance. Managed is less to look after; local is faster and free.

If local:

```sh
sudo apt install -y postgresql
sudo -u postgres createuser --pwprompt synora
sudo -u postgres createdb --owner=synora synora
```

The connection string is then
`postgres://synora:<password>@localhost:5432/synora`.

## 3. R2 credentials

In the Cloudflare dashboard: **R2 → Manage R2 API Tokens → Create**, with
*Object Read & Write* scoped to your bucket. Keep the access key id and
secret; the account id is in the endpoint URL on the R2 overview page.

This is the only part of Cloudflare still in use.

## 4. The service

```sh
sudo useradd --system --home /opt/synora --shell /usr/sbin/nologin synora
sudo git clone https://github.com/Manoo07/Synora.git /opt/synora
sudo chown -R synora:synora /opt/synora

cd /opt/synora/packages/backend
sudo -u synora npm ci
sudo -u synora npm run build
```

Secrets go in a file only the service user can read — not in the unit
file, which is world-readable:

```sh
sudo mkdir -p /etc/synora
sudo cp packages/backend/.env.example /etc/synora/backend.env
sudo nano /etc/synora/backend.env      # fill in every required value
sudo chown synora:synora /etc/synora/backend.env
sudo chmod 600 /etc/synora/backend.env
```

Create the schema, then start it:

```sh
cd /opt/synora/packages/backend
sudo -u synora env $(grep -v '^#' /etc/synora/backend.env | xargs) npm run db:migrate

sudo cp synora-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now synora-backend
systemctl status synora-backend
curl -s localhost:8787/healthz        # {"ok":true}
```

## 5. TLS

The plugin will not talk to a plain-HTTP or self-signed host, so this
is required rather than optional.

```nginx
server {
  server_name sync.example.com;
  listen 443 ssl;

  # Attachments are large and the upload is a single request body.
  # nginx's 1MB default would reject them with a 413.
  client_max_body_size 110M;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # Long enough for a slow upload to finish on a poor connection.
    proxy_read_timeout 300s;
  }
}
```

`sudo certbot --nginx -d sync.example.com` issues the certificate and
fills in the TLS lines.

## 6. Cut over

Until this step the plugin is still talking to whatever it talked to
before, so everything above can be done at leisure.

1. Confirm the new host answers: `curl https://sync.example.com/healthz`
2. In Obsidian on **each** device: **Settings → Synora Sync → Server URL**,
   set the new host
3. Watch one device sync, then the rest

If the new deployment points at the **same** database and bucket, this is
only a change of address: every account, device, vault and file carries
over untouched, and no device needs to re-enrol.

If it points at a **fresh** database, every device has to register again
and re-upload. Your notes are safe either way — they live in your vault,
and the server only ever held encrypted copies.

## 7. Starting from an empty database

If this deployment points at a fresh database rather than an existing
one, the R2 bucket may still hold blobs from before. Nothing references
them any more, and garbage collection will never find them — it only
deletes what it can still see a row for — so they sit there consuming
the storage allowance indefinitely.

```sh
cd packages/backend
npx tsx scripts/r2-purge.ts --yes-delete-everything
```

Every device also has to start over: each one holds a device key, a
vault id and a sync cursor that now point at rows which no longer
exist. On each device, **Settings → Synora Sync → Use a different
account → Sign out**, then register again and use **Scan vault for
existing files** to upload. The notes themselves are never at risk —
they live in the vault, and the server only ever held encrypted copies.

## 8. Afterwards

- **Retire the old Worker** once a device has synced successfully against
  the new host. Keeping it running costs nothing, and leaving it up for a
  day is a cheap way back if something turns out to be wrong.
- **Back up Postgres.** The database holds the version history and the
  wrapped vault keys; R2 only holds blobs those rows point at. A nightly
  `pg_dump` to S3 or R2 is enough.
- **Watch the first garbage collection.** It runs daily at 03:17 UTC and
  logs a `Synora GC` line with counts. `npm run gc:dry-run` shows what it
  would remove, without removing anything.

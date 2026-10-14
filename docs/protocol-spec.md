# Synora sync protocol — v0 specification

This document defines the wire contract. For *why* the system is shaped
this way — the constraints, the rejected alternatives, and the production
failures that changed the design — see
[`architecture.md`](./architecture.md).

Status: draft for Phase 1 implementation. This is the contract the backend
(`packages/backend`) implements and that the Obsidian plugin (Phase 2) must
follow. Changing any of the wire formats below is a breaking protocol change
and requires a new `formatVersion`.

## 1. Threat model

What this protocol protects against:

- The hosting service (API operators, database, object storage) reading note
  content, attachment content, filenames, or folder paths.
- A network attacker between a device and the service reading or
  undetectably tampering with synced content.
- The service silently rolling back a file to an older version without a
  client noticing (detected via version chains + hashes, not fully prevented
  — see §7).

What this protocol does **not** protect against:

- A compromised or malicious device that has already decrypted the vault.
- A malicious or buggy plugin update running on a trusted device.
- The service withholding changes entirely (availability), or deliberately
  stalling the change feed. Clients should treat long silence as a health
  signal, not a security signal.
- Loss of all trusted devices and the recovery key — there is no
  password-based account recovery for vault content. This is a product
  decision, not an oversight.

## 2. Identity and key hierarchy

- **Account key pair**: created on first device enrollment; used to
  authenticate the account to the service. Not a content key.
- **Vault key** (`VK`): a random 256-bit key generated client-side when a
  vault is created. Never transmitted in plaintext. All file version
  ciphertexts for a vault are ultimately decryptable from `VK`.
- **Per-version data key**: derived per encryption operation via HKDF from
  `VK` with a unique `salt` (random, stored alongside ciphertext in the
  encrypted envelope, not as a DB column) and a `context` string identifying
  the operation type (`"file-content"`, `"filename"`, `"attachment"`). Using
  HKDF with distinct context strings, rather than reusing `VK` directly,
  means a nonce-reuse bug in one subsystem can't be combined with ciphertext
  from another subsystem.
- **Device key pair**: generated locally per device, never leaves the
  device. The public key is registered with the service and used to wrap
  (encrypt) `VK` for that device during enrollment.
- **Recovery key**: a separate randomly generated key, shown to the user
  once at vault creation, used only to wrap `VK` for the recovery path. The
  service stores the wrapped copy but never the recovery key itself.

`wrapped_vault_keys` holds one row per (vault, device) and one row per
(vault, recovery mechanism), each an encryption of `VK` under that
device's/recovery's public key, tagged with a `key_epoch`.

### Key rotation (`key_epoch`)

Revoking a device does not make that device forget `VK` — it has already
seen it. Rotation is the only real revocation: a new `VK'` is generated,
every file is eventually re-encrypted under it (lazily, on next write, or
eagerly via a background re-encryption job), `key_epoch` increments, and
`wrapped_vault_keys` is rewritten for all *remaining* trusted devices. The
revoked device can still read everything encrypted before rotation, but
nothing after. The MVP implements revocation (removing the device's wrapped
key row and access) and the `key_epoch` column, but treats full
eager re-encryption as a Phase 3+ concern — documented here so the schema
doesn't need to change later.

## 3. Encryption format

AEAD: XChaCha20-Poly1305 (24-byte random nonce, no nonce-reuse risk at
realistic message volumes per key). Implementations must use a reviewed
library (e.g. `libsodium`/`sodium-plus` client-side) — no hand-rolled
primitives.

Every encrypted blob uploaded to the service is an **envelope**, not raw
AEAD ciphertext:

```
EncryptedEnvelope {
  formatVersion: 1
  salt: bytes(16)        // HKDF salt for this envelope's data key
  context: string        // "file-content" | "filename" | "attachment"
  nonce: bytes(24)
  ciphertext: bytes       // AEAD output (includes 16-byte auth tag)
  aad: bytes               // authenticated-but-not-encrypted: see below
}
```

`aad` (additional authenticated data) binds the ciphertext to its intended
place in the system so it cannot be replayed into a different slot:
`vaultId || fileId || formatVersion || context`. The server treats `aad`'s
`vaultId`/`fileId` fields as opaque bytes for logging/debugging only — it
never decrypts anything.

The plaintext structure before encryption (the "manifest") for a file
content envelope:

```
interface EncryptedFilePayload {
  formatVersion: number;
  fileId: string;        // opaque, stable, server-assigned
  logicalPath: string;    // e.g. "Personal/Health.md" — encrypted, server never sees this
  mimeType?: string;
  content: Uint8Array;
}
```

Filenames/paths are encrypted as part of this payload, not sent as separate
plaintext fields anywhere in the API. The server's `files` table has no
`path` column — only opaque `id`s (§4).

## 4. Versioning model

- A **file** (`files` row) is an opaque identity (`id`) that persists across
  renames and edits. It is never recreated for a rename.
- A **file version** (`file_versions` row) is immutable once committed. It
  references `parent_version_id` (or `parent_version_ids` plural, for a
  merge commit — see §6). It stores `blob_key` (pointer into object
  storage), `ciphertext_hash` (SHA-256 of the raw ciphertext bytes, for
  integrity verification independent of the AEAD tag — catches storage
  corruption, not just tampering), and `size_bytes`.
- A **change event** (`change_events` row) is an append-only, per-vault
  ordered log entry: `(vault_id, sequence, file_id, version_id, operation)`
  where `operation ∈ {created, updated, renamed, deleted}`. `sequence` is a
  monotonically increasing integer allocated by the database inside the same
  transaction that accepts a commit — never client-supplied, never reused.
- A **device cursor** (`device_cursors` row) records the highest `sequence`
  a given device has durably applied. Sync resumes from `last_sequence + 1`.
- **Deletion** writes a tombstone change event (`operation = 'deleted'`) and
  a `files.deleted_at` timestamp. The row and its version history are kept
  for a grace period (default 30 days) before a garbage-collection job
  physically removes old blobs and rows — long enough for an offline device
  to see the tombstone before the evidence disappears.

## 5. Commit protocol (optimistic concurrency)

1. Client requests an upload slot: `POST /vaults/{vaultId}/uploads` →
   `{ uploadId, uploadUrl }`.
2. Client `PUT`s the envelope bytes to `uploadUrl`.
3. Client commits: `POST /vaults/{vaultId}/commits` with
   `{ fileId, baseVersionId, newVersionId, blobKey, ciphertextHash, sizeBytes, idempotencyKey }`.
4. Server, in one DB transaction:
   - Verifies the device is authorized for `vaultId`.
   - Verifies the uploaded blob exists, matches `sizeBytes`, and
     (re-hashed server-side) matches `ciphertextHash`. The server hashes
     ciphertext, not plaintext — it never decrypts.
   - Verifies `files.current_version_id = baseVersionId` (or `fileId` does
     not yet exist, for a create). If it doesn't match, the commit is
     rejected with `409 Conflict` and the current server-side version is
     returned so the client can reconcile. The server never overwrites a
     newer version with an older one, and never guesses an intended merge.
   - If `idempotencyKey` was already committed for this vault, returns the
     original result instead of creating a duplicate (safe retry after a
     dropped response).
   - Otherwise: allocates the next `sequence`, inserts `file_versions`,
     updates `files.current_version_id`, inserts `change_events`, commits.
5. Client advances its local state only after receiving `200 Committed`.

This transaction is the one place correctness is non-negotiable: it is the
only thing standing between concurrent writers and silent data loss.

## 6. Conflict resolution

See the architecture doc for the full policy table. Protocol-relevant
details:

- A merge produced by a client is committed as a normal new version, except
  `parent_version_id` may reference two parents (the local and remote
  versions it merged). The server does not interpret merge semantics; it
  only needs `baseVersionId` to equal the **remote** parent so the
  optimistic-concurrency check still holds.
- An unresolved conflict (overlapping edits, or any conflict involving a
  binary attachment) is committed as two sibling versions: the winning
  commit via the normal path, and a **conflict copy** — a new `files` row
  whose encrypted manifest carries a deterministic marker
  (`logicalPath` suffixed with a conflict marker, e.g.
  `"Personal/Health (conflict 2026-10-12).md"`) and metadata linking it back
  to the original `fileId` and the version it diverged from. The server
  stores this linkage as an opaque column (`files.conflict_of_file_id`) —
  it does not need to understand the content to preserve the relationship.

## 7. Integrity, replay, and rollback

- Every downloaded envelope is hash-verified (`ciphertext_hash`) and AEAD-tag
  verified before being applied to the vault. A mismatch is treated as
  corruption, not silently retried-and-accepted.
- Commits are idempotent via `idempotencyKey` (§5.4), so retried uploads
  after a network blip cannot double-commit.
- `aad` binding (§3) prevents a ciphertext blob from being replayed into a
  different file's slot even if an attacker controlled the service.
- **Not fully solved in v0**: a malicious server could present a stale
  change feed to one device while accepting new commits from another,
  effectively forking a device's view. Detecting this requires client-side
  cross-device consistency checks (e.g. periodic hash-chain comparison)
  which are out of scope for the MVP and documented as a known limitation.

## 8. Format versioning

`formatVersion` appears in both the envelope and the inner payload. A
client encountering a `formatVersion` it doesn't understand must refuse to
decrypt and surface an "unsupported format, update the plugin" error rather
than guessing. The server never inspects `formatVersion` for anything other
than passthrough storage — enforcing it is entirely a client responsibility.

## 9. Non-goals for v0 (see architecture doc §9 for full list)

Real-time collaboration, shared multi-user vaults, CRDTs, server-side
search, and multiple storage providers are explicitly out of scope and
would each require revisiting this spec.

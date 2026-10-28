# Pending work

A feature-parity and production-readiness backlog, triaged against what
the code actually does rather than against the design documents.

Status key:

| | Meaning |
|---|---|
| **done** | Implemented and covered by tests |
| **partial** | Works for the common case; the gap is named |
| **missing** | Not implemented |

Where something is marked done, the file or test that backs the claim is
named, so a reader can disagree with evidence rather than opinion.

---

## P0 — before anyone else uses this

### Data safety

| Item | Status | Notes |
|---|---|---|
| Offline editing: encrypted local writes, durable queue, retry on reconnect | **done** | `sync/queue.ts`, `sync/blob-store.ts`. Payload written before the metadata that references it, so a crash can only orphan a file, never queue an unsendable op |
| Crash-safe sync: idempotent retries, no cursor advance before durable | **done** | Idempotency checked first inside the commit transaction (`routes/sync.ts`); cursor advances only after the write lands (`engine.pull`) |
| Three-way merge, conflict copies, binary never merged | **done** | `sync/merge.ts`; 346k-case stress run shows no content loss |
| Delete vs. unsynced edit | **done** | The edit wins and the file is restored — `engine.resolveConflict`, test in `engine.test.ts` |
| Rename vs. edit, rename vs. rename | **done** | Converge; covered by the simulation suite |
| **Simultaneous create of the same path on two devices** | **missing** | The server cannot detect it — paths are encrypted, so two devices creating `notes/x.md` make two unrelated files. No deterministic client rule for collapsing them |
| **Filesystem reconciliation after a failed rename** | **missing** | **Known defect, reproducible.** See below |
| GC safety | **done** | `gc.ts`, 10 tests. Four conditions, all required; a long-offline device blocks collection rather than losing its tombstones |
| Initial bootstrap, and resync after a long offline period | **partial** | Replay from sequence zero works and GC protects it (a file's newest event is never collected). No snapshot/compaction, so bootstrap cost grows with history |
| **Key rotation and true revocation** | **missing** | Revoking a device removes its access but not the key it already holds. `key_epoch` exists in the schema; rotation does not. Documented in `architecture.md` |
| **Backup, restore and disaster recovery** | **missing** | No backup is configured and none has been restored. A backup that has never been restored is not a recovery mechanism |

### The known convergence defect

The multi-device simulation (`test/simulation.test.ts`) fails at seed 44.
The suite is committed red on purpose: the requirement it implements says
a failure blocks release, and excluding the seed to get a green tick is
the habit that let every previous bug reach production.

**Shape:** a device ends up holding a file at a path only it knows
about, created by its own rename. Three instances found; two fixed.

**Root cause, as far as it is understood:** `handleLocalRename` moves the
local file and its state record to the new path *before the server has
accepted anything*. If that rename never lands — the op is dropped, or a
conflict resolves in a way that abandons our path — nothing moves the
file back. The device keeps a file at a path the server has never heard
of, and no later event corrects it unless that same file happens to
change again.

Fixing instances one at a time is treating the symptom. The real fix is
reconciliation: after a flush, any local record whose path disagrees with
the server's current version for that file should be corrected. That is
the "filesystem reconciliation" item above.

Reproduce with `SIM_SEED=44 npx vitest run test/simulation.test.ts`,
which prints the full operation history.

---

## P1 — needed to run this as a service

### Operability

| Item | Status | Notes |
|---|---|---|
| Sync status: paused, syncing, pending, errors | **partial** | Status bar and settings line show both directions plus an ETA. No distinct "offline" or "connecting" state |
| Storage usage and limits | **partial** | Usage and device count shown in settings. No breakdown by history, no warning before the quota is reached |
| Device management | **partial** | List, approve, revoke, rename, and set a primary device all work. Does not show last activity, or which device is blocking reclamation |
| **Activity log** | **missing** | No per-file record of operations, retries or conflicts. Would have shortened several of this project's debugging sessions considerably |
| **Monitoring and alerting** | **missing** | Nothing instruments sync latency, failed commits, conflict-copy rate, orphaned blobs or storage growth. A feature that silently degrades into its safe fallback has already gone unnoticed once |
| **Protocol and envelope versioning in practice** | **partial** | Both carry a version and an unknown one is refused. No tested path for a device that has been offline across a server upgrade |

### User-facing

| Item | Status | Notes |
|---|---|---|
| **Version history UI** | **missing** | Versions are all retained server-side for the retention window; nothing exposes them. No restore, no diff, no undelete |
| **Conflict management UI** | **missing** | Conflict copies land as files beside the original. No listing, comparison or resolve-and-retry |
| Selective sync | **partial** | Whole-vault pause and per-file pause exist. No exclusion by folder or file type, and no defined behaviour when an exclusion changes |
| Configurable retention | **partial** | One server-wide `GC_RETENTION_DAYS`. Not per-account, and nothing separates notes from attachments or deleted files |
| Vault configuration sync | **partial** | Whole-bundle replace, explicitly opt-in, excluding workspace layout and this plugin's own identity. No per-setting selection, no history, no preview before applying |
| Initial-sync experience | **partial** | Attach and recovery flows exist and now show vault names and file counts. No progress indicator for the first download |
| Mobile lifecycle | **partial** | Works on Android day to day. Nothing handles OS background restrictions deliberately, and resume-on-reconnect is untested |
| Cross-platform filesystem behaviour | **partial** | A filename legal on macOS and rejected elsewhere has already broken sync once and is now skipped rather than fatal. Casing, Unicode and reserved names are untested |
| Large attachments | **partial** | Capped below the server limit and reported up front. No resumable or multipart upload; an interrupted 90MB upload starts over |

### Performance

| Item | Status | Notes |
|---|---|---|
| **Presigned R2 uploads** | **missing** | File bytes still pass through the server, which buffers and re-hashes each one. The last significant upload lever, and it would take that memory and bandwidth off the instance |
| Change-feed and lookup indexes | **done** | `change_events` indexed by `(vault_id, sequence)` and `(file_id, sequence)`; the second was added after collection went quadratic without it |
| Avoid re-uploading unchanged files | **done** | Content hash compared before queueing |
| Batched, incremental sync | **done** | Uploads run four at a time, one round trip per file, with idle backoff |

---

## P2 — only once the above is true

Multiple vaults per account with explicit connect and delete. Shared
vaults with membership and attribution. A documented recovery path when
every trusted device is gone. Headless or CLI sync. Account export and
verifiable deletion.

**Deliberately not deduplicating across accounts.** With randomised
encryption, identical plaintext produces different ciphertext, and
hash-based deduplication would leak the fact that two people hold the
same file.

---

## Four decisions worth settling

1. **Uncertain merges keep both.** Already the behaviour, and it should
   stay the default. A preference for aggressive merging could follow,
   but the asymmetry holds: a spurious conflict copy is an annoyance, a
   bad merge is lost writing.
2. **Offline is the normal case, not an error state.** Already true —
   the vault is fully usable and edits survive restart. Worth keeping in
   mind whenever the sync loop is changed.
3. **Retention versus bootstrap.** Replay-from-zero and collection are
   consistent today because a file's newest event is never collected, so
   a new device always has something to replay. That stops being enough
   if snapshots are introduced, and the two have to be reasoned about
   together.
4. **Configuration sync stays separate from note sync.** Correct as it
   is. The gap is granularity, not architecture.

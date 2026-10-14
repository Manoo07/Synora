# Synora — architecture and design rationale

This document explains **why Synora is built the way it is**: the
constraints it had to satisfy, the decisions that followed from them, the
alternatives that were rejected, and the things that went wrong in
production and changed the design.

It is the companion to [`protocol-spec.md`](./protocol-spec.md), which
defines the wire contract. This one explains the reasoning. Where the two
disagree, the spec wins on format and this one wins on intent.

Read this before changing anything in `packages/plugin/src/sync/` or
`packages/backend/src/routes/sync.ts`. Several things in there look
needlessly defensive and are not.

---

## 1. What Synora is

Synora syncs an Obsidian vault across devices. The hosting service can
never read note content, filenames, or folder structure.

```
┌─────────────────┐                      ┌─────────────────┐
│  Obsidian       │                      │  Obsidian       │
│  (desktop)      │                      │  (mobile)       │
│                 │                      │                 │
│  Synora plugin  │                      │  Synora plugin  │
│  ├ sync engine  │                      │  ├ sync engine  │
│  ├ crypto       │  ← all encryption    │  ├ crypto       │
│  └ pending queue│    happens here →    │  └ pending queue│
└────────┬────────┘                      └────────┬────────┘
         │         encrypted envelopes            │
         └──────────────────┬─────────────────────┘
                            ▼
            ┌───────────────────────────────┐
            │  Cloudflare Worker (Hono)     │
            │  - auth, quota, commit order  │
            │  - never decrypts anything    │
            └───────┬───────────────┬───────┘
                    ▼               ▼
            ┌──────────────┐  ┌──────────────┐
            │  Postgres    │  │  R2          │
            │  (metadata,  │  │  (encrypted  │
            │   ordering)  │  │   blobs)     │
            └──────────────┘  └──────────────┘
```

The server is a coordination and storage layer. All intelligence — diffing,
merging, conflict resolution, encryption — lives in the client. That
asymmetry is the single most important thing to understand about this
codebase, and it is the root of most of its difficulty.

---

## 2. The constraints everything else follows from

These were fixed before any code was written. Nearly every tradeoff in the
rest of this document is a consequence of one of them.

**C1 — The server must never be able to read anything.** Not content, not
filenames, not folder paths. This is the product's reason to exist.

**C2 — It must run free, indefinitely, on hobby infrastructure.**
Cloudflare Workers free tier, R2 free tier, a free Postgres. No paid
dependency, no billing integration.

**C3 — It must run inside an Obsidian plugin**, on desktop *and* mobile,
with no native code, no background process, and no control over when the
app is running.

**C4 — It must never silently lose an edit.** Losing a user's writing is
unrecoverable and unforgivable. Every other property — merge quality,
efficiency, convenience — is negotiable against this one.

### What C1 costs

Because the server can't read anything, it cannot:

- merge, diff, or resolve conflicts (it can't see content)
- search, index, or deduplicate
- validate that a commit is sensible beyond hashes and sizes
- do anything about a bad client except reject it on structural grounds

Everything the server would normally do, the client must do — on a phone,
in a JavaScript sandbox, with no guarantee it will still be running in a
second's time. The server's entire job reduces to: **authenticate, order,
store, and count bytes.** It does that one job strictly, and nothing else.

### What C3 costs

The plugin cannot assume it will be alive to finish anything. Obsidian may
close mid-upload. Mobile may suspend the app. Any multi-step operation must
be durable at every intermediate point, because there may be no "later".
This is why the pending queue exists and why its write ordering is
specified so carefully (§5).

---

## 3. Data model, and why it is shaped this way

Three concepts, all server-side and all content-blind:

| Concept | What it is | Why |
|---|---|---|
| **File** | An opaque, stable id | Survives renames. The server has no path column, so identity *cannot* be the path — it has to be a meaningless id. |
| **Version** | An immutable row: blob pointer, ciphertext hash, size | Immutability makes the concurrency check trivial and makes rollback detectable. |
| **Change event** | Append-only log entry with a per-vault `sequence` | Gives every device one total order to replay. Replaces any need for the server to understand causality. |

A device tracks the highest `sequence` it has applied and resumes from
there. That cursor is the whole sync state machine on the read side.

**Why a log and not state diffing?** A device that has been offline for a
month needs to catch up without downloading the whole vault and comparing.
An ordered log makes catch-up O(changes since cursor) and makes "what did I
miss" answerable without the server knowing what anything contains.

**Why the path lives inside the encrypted payload.** Paths leak almost
everything — `Health/2024/oncology-appointments.md` is the whole story
without a byte of content. So the path is encrypted *inside* the manifest,
and the server's `files` table genuinely has no path column. The cost: the
server cannot do anything path-aware, including detecting that two devices
created the same file, or cleaning up a folder. Those become client
problems, and §7 covers how that bit us.

---

## 4. The commit protocol, and the one place correctness is absolute

Upload blob → commit metadata → server validates and orders it.

The commit transaction is the only part of the system where a bug means
silent data loss rather than inconvenience. It:

1. takes a **per-vault advisory lock** (`pg_advisory_xact_lock`), so commits
   to one vault are strictly serialized
2. returns the previous result if the `idempotencyKey` was already used
3. verifies the blob exists and its size and hash match what was declared
4. verifies `files.current_version_id == baseVersionId` — **rejects with 409
   if not**
5. allocates the sequence, writes version + change event, commits

Step 4 is optimistic concurrency, and it is the load-bearing wall. The
server never overwrites a newer version with an older one and never guesses
at a merge. A client that lost the race gets told so and must reconcile.

**Why a coarse per-vault lock instead of per-file?** A vault is one user's
notes. Contention is effectively zero, and the sequence counter is per-vault
anyway so it would need serializing regardless. A per-file lock would buy
nothing real and add a deadlock surface. This is a deliberate choice to be
boring in the one place that must not be clever.

**Why the server hashes ciphertext, not plaintext.** It can't see plaintext.
The hash catches storage corruption independently of the AEAD tag, which
catches tampering. Different failure modes, both covered.

### Authentication is deliberately boring

Account auth is a standard password hash plus bearer tokens, using a
reviewed library. **Do not invent authentication here.** It is tempting,
because the vault key hierarchy is already bespoke cryptography and account
auth looks like more of the same. It is not the same: the key hierarchy
exists because no off-the-shelf scheme does what C1 requires, whereas
account login is an extremely solved problem where novelty is pure
downside.

Note also that account auth protects *access and quota*, not
confidentiality. Someone who defeats it gets encrypted blobs they cannot
read. The vault key is what protects content, and it never reaches the
server in any form.

---

## 5. The client sync engine

### The pending queue

Local edit → encrypt immediately → persist to a durable queue → upload
later. The queue is the durability boundary: once an edit is in it, it
survives Obsidian closing, and the plaintext never has to be re-derived.

Two storage locations, deliberately split:

- **Metadata** (path, ids, hashes) → the plugin's data blob
- **Payload** (the encrypted bytes) → one file per operation

They are split because Obsidian's `saveData` rewrites the *entire* plugin
data blob on every write. Keeping payloads inline meant every queue
mutation re-serialized every other pending attachment. See §7.6 — this one
was measured, not theorized.

**Write ordering is load-bearing**, and follows directly from C3:

- enqueue: **payload first, then metadata**
- remove: **metadata first, then payload**

Both orderings mean an interruption can only ever leave an *unreferenced
payload file*, which is cleaned up at startup. The opposite ordering would
leave a queued operation whose payload never existed — permanently
unsendable, blocking the queue behind it forever. One ordering fails safe,
the other fails fatal. There is no third option where both are fine.

### Coalescing by path

Multiple edits to one file before a sync cycle collapse into one queued
operation. Without this, editing a document across a few paragraphs queues
several operations that all carry the *same* `baseVersionId` — the first
commits, and every subsequent one is now stale against that very commit.
The user gets conflict copies of their own document, on one device, with no
other device involved. This happened in production (§7.3).

### Echo suppression

When the engine writes a pulled change into the vault, Obsidian fires a
normal file-change event, indistinguishable from the user typing. Without
suppression this is an infinite loop.

Suppression is keyed on **(path, content hash)**, not a global "syncing"
flag. A global flag would also swallow a genuine user edit that lands in
the same window — trading a loop for silent data loss, which violates C4.
Deletes have no content to hash, so they carry a reserved marker instead;
they were originally exempt from suppression entirely, which cost real money
(§7.4).

### Merge policy

| Situation | Behaviour |
|---|---|
| One side changed | Apply it |
| Both changed, non-overlapping, text | Three-way merge |
| Both changed, overlapping | Keep both — conflict copy |
| Any binary file | Keep both — conflict copy |
| Merge logic unsure for any reason | Keep both — conflict copy |

Only `.md`, `.markdown`, `.txt` are ever merged. The fallback is always
"preserve both versions as separate files". **A spurious conflict copy is a
minor annoyance; a bad merge is lost writing.** The asymmetry is
intentional and the merge code is written to fall back aggressively.

---

## 6. Why merging is genuinely hard here (not just fiddly)

The merge is a line-based three-way merge: diff base→local, diff
base→remote, apply both if they don't overlap.

The two diffs are computed **independently**, and that is the source of a
whole bug class. Around repeated identical lines — blank lines between
paragraphs, repeated list items, `---` separators — a diff is free to
describe one edit as any of several equivalent sets of changes. The two
independent diffs have no way to agree with each other about *which*
physical line is which.

Concretely, with this base:

```
anchor
same
same
same
same
```

If one device deletes the second line and another deletes the fourth, both
diffs report "a line was deleted" in a form that looks *identical*. Treating
that as "both made the same edit, apply it once" drops one deletion. The
device whose deletion vanished still has it locally, so it re-proposes it
next sync, merges wrong again, and the two devices re-resolve the same
conflict forever. That is not hypothetical — it reached a user, and they
disabled the plugin (§7.1).

**The underlying problem is undecidable.** When lines are byte-identical,
"which one did they delete" has no answer in the text. No amount of
cleverness recovers information that was never encoded.

So the design accepts a boundary:

- Where ambiguity could cause **content loss**, refuse to merge and
  preserve both versions. Verified empirically: across 346k adversarial
  cases, zero merges lose content.
- Where ambiguity only affects **placement** among indistinguishable lines,
  accept it. Content is fully preserved, the result is deterministic, and it
  converges rather than looping.

**An alternative was tested and rejected:** refusing to merge whenever the
base contains any duplicate line at all. That reached zero mismatches of any
kind — and turned ~75% of realistic note edits into conflict copies, because
real notes are full of blank lines. Correct and useless. The shipped
boundary keeps ~90% of realistic concurrent edits merging cleanly.

**Why not CRDTs or operational transforms?** They would dissolve this entire
class of problem. They also require intercepting edits at keystroke level,
which the Obsidian plugin API does not offer (C3); a per-document operation
history, which inflates storage against a 250MB cap (C2); and a format
migration for every existing vault. The honest summary: CRDTs are the right
answer for a real-time collaborative editor, and this is a file sync for one
person's devices that are rarely online simultaneously. The conflict-copy
fallback is cheap and safe; CRDTs are expensive and correct. For this
workload the tradeoff does not favor them yet.

---

## 7. Setbacks: what actually went wrong, and what it changed

This section exists because these were *not* obvious in review, and several
look fine in the code right up until production. They are the real
justification for the defensive code noted above.

### 7.1 The merge dropped edits around repeated lines

**Symptom:** two devices looped re-resolving the same conflict; a user
disabled the plugin.

**Cause:** as §6 describes, two independently-computed diffs produced
identical-looking changes for two genuinely different deletions.

**Fix and lesson:** only collapse "both sides made the same edit" when the
affected lines are uniquely identifiable in the file. The first fix checked
whether the deleted *block* repeated — it missed a second variant, because a
diff can reassemble one edit from lines taken anywhere, so a block that
looks unique can still be built from repeating lines. The check has to be
per line.

The broader lesson: **this bug class is invisible to example-based testing.**
It was found by generating hundreds of thousands of adversarial cases against
a constructed ground truth. Any change to merge logic should be re-validated
that way, not by adding another hand-written test.

### 7.2 Automatic merging silently died on active vaults

**Symptom:** conflict copies accumulating where clean merges should have
happened — but only on vaults that had been in use for a while.

**Cause:** conflict resolution resolved version ids by scanning the change
feed from the beginning, capped at 500 entries, oldest-first. Every save is
a change event. Once a vault's history exceeded one page, the versions it
needed were never in the window, so *every* concurrent edit fell back to a
conflict copy. Permanently.

**Fix and lesson:** a targeted version-lookup endpoint. The lesson is
sharper than the fix: **the feature degraded into its own safe fallback, so
nothing ever errored.** It was invisible in logs and in tests, because tests
ran against small vaults. Fallback paths need their own alerting, or they
hide the failure they were built to absorb. The test fake had also been
ignoring the `limit` parameter, which is precisely why no test caught it —
fakes that are more forgiving than production are worse than no fakes.

### 7.3 One device conflicting with itself

**Symptom:** conflict copies of a document edited on a single device, no
other device involved.

**Cause:** each edit queued a separate operation, all sharing the same
`baseVersionId` because nothing had committed yet to advance it. The first
succeeded; the rest were stale against it.

**Fix:** coalesce queued operations by path (§5).

### 7.4 Deletes echoed back as phantom files

**Symptom:** storage usage climbing with no visible cause.

**Cause:** deletes were exempt from echo suppression. Applying a remote
delete fired a local delete event, which was re-sent as a new delete. By
then the local record was gone, so it carried no file id — and a commit
without a file id always creates a new file. Every device receiving any
delete committed a phantom file, version, change event and blob, each
counted against the account's quota.

**Lesson:** the suppression design handled content writes correctly and
simply didn't cover the one operation without content. When a mechanism is
keyed on a value, the case where that value doesn't exist needs an explicit
decision, not an implicit skip.

### 7.5 Folder renames duplicated entire trees

**Symptom:** mobile showing both the old and new folder structure.

**Cause:** the rename handler ignored folder events, assuming Obsidian would
cascade to per-file events. It does not reliably. The files were re-uploaded
at new paths while the old paths stayed committed.

**Lesson:** a direct consequence of §3 — the server cannot help here,
because it has no concept of a folder or a path. Anything path-shaped is
entirely the client's responsibility, including cases the client didn't know
existed.

### 7.6 Attachments thrashed the plugin data file

**Symptom:** slowness and risk of hangs when importing images, worst on
mobile.

**Cause:** queued operations stored the whole encrypted file inline, in the
blob Obsidian rewrites in full on every write. Measured: importing twenty
3MB photos wrote **1.56 GB** through that one file, with everything held in
memory to serialize. Cost grows with the square of what is queued.

**Fix:** payloads moved to one file each (§5). The same import now writes
0.1 MB of metadata.

**Lesson:** the original design was fine for notes — a few KB each — and the
failure only appeared with attachments. Worth stating plainly: *this system
was designed around text files and grew attachments later*, and that seam is
where several problems have surfaced.

### 7.7 Accounts stuck at an old device limit

**Cause:** Postgres `ALTER TABLE ... ADD COLUMN ... DEFAULT` backfills
existing rows with the default **as it was at that moment**. Later migrations
changed the default for new rows and never touched already-backfilled ones.

**Lesson:** changing a column default is not a data change. Any default
change needs an explicit `UPDATE` for existing rows, or it silently applies
to new accounts only.

### 7.8 One bad file blocking all sync

**Cause (twice, in two places):** a single failing item threw out of the
whole loop. On the read side, a filename legal on macOS but illegal on
another device failed, and since the cursor never advanced, every subsequent
sync hit the same file and stopped. On the write side, one malformed queued
operation blocked everything behind it.

**Fix:** per-item error handling in both loops, distinguishing permanent
failures (drop and report) from transient ones (leave queued, retry).

**Lesson:** in a loop that processes a durable queue, an unhandled error
isn't one failure — it's a permanent outage for everything behind it.

---

## 8. Known limitations

Honest list. None of these are oversights; all are either accepted
tradeoffs or acknowledged debt.

**Storage is only ever added, never reclaimed.** Every version ever
committed counts against the 250MB quota forever. Deleting a file *increases*
usage, because the tombstone is itself a commit. The protocol spec describes
a 30-day grace period and a garbage-collection job — **that job does not
exist.** There are no scheduled workers at all. This is the most significant
piece of outstanding debt and the most likely thing to bite a long-running
vault.

**Merge placement near identical lines is arbitrary** (§6). Content-safe,
convergent, but it may not put text exactly where a human would.

**No cleanup for damage already done.** The fixes in §7 prevent recurrence;
they don't repair phantom files or duplicates already committed. That needs a
deliberate cleanup tool that doesn't exist yet.

**Device revocation is partial.** Removing a device's access does not make it
forget the vault key it already has. Real revocation requires key rotation,
which the schema supports (`key_epoch`) and the code does not implement.

**A malicious server can fork a device's view** by serving a stale change
feed to one device while accepting commits from another. Detecting this needs
cross-device consistency checks. Documented in the spec, not solved.

**No billing.** A global storage ceiling stops new signups before real cost
accrues. That is a brake, not a business model.

**Preferences sync is a whole-bundle replace** with no merge and no history.
It is explicitly user-triggered, never automatic, because overwriting another
device's settings silently would be worse than not syncing them.

---

## 9. Non-goals

Explicitly out of scope. Each would require revisiting the protocol:

- Real-time collaboration or shared multi-user vaults
- Server-side search or indexing (impossible under C1 without leaking)
- Multiple storage backends
- A web editor
- Password-based recovery of vault content — if all devices and the
  recovery key are lost, the data is unrecoverable **by design**

---

## 10. If you are changing this code

- **`merge.ts`** — validate with adversarial generation, not examples
  (§7.1). Falling back to a conflict copy is always acceptable; merging
  wrongly never is.
- **The commit transaction** — the only place where a bug is unrecoverable.
  Treat the optimistic-concurrency check as untouchable.
- **The pending queue** — write ordering is deliberate (§5). Reversing it
  trades a recoverable failure for an unrecoverable one.
- **Anything path-shaped** — the server cannot help you (§3). Assume no
  cascading events from Obsidian; handle the tree yourself.
- **Test fakes** — must be at least as strict as production. A forgiving
  fake hid §7.2 completely.
- **Fallback paths** — if a feature can silently degrade into its safe
  fallback, something has to notice. §7.2 ran broken for an unknown length
  of time because nothing ever errored.

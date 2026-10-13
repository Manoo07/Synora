import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// --- Account identity -------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  // Storage quota bookkeeping. storageBytesUsed is a running total
  // maintained by the commit path (sync.ts), not computed on the fly -
  // summing storage_objects on every commit would get slower as history
  // grows, and it's never pruned today (every version, including
  // superseded ones, stays in storage_objects forever).
  plan: text("plan", { enum: ["free", "paid"] }).notNull().default("free"),
  storageLimitBytes: bigint("storage_limit_bytes", { mode: "number" }).notNull().default(250 * 1024 * 1024),
  storageBytesUsed: bigint("storage_bytes_used", { mode: "number" }).notNull().default(0),
  // Counts devices with status != "revoked" (a revoked device frees its
  // slot back up). Checked only when a login sees a brand-new device
  // public key for this account - see routes/auth.ts. Unlike the storage
  // quota/global ceiling above, a device count isn't a real cost driver
  // (no meaningful extra R2/Postgres/Workers cost per device) - this is
  // pure pricing-tier groundwork. Free-tier default is 7.
  deviceLimit: integer("device_limit").notNull().default(7),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex("users_email_idx").on(t.email),
}));

// --- Vaults and device registry ---------------------------------------

export const vaults = pgTable("vaults", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  keyEpoch: integer("key_epoch").notNull().default(1),
  // The device whose Obsidian preferences (theme, community plugins,
  // settings, hotkeys) are the source of truth for this vault - see
  // routes/sync.ts's /preferences endpoints. Nullable: a vault with no
  // primary set yet just means no device has claimed it. Set to the
  // creating device by default (routes/vaults.ts POST /), reassignable
  // by any device on the vault afterward.
  primaryDeviceId: uuid("primary_device_id").references(() => devices.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  publicKey: text("public_key").notNull(),
  name: text("name").notNull().default(""),
  status: text("status", { enum: ["active", "pending", "revoked"] }).notNull().default("active"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vaultMembers = pgTable("vault_members", {
  vaultId: uuid("vault_id").notNull().references(() => vaults.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: text("role", { enum: ["owner", "member"] }).notNull().default("owner"),
}, (t) => ({
  pk: uniqueIndex("vault_members_pk").on(t.vaultId, t.userId),
}));

// --- Files and immutable version history --------------------------------

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  vaultId: uuid("vault_id").notNull().references(() => vaults.id),
  currentVersionId: uuid("current_version_id"),
  // Opaque link to the original file this one was split off from as an
  // unresolved conflict copy. Null for ordinary files. See protocol-spec §6.
  conflictOfFileId: uuid("conflict_of_file_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vaultIdx: index("files_vault_idx").on(t.vaultId),
}));

export const fileVersions = pgTable("file_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileId: uuid("file_id").notNull().references(() => files.id),
  // Nullable: a version may have 0 (initial create), 1 (normal edit), or
  // 2 (merge commit) parents. Parent ids are stored as a small jsonb array
  // rather than a join table since the fan-out is tiny and fixed.
  parentVersionIds: jsonb("parent_version_ids").notNull().$type<string[]>().default([]),
  blobKey: text("blob_key").notNull(),
  ciphertextHash: text("ciphertext_hash").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  fileIdx: index("file_versions_file_idx").on(t.fileId),
}));

// --- Ordered per-vault change feed --------------------------------------

export const changeEvents = pgTable("change_events", {
  vaultId: uuid("vault_id").notNull().references(() => vaults.id),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  fileId: uuid("file_id").notNull().references(() => files.id),
  versionId: uuid("version_id").references(() => fileVersions.id),
  operation: text("operation", { enum: ["created", "updated", "renamed", "deleted"] }).notNull(),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: uniqueIndex("change_events_pk").on(t.vaultId, t.sequence),
  idemIdx: uniqueIndex("change_events_idem_idx").on(t.vaultId, t.idempotencyKey),
}));

export const deviceCursors = pgTable("device_cursors", {
  deviceId: uuid("device_id").notNull().references(() => devices.id),
  vaultId: uuid("vault_id").notNull().references(() => vaults.id),
  lastSequence: bigint("last_sequence", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: uniqueIndex("device_cursors_pk").on(t.deviceId, t.vaultId),
}));

// --- Rate limiting -------------------------------------------------------

// Fixed-window counter, serialized per key via pg_advisory_xact_lock in
// auth/rate-limit.ts - the same technique already used for conditional
// commits (routes/sync.ts). A prior KV-based counter and Cloudflare's
// native rate-limit binding were both tried and confirmed live to not
// actually enforce anything under concurrent requests (no atomicity
// between reading and writing the count). This table, guarded by the
// advisory lock, is genuinely atomic.
export const rateLimitCounters = pgTable("rate_limit_counters", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(1),
});

// --- Storage and key distribution ---------------------------------------

export const storageObjects = pgTable("storage_objects", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().default("r2"),
  objectKey: text("object_key").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  vaultId: uuid("vault_id").notNull().references(() => vaults.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  objectKeyIdx: uniqueIndex("storage_objects_key_idx").on(t.objectKey),
}));

export const wrappedVaultKeys = pgTable("wrapped_vault_keys", {
  vaultId: uuid("vault_id").notNull().references(() => vaults.id),
  // Either a deviceId or a sentinel "recovery" row — kept as a plain text
  // discriminator column rather than a nullable FK plus enum, since the
  // recovery row has no device to reference.
  holderType: text("holder_type", { enum: ["device", "recovery"] }).notNull(),
  holderId: text("holder_id").notNull(),
  keyEpoch: integer("key_epoch").notNull(),
  wrappedKey: text("wrapped_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: uniqueIndex("wrapped_vault_keys_pk").on(t.vaultId, t.holderType, t.holderId, t.keyEpoch),
}));

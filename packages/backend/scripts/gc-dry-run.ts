// Reports what storage reclamation would free, without deleting
// anything. Run this against real data before the first scheduled run:
// everything already past the retention window becomes eligible at
// once, and deletion has no undo.
//
//   DATABASE_URL=<connection string> npx tsx scripts/gc-dry-run.ts
//
// Takes no R2 binding, because a dry run never touches blob storage.
import { openDb } from "../src/db/client.js";
import { collectGarbage, DEFAULT_RETENTION_DAYS } from "../src/gc.js";
import type { AppBindings } from "../src/context.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const retentionDays = Number(process.env.GC_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
const { db, close } = openDb(connectionString);

const bindings = {
  DB: db,
  // Never called on a dry run; present only to satisfy the shape.
  BUCKET: {
    put: async () => undefined,
    get: async () => null,
    head: async () => null,
    delete: async () => {
      throw new Error("dry run must not delete blobs");
    },
  },
  JWT_SECRET: "unused",
  GLOBAL_STORAGE_CEILING_BYTES: 0,
} as unknown as AppBindings;

try {
  const result = await collectGarbage(bindings, { retentionDays, dryRun: true });
  const mb = (result.bytesReclaimed / (1024 * 1024)).toFixed(1);
  console.log(`Retention window: ${retentionDays} days`);
  console.log(`Vaults scanned:   ${result.vaultsScanned}`);
  console.log(`Versions to drop: ${result.versionsCollected}`);
  console.log(`Deleted files:    ${result.filesRemoved}`);
  console.log(`Would reclaim:    ${mb} MB`);
  console.log("\nNothing was deleted.");
} finally {
  await close();
}

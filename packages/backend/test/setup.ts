import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/client.js";
import { MemoryBucket } from "./fakes/memory-bucket.js";
import type { AppBindings } from "../src/context.js";

const CONNECTION_STRING = process.env.DATABASE_URL ?? "postgres://synora:synora@localhost:5435/synora";

let sql: ReturnType<typeof postgres> | undefined;
let db: Db | undefined;

export function testDb(): Db {
  if (!db) {
    sql = postgres(CONNECTION_STRING, { max: 5 });
    db = drizzle(sql, { schema });
  }
  return db;
}

export async function resetDb() {
  // TRUNCATE ... CASCADE handles FK ordering for us.
  await testDb().execute(
    `truncate table
      wrapped_vault_keys, storage_objects, device_cursors, change_events,
      file_versions, files, vault_members, devices, vaults, users,
      rate_limit_counters
     restart identity cascade` as never,
  );
}

export function testBindings(overrides: Partial<AppBindings> = {}): AppBindings {
  return {
    DB: testDb(),
    BUCKET: new MemoryBucket(),
    JWT_SECRET: "test-secret",
    GLOBAL_STORAGE_CEILING_BYTES: 8_000_000_000,
    ...overrides,
  };
}

export async function closeTestDb() {
  await sql?.end();
}

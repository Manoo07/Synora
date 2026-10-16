import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

// One pool for the process, opened at startup and kept.
//
// This used to open a fresh pool per request, because Workers forbid
// reusing a socket across requests - each one gets its own I/O context,
// so a connection opened during one could not be read from during the
// next. Nothing about that applies to a long-running Node process, and
// the workaround was expensive in a way that eventually bit: the pool
// had to stay tiny to avoid multiplying across concurrent requests, and
// four parallel uploads still managed to exhaust the origin limit and
// surface as 503s. A single shared pool is both simpler and the thing
// connection limits are actually designed around.
export function openDb(connectionString: string, poolSize = 10): DbHandle {
  const sql = postgres(connectionString, {
    max: poolSize,
    idle_timeout: 20,
    // Postgres hosts drop connections that sit too long; without an
    // upper bound the pool can hand out one the server has already
    // forgotten, which fails as a confusing mid-query disconnect.
    max_lifetime: 60 * 30,
  });
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end() };
}

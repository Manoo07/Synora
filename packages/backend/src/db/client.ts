import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

// Workers forbids reusing I/O objects (sockets, streams) across requests —
// each request gets its own isolate-level I/O context, so a postgres.js
// connection opened during one request cannot be read from during the
// next ("Cannot perform I/O on behalf of a different request"). That rules
// out the usual "cache the client at module scope" pattern here: we open a
// fresh connection per request and close it once the request is done.
// Hyperdrive maintains the real connection pool on Cloudflare's side, so
// this is cheap in practice, not a full TCP handshake every time.
export function openDb(connectionString: string): DbHandle {
  const sql = postgres(connectionString, { max: 5, idle_timeout: 20 });
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end() };
}

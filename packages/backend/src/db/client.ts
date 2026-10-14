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
  // One connection is all a request ever uses - every route, including
  // the commit transaction, runs its queries one after another. The
  // pool of five was spare capacity nothing drew on, and it multiplied:
  // once the client began uploading four files at once, four requests
  // times five reached Hyperdrive's origin limit of twenty exactly, so
  // any pull or status check happening alongside them was refused and
  // surfaced to the person as a 503. Two leaves headroom without
  // pretending a request needs more.
  const sql = postgres(connectionString, { max: 2, idle_timeout: 20 });
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end() };
}

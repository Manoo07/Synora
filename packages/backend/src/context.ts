import type { Db } from "./db/client.js";
import type { BlobBucket } from "./storage/types.js";

// Everything the app needs from the outside world, named explicitly
// rather than reached for through globals or module-level singletons.
//
// This is what made moving off Workers to a Node server cost nothing
// below this line: server.ts builds one of these at startup from
// environment variables, the tests build one by hand, and not a single
// route can tell the difference. Keep it that way - a route that
// imports a database or a bucket directly re-welds the app to one
// runtime and takes the tests' seam with it.
export interface AppBindings {
  DB: Db;
  BUCKET: BlobBucket;
  JWT_SECRET: string;
  // Sum of every account's storageBytesUsed must stay under this before a
  // *new* signup is allowed - protects the operator's R2 allowance from
  // being run up by a wave of signups before there's a billing story in
  // place. Existing accounts' syncing is never affected by this - see
  // routes/auth.ts.
  GLOBAL_STORAGE_CEILING_BYTES: number;
}

export interface AppVariables {
  userId: string;
  deviceId: string;
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

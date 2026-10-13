import type { Db } from "./db/client.js";
import type { BlobBucket } from "./storage/types.js";

// Bindings is deliberately our own shape, not Cloudflare's raw Env — the
// Worker entrypoint (index.ts) adapts real bindings (Hyperdrive, R2,
// secrets) into this shape, and tests construct the same shape directly
// without needing Miniflare/wrangler at all.
export interface AppBindings {
  DB: Db;
  BUCKET: BlobBucket;
  JWT_SECRET: string;
  RATE_LIMIT: KVNamespace;
}

export interface AppVariables {
  userId: string;
  deviceId: string;
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

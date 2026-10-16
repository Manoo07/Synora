import { serve } from "@hono/node-server";
import cron from "node-cron";
import { app } from "./index.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/client.js";
import { R2BlobBucket } from "./storage/r2.js";
import { collectGarbage } from "./gc.js";
import type { AppBindings } from "./context.js";

const config = loadConfig();

// Built once and handed to every request, where the Worker rebuilt it
// per request because it had to. The routes are unchanged: they always
// took their dependencies as this object rather than reaching for a
// global, which is the only reason this migration touches the edges
// alone.
const { db, close: closeDb } = openDb(config.databaseUrl, config.databasePoolSize);
const bucket = new R2BlobBucket(config.r2.bucket, config.r2);

const bindings: AppBindings = {
  DB: db,
  BUCKET: bucket,
  JWT_SECRET: config.jwtSecret,
  GLOBAL_STORAGE_CEILING_BYTES: config.globalStorageCeilingBytes,
};

const server = serve({ fetch: (request) => app.fetch(request, bindings), port: config.port }, (info) => {
  console.log(`Synora backend listening on :${info.port}`);
});

// Storage reclamation, which the Workers cron trigger used to drive.
// Nothing else removes superseded versions, so without it every
// account's usage only climbs until it wedges against its quota.
//
// In-process rather than a system cron: it needs the same database pool
// and bucket credentials the server already holds, and running it as a
// separate invocation would mean a second copy of all of that.
const gcTask = cron.schedule(config.gcCron, () => {
  void (async () => {
    try {
      const result = await collectGarbage(bindings, { retentionDays: config.gcRetentionDays });
      console.log("Synora GC", JSON.stringify(result));
    } catch (err) {
      console.error("Synora GC run failed", err);
    }
  })();
});

// A restart or deploy sends SIGTERM. Finish what is in flight and hand
// back the database connections rather than letting the host reap them,
// which otherwise leaves the server holding slots nothing is using.
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    gcTask.stop();
    server.close(() => {
      void closeDb().finally(() => {
        bucket.destroy();
        process.exit(0);
      });
    });
    // Do not hang forever on a connection that will not drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

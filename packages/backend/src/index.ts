import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppEnv, AppBindings } from "./context.js";
import { openDb } from "./db/client.js";
import { HttpError } from "./lib/errors.js";
import { authRoutes } from "./routes/auth.js";
import { vaultRoutes } from "./routes/vaults.js";
import { syncRoutes } from "./routes/sync.js";
import { accountRoutes } from "./routes/account.js";
import { collectGarbage } from "./gc.js";

export const app = new Hono<AppEnv>();

app.route("/v1/auth", authRoutes);
app.route("/v1/vaults", vaultRoutes);
app.route("/v1/vaults", syncRoutes);
app.route("/v1/account", accountRoutes);

app.get("/healthz", (c) => c.json({ ok: true }));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.code, message: err.message }, err.status as never);
  }
  if (err instanceof ZodError) {
    return c.json({ error: "bad_request", message: err.issues.map((i) => i.message).join("; ") }, 400);
  }
  console.error(err);
  return c.json({ error: "internal_error", message: "Something went wrong" }, 500);
});

// --- Cloudflare Worker entrypoint ------------------------------------
//
// Real Cloudflare bindings (Hyperdrive, R2, secrets) are adapted into our
// own AppBindings shape here. Tests never go through this file — they call
// `app.fetch(request, bindings)` directly with a hand-built bindings
// object, so no Miniflare/wrangler runtime is needed to run them.

interface WorkerBindings {
  HYPERDRIVE: { connectionString: string };
  BUCKET: AppBindings["BUCKET"];
  JWT_SECRET: string;
  GLOBAL_STORAGE_CEILING_BYTES: string;
  // Optional override for how long superseded versions are kept before
  // GC may reclaim them. Unset uses gc.ts's default.
  GC_RETENTION_DAYS?: string;
}

function toBindings(env: WorkerBindings, db: AppBindings["DB"]): AppBindings {
  return {
    DB: db,
    BUCKET: env.BUCKET,
    JWT_SECRET: env.JWT_SECRET,
    GLOBAL_STORAGE_CEILING_BYTES: Number(env.GLOBAL_STORAGE_CEILING_BYTES),
  };
}

export default {
  // Storage reclamation. Nothing else removes superseded versions, so
  // without this every account's usage only climbs until it wedges
  // against its quota. See gc.ts for the rules it collects under.
  async scheduled(_event: ScheduledController, env: WorkerBindings, ctx: ExecutionContext): Promise<void> {
    const { db, close } = openDb(env.HYPERDRIVE.connectionString);
    try {
      const result = await collectGarbage(toBindings(env, db), {
        retentionDays: env.GC_RETENTION_DAYS ? Number(env.GC_RETENTION_DAYS) : undefined,
      });
      console.log("Synora GC", JSON.stringify(result));
    } catch (err) {
      console.error("Synora GC run failed", err);
    } finally {
      ctx.waitUntil(close());
    }
  },

  async fetch(request: Request, env: WorkerBindings, ctx: ExecutionContext): Promise<Response> {
    const { db, close } = openDb(env.HYPERDRIVE.connectionString);
    const bindings: AppBindings = toBindings(env, db);
    try {
      return await app.fetch(request, bindings, ctx);
    } finally {
      // Safe to close synchronously-ish here: every route in this app
      // resolves its DB work (and reads any Response body it builds into
      // memory) before returning, so there's no in-flight query left
      // depending on this connection after `app.fetch` resolves.
      ctx.waitUntil(close());
    }
  },
};

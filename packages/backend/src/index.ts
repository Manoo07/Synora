import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppEnv, AppBindings } from "./context.js";
import { openDb } from "./db/client.js";
import { HttpError } from "./lib/errors.js";
import { authRoutes } from "./routes/auth.js";
import { vaultRoutes } from "./routes/vaults.js";
import { syncRoutes } from "./routes/sync.js";

export const app = new Hono<AppEnv>();

app.route("/v1/auth", authRoutes);
app.route("/v1/vaults", vaultRoutes);
app.route("/v1/vaults", syncRoutes);

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
  RATE_LIMIT: AppBindings["RATE_LIMIT"];
}

export default {
  async fetch(request: Request, env: WorkerBindings, ctx: ExecutionContext): Promise<Response> {
    const { db, close } = openDb(env.HYPERDRIVE.connectionString);
    const bindings: AppBindings = {
      DB: db,
      BUCKET: env.BUCKET,
      JWT_SECRET: env.JWT_SECRET,
      RATE_LIMIT: env.RATE_LIMIT,
    };
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

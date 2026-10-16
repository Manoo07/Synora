import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppEnv } from "./context.js";
import { HttpError } from "./lib/errors.js";
import { authRoutes } from "./routes/auth.js";
import { vaultRoutes } from "./routes/vaults.js";
import { syncRoutes } from "./routes/sync.js";
import { accountRoutes } from "./routes/account.js";

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
// The app itself is runtime-agnostic: it takes its database, bucket and
// secrets as an explicit bindings object rather than reaching for
// globals, so it runs unchanged under a Node server (src/server.ts) and
// under the test suite, which calls `app.fetch(request, bindings)`
// directly with a hand-built bindings object.

import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { app } from "../src/index.js";
import { users } from "../src/db/schema.js";
import { resetDb, testBindings, closeTestDb } from "./setup.js";
import { registerUser } from "./helpers.js";

describe("auth", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("registers a new account and its first device as active", async () => {
    const bindings = testBindings();
    const result = await registerUser(bindings, "alice@example.com");
    expect(result.accessToken).toBeTruthy();
    expect(result.deviceId).toBeTruthy();
  });

  it("rejects duplicate registration", async () => {
    const bindings = testBindings();
    await registerUser(bindings, "alice@example.com");
    const res = await app.request(
      "/v1/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com", password: "password123", devicePublicKey: "pk-2" }),
      },
      bindings,
    );
    expect(res.status).toBe(400);
  });

  it("logs in an already-known device", async () => {
    const bindings = testBindings();
    await registerUser(bindings, "alice@example.com");
    const res = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.com",
          password: "password123",
          devicePublicKey: "pk-alice@example.com-1",
        }),
      },
      bindings,
    );
    expect(res.status).toBe(200);
  });

  it("marks a never-seen device as pending - it gets an account token but no vault access", async () => {
    const bindings = testBindings();
    await registerUser(bindings, "alice@example.com");
    const res = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.com",
          password: "password123",
          devicePublicKey: "brand-new-device-key",
        }),
      },
      bindings,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceStatus: string; accessToken: string };
    expect(body.deviceStatus).toBe("pending");
    expect(body.accessToken).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    const bindings = testBindings();
    await registerUser(bindings, "alice@example.com");
    const res = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.com",
          password: "wrong-password",
          devicePublicKey: "pk-alice@example.com-1",
        }),
      },
      bindings,
    );
    expect(res.status).toBe(401);
  });

  it("stops accepting new signups once total usage reaches the global storage ceiling", async () => {
    const bindings = testBindings({ GLOBAL_STORAGE_CEILING_BYTES: 100 });
    const alice = await registerUser(bindings, "alice@example.com");
    await bindings.DB.update(users).set({ storageBytesUsed: 100 }).where(eq(users.email, "alice@example.com"));

    const res = await app.request(
      "/v1/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com", password: "password123", devicePublicKey: "pk-bob" }),
      },
      bindings,
    );
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "service_unavailable" });

    // The ceiling only blocks *new* signups - alice, already registered,
    // must still be able to log in and sync normally.
    const loginRes = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.com",
          password: "password123",
          devicePublicKey: `pk-alice@example.com-1`,
        }),
      },
      bindings,
    );
    expect(loginRes.status).toBe(200);
    expect(alice.accessToken).toBeTruthy();
  });

  // Two prior rate-limiting attempts (a KV counter, then Cloudflare's
  // native binding) were both confirmed live to let every request through
  // under concurrent load - neither had real atomicity between reading
  // the count and writing it back. This fires registrations genuinely
  // concurrently (Promise.all, same IP) to prove this implementation
  // doesn't share that flaw: exactly `limit` succeed, the rest are
  // rejected, not "all of them" or "an unpredictable number."
  it("rate-limits registration per IP under real concurrent load", async () => {
    const bindings = testBindings();
    const ip = "203.0.113.5";
    const limit = 5;

    const attempts = Array.from({ length: limit + 5 }, (_, i) =>
      app.request(
        "/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: JSON.stringify({
            email: `concurrent-${i}@example.com`,
            password: "password123",
            devicePublicKey: `pk-${i}`,
          }),
        },
        bindings,
      ),
    );

    const results = await Promise.all(attempts);
    const succeeded = results.filter((r) => r.status === 201);
    const rateLimited = results.filter((r) => r.status === 429);

    expect(succeeded).toHaveLength(limit);
    expect(rateLimited).toHaveLength(attempts.length - limit);
  });
});

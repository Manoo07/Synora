import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { app } from "../src/index.js";
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

  it("rate-limits repeated registration attempts from the same caller", async () => {
    const bindings = testBindings();
    const attempt = (n: number) =>
      app.request(
        "/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `flood-${n}@example.com`, password: "password123", devicePublicKey: `pk-${n}` }),
        },
        bindings,
      );

    const results = [];
    for (let i = 0; i < 11; i++) results.push(await attempt(i));
    const statuses = results.map((r) => r.status);

    // The limit is 10 per window - the 11th distinct attempt should be
    // throttled even though each one would otherwise succeed (different
    // email each time), confirming this limits raw request volume, not
    // just failed/duplicate attempts.
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.at(-1)).toBe(429);
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
});

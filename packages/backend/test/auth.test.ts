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

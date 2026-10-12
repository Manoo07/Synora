import { afterEach, describe, expect, it } from "vitest";
import { SynoraApiClient } from "../src/api/client.js";

describe("SynoraApiClient base URL handling", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("strips a trailing slash from the constructor URL so paths never double up", async () => {
    let requestedUrl: string | undefined;
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const api = new SynoraApiClient("https://example.com/");
    await api.listVaults();

    expect(requestedUrl).toBe("https://example.com/v1/vaults");
  });

  it("strips a trailing slash set later via setBaseUrl", async () => {
    let requestedUrl: string | undefined;
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const api = new SynoraApiClient("https://example.com");
    api.setBaseUrl("https://other.example.com//");
    await api.listVaults();

    expect(requestedUrl).toBe("https://other.example.com/v1/vaults");
  });
});

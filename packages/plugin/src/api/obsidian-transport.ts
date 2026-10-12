import { requestUrl } from "obsidian";
import type { Transport } from "./client.js";

// Routes HTTP calls through Obsidian's `requestUrl`, which goes through
// Electron's net layer rather than the renderer's `fetch` - the renderer
// is subject to Obsidian's CSP, which blocks `fetch` to arbitrary external
// hosts (surfaces as an opaque "Failed to fetch" with no further detail).
// `requestUrl` isn't. See api/client.ts for the Transport interface this
// satisfies and why that file itself never imports "obsidian" directly.
export const obsidianTransport: Transport = async (url, init) => {
  const response = await requestUrl({
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
    throw: false,
  });

  return {
    status: response.status,
    arrayBuffer: async () => response.arrayBuffer,
    text: async () => response.text,
  };
};

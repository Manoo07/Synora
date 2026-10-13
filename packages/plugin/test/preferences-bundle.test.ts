import { describe, expect, it } from "vitest";
import { collectPreferencesBundle, applyPreferencesBundle, type PreferencesBundleHost } from "../src/preferences-bundle.js";
import { MemoryAdapter } from "./fakes/memory-adapter.js";

function buildHost(adapter: MemoryAdapter, ownPluginId = "synora-sync"): PreferencesBundleHost {
  return {
    manifest: { id: ownPluginId },
    app: { vault: { configDir: ".obsidian", adapter } },
  };
}

describe("preferences bundle", () => {
  it("collects included files and excludes its own plugin folder and workspace state", async () => {
    const adapter = new MemoryAdapter();
    adapter.files.set(".obsidian/appearance.json", new TextEncoder().encode('{"theme":"moonstone"}'));
    adapter.files.set(".obsidian/community-plugins.json", new TextEncoder().encode("[]"));
    adapter.files.set(".obsidian/workspace.json", new TextEncoder().encode('{"layout":"desktop"}'));
    adapter.files.set(".obsidian/workspace-mobile.json", new TextEncoder().encode('{"layout":"mobile"}'));
    adapter.files.set(".obsidian/plugins/some-other-plugin/main.js", new TextEncoder().encode("console.log(1)"));
    // This plugin's own folder - must NEVER end up in the bundle. Its
    // data.json holds this device's secret key/access token; leaking it
    // to another device would corrupt that device's identity.
    adapter.files.set(".obsidian/plugins/synora-sync/main.js", new TextEncoder().encode("plugin code"));
    adapter.files.set(".obsidian/plugins/synora-sync/data.json", new TextEncoder().encode('{"deviceSecretKeyB64":"super-secret"}'));

    const bundle = await collectPreferencesBundle(buildHost(adapter));

    expect(Object.keys(bundle).sort()).toEqual(
      ["appearance.json", "community-plugins.json", "plugins/some-other-plugin/main.js"].sort(),
    );
    expect(Object.keys(bundle)).not.toContain("workspace.json");
    expect(Object.keys(bundle)).not.toContain("workspace-mobile.json");
    expect(Object.keys(bundle).some((p) => p.startsWith("plugins/synora-sync"))).toBe(false);
  });

  it("applies a bundle, creating intermediate folders as needed", async () => {
    const adapter = new MemoryAdapter();
    const bundle = {
      "appearance.json": btoa('{"theme":"moonstone"}'),
      "plugins/some-other-plugin/main.js": btoa("console.log(1)"),
    };

    await applyPreferencesBundle(buildHost(adapter), bundle);

    expect(new TextDecoder().decode(await adapter.readBinary(".obsidian/appearance.json"))).toBe(
      '{"theme":"moonstone"}',
    );
    expect(new TextDecoder().decode(await adapter.readBinary(".obsidian/plugins/some-other-plugin/main.js"))).toBe(
      "console.log(1)",
    );
  });

  it("refuses to write its own plugin folder or workspace state even if a bundle somehow contains them", async () => {
    const adapter = new MemoryAdapter();
    // A malformed/old-version bundle that (incorrectly) includes exactly
    // the two things that must never be applied - defense in depth, not
    // trusting the far end's bundle blindly.
    const bundle = {
      "workspace.json": btoa('{"layout":"should-not-apply"}'),
      "plugins/synora-sync/data.json": btoa('{"deviceSecretKeyB64":"someone-elses-key"}'),
      "appearance.json": btoa('{"theme":"moonstone"}'),
    };

    await applyPreferencesBundle(buildHost(adapter), bundle);

    expect(await adapter.exists(".obsidian/workspace.json")).toBe(false);
    expect(await adapter.exists(".obsidian/plugins/synora-sync/data.json")).toBe(false);
    expect(await adapter.exists(".obsidian/appearance.json")).toBe(true);
  });
});

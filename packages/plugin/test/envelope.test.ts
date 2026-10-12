import { describe, expect, it } from "vitest";
import { encryptEnvelope, decryptEnvelope, encodeEnvelope, decodeEnvelope, EnvelopeIntegrityError } from "../src/crypto/envelope.js";
import { generateVaultKey } from "../src/crypto/keys.js";
import { encodeManifest, decodeManifest } from "../src/crypto/manifest.js";

describe("envelope encryption", () => {
  it("round-trips a manifest through encrypt/encode/decode/decrypt", () => {
    const vaultKey = generateVaultKey();
    const manifest = encodeManifest({
      fileId: "file-1",
      logicalPath: "Personal/Health.md",
      mimeType: "text/markdown",
      content: new TextEncoder().encode("# Health notes\nSome content."),
    });

    const envelope = encryptEnvelope(vaultKey, "vault-1", "file-1", "file-content", manifest);
    const wire = encodeEnvelope(envelope);
    const decoded = decodeEnvelope(wire);
    const plaintext = decryptEnvelope(vaultKey, decoded);
    const recovered = decodeManifest(plaintext);

    expect(recovered.logicalPath).toBe("Personal/Health.md");
    expect(recovered.mimeType).toBe("text/markdown");
    expect(new TextDecoder().decode(recovered.content)).toBe("# Health notes\nSome content.");
  });

  it("fails to decrypt with the wrong vault key", () => {
    const vaultKey = generateVaultKey();
    const wrongKey = generateVaultKey();
    const envelope = encryptEnvelope(vaultKey, "vault-1", "file-1", "file-content", new Uint8Array([1, 2, 3]));
    expect(() => decryptEnvelope(wrongKey, envelope)).toThrow(EnvelopeIntegrityError);
  });

  it("detects tampering with the ciphertext", () => {
    const vaultKey = generateVaultKey();
    const envelope = encryptEnvelope(vaultKey, "vault-1", "file-1", "file-content", new Uint8Array([1, 2, 3]));
    envelope.ciphertext[0] = (envelope.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => decryptEnvelope(vaultKey, envelope)).toThrow(EnvelopeIntegrityError);
  });

  it("detects a ciphertext replayed against a different fileId (AAD binding)", () => {
    const vaultKey = generateVaultKey();
    const envelope = encryptEnvelope(vaultKey, "vault-1", "file-1", "file-content", new Uint8Array([1, 2, 3]));
    // Re-encode/decode as if downloaded, then pretend it belongs to a
    // different file by swapping its AAD - the AEAD tag must reject this.
    const tampered = { ...envelope, aad: new TextEncoder().encode("different-file") };
    expect(() => decryptEnvelope(vaultKey, tampered)).toThrow(EnvelopeIntegrityError);
  });

  it("rejects an unknown format version before attempting to decrypt", () => {
    const vaultKey = generateVaultKey();
    const envelope = encryptEnvelope(vaultKey, "vault-1", "file-1", "file-content", new Uint8Array([1]));
    expect(() => decryptEnvelope(vaultKey, { ...envelope, formatVersion: 99 })).toThrow(EnvelopeIntegrityError);
  });
});

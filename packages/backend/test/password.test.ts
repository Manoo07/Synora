import { describe, expect, it } from "vitest";
import { hashPassword, checkPassword, verifyPassword } from "../src/auth/password.js";

// Reproduces exactly what the old scheme wrote, so the upgrade path is
// tested against the real format rather than a guess at it.
async function legacyPbkdf2Hash(password: string, iterations = 100_000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `pbkdf2$${iterations}$${hex(salt.buffer as ArrayBuffer)}$${hex(derived)}`;
}

describe("password hashing", () => {
  it("hashes with argon2id and verifies", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("$argon2id$")).toBe(true);

    const ok = await checkPassword("correct horse battery staple", stored);
    expect(ok).toEqual({ valid: true, needsRehash: false });
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });

  it("salts, so the same password never produces the same hash twice", async () => {
    const a = await hashPassword("same input");
    const b = await hashPassword("same input");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same input", a)).toBe(true);
    expect(await verifyPassword("same input", b)).toBe(true);
  });

  it("still accepts a password stored under the superseded scheme, and asks to upgrade it", async () => {
    const legacy = await legacyPbkdf2Hash("an older password");

    // Dropping this path would lock out anyone restored from a backup
    // taken before the change, with no way back and no error saying why.
    const ok = await checkPassword("an older password", legacy);
    expect(ok).toEqual({ valid: true, needsRehash: true });
  });

  it("does not ask to upgrade when an old-format password is wrong", async () => {
    const legacy = await legacyPbkdf2Hash("the real password");
    // needsRehash drives a database write, so a wrong guess must never
    // set it - otherwise failed logins become write traffic.
    expect(await checkPassword("a guess", legacy)).toEqual({ valid: false, needsRehash: false });
  });

  it("treats a malformed stored hash as a failed login rather than throwing", async () => {
    expect(await checkPassword("anything", "not-a-hash")).toEqual({ valid: false, needsRehash: false });
    expect(await checkPassword("anything", "$argon2id$garbage")).toEqual({ valid: false, needsRehash: false });
    expect(await checkPassword("anything", "")).toEqual({ valid: false, needsRehash: false });
  });
});

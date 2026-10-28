import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

// Argon2id. Replace with a vetted hosted auth provider before real
// users — see protocol-spec.md §2 and the architecture doc's "do not
// invent authentication" note.
//
// This was PBKDF2 for a long time, not by preference: argon2 and bcrypt
// need a native module the Workers runtime could not load, and that
// runtime also capped PBKDF2 at 100,000 iterations. Both limits went
// away with the move to Node. The @node-rs build ships prebuilt
// binaries, so it needs no compiler in the image.
//
// Argon2id is the better choice because it is deliberately expensive in
// *memory* as well as time. PBKDF2 is pure arithmetic, which is exactly
// what a GPU does tens of thousands of times in parallel; forcing each
// guess to hold 19MB makes that parallelism far more expensive.
//
// Parameters are the OWASP baseline: 19MiB, 2 passes, 1 degree of
// parallelism.
// The library's Algorithm enum is a `const enum`, which isolatedModules
// forbids importing, so the id is given directly: 0=Argon2d, 1=Argon2i,
// 2=Argon2id.
const ARGON2ID = 2;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const LEGACY_KEY_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  // The encoded form carries its own algorithm and parameters, so a
  // later change to the numbers above still verifies old hashes.
  return argon2Hash(password, ARGON2_OPTIONS);
}

export interface PasswordCheck {
  valid: boolean;
  // True when the password was correct but stored under the superseded
  // scheme. The caller has the plaintext at that moment and nowhere
  // else, so it is the only point an upgrade can happen.
  needsRehash: boolean;
}

export async function checkPassword(password: string, stored: string): Promise<PasswordCheck> {
  if (stored.startsWith("$argon2")) {
    try {
      return { valid: await argon2Verify(stored, password), needsRehash: false };
    } catch {
      // Malformed hash - treat as a failed login rather than a crash.
      return { valid: false, needsRehash: false };
    }
  }

  // Hashes written before the move. Kept verifiable on purpose: the
  // live database was empty when this changed, but a restored backup
  // or a long-dormant account would otherwise be locked out with no
  // way back, and dropping the path turns that into a silent failure.
  const valid = await verifyLegacyPbkdf2(password, stored);
  return { valid, needsRehash: valid };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return (await checkPassword(password, stored)).valid;
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyLegacyPbkdf2(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = fromHex(parts[2]!);
  const expected = parts[3]!;

  const derived = await crypto.subtle
    .importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"])
    .then((keyMaterial) =>
      crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        keyMaterial,
        LEGACY_KEY_LENGTH * 8,
      ),
    );

  const actual = toHex(derived);
  // Constant-time-ish comparison; lengths are fixed hex strings so this is
  // adequate without pulling in a dedicated constant-time compare.
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

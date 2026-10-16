// PBKDF2 via WebCrypto. Replace with a vetted hosted auth provider
// before real users — see protocol-spec.md §2 and the architecture
// doc's "do not invent authentication" note.
//
// Worth knowing that the reason for this choice has expired. PBKDF2 was
// picked because argon2 and bcrypt need a native module, which the
// Workers runtime could not load. On Node they are both available, and
// argon2id is the better algorithm.
//
// It has not been changed, deliberately: a hash is only verifiable by
// the algorithm that produced it, so switching invalidates every
// existing password and locks people out until they reset. Doing it
// properly means verifying against the old scheme and re-hashing on
// next successful login, which is worth doing - just not silently, as
// part of a runtime migration.
//
// The 100,000 iterations are a leftover of the same constraint: it was
// the Workers runtime's hard cap, found the hard way when a higher
// value that worked locally was rejected once deployed. Node has no
// such ceiling, so this can be raised whenever the re-hash path above
// exists to carry old hashes forward.
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_LENGTH = 32;

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function derive(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH * 8,
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(password, salt);
  return `pbkdf2$${ITERATIONS}$${toHex(salt.buffer as ArrayBuffer)}$${toHex(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]!);
  const expected = parts[3]!;
  const derived = await crypto.subtle
    .importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"])
    .then((keyMaterial) =>
      crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, KEY_LENGTH * 8),
    );
  const actual = toHex(derived);
  // Constant-time-ish comparison; lengths are fixed hex strings so this is
  // adequate without pulling in a dedicated constant-time compare.
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

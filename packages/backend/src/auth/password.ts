// PBKDF2 via WebCrypto (SubtleCrypto), available in both Workers and Node.
// bcrypt/argon2 aren't available in the Workers runtime without a native
// binding, so this is the practical choice here. Replace with a vetted
// hosted auth provider before real users — see protocol-spec.md §2 and the
// architecture doc's "do not invent authentication" note.
//
// 100,000 is the real `workerd` runtime's hard cap on PBKDF2 iterations
// (confirmed in production: higher counts throw `NotSupportedError` there,
// even though Miniflare's local dev crypto backend silently allows more -
// this exact mismatch is why it worked in `wrangler dev` but not deployed).
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

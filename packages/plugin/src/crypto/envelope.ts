import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";

// Implements the envelope format from docs/protocol-spec.md §3. Any change
// here is a wire-format change and needs a new FORMAT_VERSION plus
// explicit handling of the old one during decode.
export const FORMAT_VERSION = 1;

export type EnvelopeContext = "file-content" | "filename" | "attachment";

export interface EncryptedEnvelope {
  formatVersion: number;
  salt: Uint8Array; // 16 bytes, HKDF salt
  context: EnvelopeContext;
  nonce: Uint8Array; // 24 bytes, XChaCha20 nonce
  ciphertext: Uint8Array; // includes the 16-byte Poly1305 tag
  aad: Uint8Array;
}

const SALT_BYTES = 16;
const NONCE_BYTES = 24;

function buildAad(vaultId: string, fileId: string, context: EnvelopeContext): Uint8Array {
  // vaultId || fileId || formatVersion || context, each length-prefixed so
  // the fields can't be shifted into each other.
  const parts = [vaultId, fileId, String(FORMAT_VERSION), context];
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const bytes = encoder.encode(part);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, bytes.byteLength, false);
    chunks.push(header, bytes);
  }
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function deriveDataKey(vaultKey: Uint8Array, salt: Uint8Array, context: EnvelopeContext): Uint8Array {
  // Distinct HKDF context strings per subsystem so a nonce-reuse bug in one
  // (e.g. filenames) can't be combined with ciphertext from another (e.g.
  // file content). See protocol-spec.md §2.
  return hkdf(sha256, vaultKey, salt, `synora:v${FORMAT_VERSION}:${context}`, 32);
}

export function encryptEnvelope(
  vaultKey: Uint8Array,
  vaultId: string,
  fileId: string,
  context: EnvelopeContext,
  plaintext: Uint8Array,
): EncryptedEnvelope {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const dataKey = deriveDataKey(vaultKey, salt, context);
  const aad = buildAad(vaultId, fileId, context);
  const ciphertext = xchacha20poly1305(dataKey, nonce, aad).encrypt(plaintext);
  return { formatVersion: FORMAT_VERSION, salt, context, nonce, ciphertext, aad };
}

export class EnvelopeIntegrityError extends Error {}

export function decryptEnvelope(vaultKey: Uint8Array, envelope: EncryptedEnvelope): Uint8Array {
  if (envelope.formatVersion !== FORMAT_VERSION) {
    throw new EnvelopeIntegrityError(`Unsupported envelope format version ${envelope.formatVersion}`);
  }
  const dataKey = deriveDataKey(vaultKey, envelope.salt, envelope.context);
  try {
    return xchacha20poly1305(dataKey, envelope.nonce, envelope.aad).decrypt(envelope.ciphertext);
  } catch {
    // AEAD tag mismatch: corruption or tampering, never silently retried.
    throw new EnvelopeIntegrityError("Envelope failed authentication - corrupted or tampered ciphertext");
  }
}

// --- Wire encoding ---------------------------------------------------------
//
// [formatVersion u8][contextLen u8][context utf8][salt 16][nonce 24]
// [aadLen u32][aad][ciphertext ...rest]
//
// This is what actually gets uploaded as the blob; `aad` is included so a
// downloader can re-verify framing without a side channel.

export function encodeEnvelope(envelope: EncryptedEnvelope): Uint8Array {
  const contextBytes = new TextEncoder().encode(envelope.context);
  const header = new Uint8Array(1 + 1 + contextBytes.byteLength + SALT_BYTES + NONCE_BYTES + 4);
  let offset = 0;
  header[offset++] = envelope.formatVersion;
  header[offset++] = contextBytes.byteLength;
  header.set(contextBytes, offset);
  offset += contextBytes.byteLength;
  header.set(envelope.salt, offset);
  offset += SALT_BYTES;
  header.set(envelope.nonce, offset);
  offset += NONCE_BYTES;
  new DataView(header.buffer).setUint32(offset, envelope.aad.byteLength, false);

  return concat([header, envelope.aad, envelope.ciphertext]);
}

export function decodeEnvelope(bytes: Uint8Array): EncryptedEnvelope {
  let offset = 0;
  const formatVersion = bytes[offset++]!;
  const contextLen = bytes[offset++]!;
  const context = new TextDecoder().decode(bytes.subarray(offset, offset + contextLen)) as EnvelopeContext;
  offset += contextLen;
  const salt = bytes.slice(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const nonce = bytes.slice(offset, offset + NONCE_BYTES);
  offset += NONCE_BYTES;
  const aadLen = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
  offset += 4;
  const aad = bytes.slice(offset, offset + aadLen);
  offset += aadLen;
  const ciphertext = bytes.slice(offset);

  return { formatVersion, salt, context, nonce, ciphertext, aad };
}

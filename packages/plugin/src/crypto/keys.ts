import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";

export const VAULT_KEY_BYTES = 32;
const NONCE_BYTES = 24;

export interface DeviceKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const secretKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey, secretKey };
}

export function generateVaultKey(): Uint8Array {
  return randomBytes(VAULT_KEY_BYTES);
}

// Wraps `vaultKey` so only the holder of `recipientSecretKey` (matching
// `recipientPublicKey`) can unwrap it. This is an anonymous-sender seal:
// an ephemeral X25519 keypair is generated per call, so the wrapped blob
// by itself doesn't reveal who sealed it - only the device's own key
// matters at unwrap time. Equivalent in shape to libsodium's sealed box.
export function wrapVaultKey(vaultKey: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  const ephemeral = x25519.utils.randomPrivateKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeral);
  const shared = x25519.getSharedSecret(ephemeral, recipientPublicKey);
  const key = hkdf(sha256, shared, ephemeralPublic, "synora:vault-key-wrap", 32);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(vaultKey);

  const out = new Uint8Array(ephemeralPublic.byteLength + NONCE_BYTES + ciphertext.byteLength);
  out.set(ephemeralPublic, 0);
  out.set(nonce, ephemeralPublic.byteLength);
  out.set(ciphertext, ephemeralPublic.byteLength + NONCE_BYTES);
  return out;
}

export class KeyUnwrapError extends Error {}

export function unwrapVaultKey(wrapped: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array {
  const pubKeyLen = 32;
  const ephemeralPublic = wrapped.slice(0, pubKeyLen);
  const nonce = wrapped.slice(pubKeyLen, pubKeyLen + NONCE_BYTES);
  const ciphertext = wrapped.slice(pubKeyLen + NONCE_BYTES);

  const shared = x25519.getSharedSecret(recipientSecretKey, ephemeralPublic);
  const key = hkdf(sha256, shared, ephemeralPublic, "synora:vault-key-wrap", 32);
  try {
    return xchacha20poly1305(key, nonce).decrypt(ciphertext);
  } catch {
    throw new KeyUnwrapError("Could not unwrap vault key with this device's key pair");
  }
}

// Avoid relying on Node's `Buffer` - the plugin also runs on Obsidian
// mobile, where it isn't guaranteed to be polyfilled.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

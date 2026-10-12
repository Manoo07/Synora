import { describe, expect, it } from "vitest";
import { generateDeviceKeyPair, generateVaultKey, wrapVaultKey, unwrapVaultKey, KeyUnwrapError, bytesToBase64, base64ToBytes } from "../src/crypto/keys.js";

describe("device enrollment key wrapping", () => {
  it("wraps a vault key for a device and that device can unwrap it", () => {
    const device = generateDeviceKeyPair();
    const vaultKey = generateVaultKey();

    const wrapped = wrapVaultKey(vaultKey, device.publicKey);
    const unwrapped = unwrapVaultKey(wrapped, device.secretKey);

    expect(unwrapped).toEqual(vaultKey);
  });

  it("a different device's secret key cannot unwrap it", () => {
    const device = generateDeviceKeyPair();
    const otherDevice = generateDeviceKeyPair();
    const vaultKey = generateVaultKey();

    const wrapped = wrapVaultKey(vaultKey, device.publicKey);
    expect(() => unwrapVaultKey(wrapped, otherDevice.secretKey)).toThrow(KeyUnwrapError);
  });

  it("base64 round-trips arbitrary key bytes", () => {
    const vaultKey = generateVaultKey();
    expect(base64ToBytes(bytesToBase64(vaultKey))).toEqual(vaultKey);
  });
});

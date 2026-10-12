import { SignJWT, jwtVerify } from "jose";

// Deliberately long-lived: this app has no refresh-token flow, so a short
// TTL just means the plugin silently breaks every 15 minutes with no way
// to recover short of a fresh password login (confirmed live — the UI was
// stuck showing "signed in" with every call failing "Invalid or expired
// token"). The real security boundary here is device *revocation*
// (requireAuth checks device.status on every request), not token expiry -
// an active device should stay trusted until explicitly revoked, matching
// how desktop/mobile apps in this shape normally work. Revisit if a
// refresh-token flow is ever added.
const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface AccessTokenClaims {
  sub: string; // userId
  deviceId: string;
}

export async function issueAccessToken(claims: AccessTokenClaims, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ deviceId: claims.deviceId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS)
    .sign(key);
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key);
  if (!payload.sub || typeof payload.deviceId !== "string") {
    throw new Error("Malformed token claims");
  }
  return { sub: payload.sub, deviceId: payload.deviceId };
}

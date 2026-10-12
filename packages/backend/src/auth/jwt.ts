import { SignJWT, jwtVerify } from "jose";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // short-lived by design — protocol-spec §2

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

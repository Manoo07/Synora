// Every setting is read and checked once, at startup, before the server
// accepts a single request.
//
// An unset environment variable is just `undefined`: nothing complains,
// and the first sign of trouble is usually a request failing much later
// in a way that looks like something else entirely. Failing loudly here,
// naming the variable, costs one restart instead of an afternoon.

export interface Config {
  port: number;
  databaseUrl: string;
  databasePoolSize: number;
  jwtSecret: string;
  globalStorageCeilingBytes: number;
  gcRetentionDays: number | undefined;
  gcCron: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    // Set this to point at something S3-compatible that is not R2 -
    // MinIO in a container, say - instead of deriving the R2 endpoint.
    endpoint: string | undefined;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Every setting the server needs is read at startup; ` +
        `see .env.example for the full list.`,
    );
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return value;
}

export function loadConfig(): Config {
  return {
    port: optionalNumber("PORT", 8787),
    databaseUrl: required("DATABASE_URL"),
    // One process now serves every request, so the pool is sized for the
    // instance rather than for a single request. On Workers each request
    // opened its own pool, which is why that number had to stay tiny.
    databasePoolSize: optionalNumber("DATABASE_POOL_SIZE", 10),
    jwtSecret: required("JWT_SECRET"),
    globalStorageCeilingBytes: optionalNumber("GLOBAL_STORAGE_CEILING_BYTES", 8_000_000_000),
    gcRetentionDays: process.env.GC_RETENTION_DAYS ? optionalNumber("GC_RETENTION_DAYS", 30) : undefined,
    gcCron: process.env.GC_CRON ?? "17 3 * * *",
    r2: {
      accountId: required("R2_ACCOUNT_ID"),
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
      bucket: required("R2_BUCKET"),
      endpoint: process.env.S3_ENDPOINT,
    },
  };
}

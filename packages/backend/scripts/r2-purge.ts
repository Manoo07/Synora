// Deletes every object in the R2 bucket.
//
// There is one legitimate reason to reach for this: the database has
// been reset, so nothing references the stored blobs any more and
// garbage collection can never find them - it only deletes what it can
// still see a row for. Orphans like that would otherwise sit in the
// bucket consuming the storage allowance forever.
//
//   cd packages/backend
//   npx tsx scripts/r2-purge.ts --yes-delete-everything
//
// Credentials come from the same R2_* variables the server uses, so a
// filled-in .env is enough.
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { loadDotEnv } from "./env.js";

loadDotEnv();

// Deliberately long and specific. A short flag is the kind of thing
// that ends up in shell history next to something harmless.
const CONFIRM = "--yes-delete-everything";
if (!process.argv.includes(CONFIRM)) {
  console.error(
    `This deletes EVERY object in the bucket and cannot be undone.\n` +
      `Only correct when the database has been reset and the blobs are orphaned.\n\n` +
      `  npx tsx scripts/r2-purge.ts ${CONFIRM}\n`,
  );
  process.exit(1);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set - see .env.example`);
  return value;
}

const bucket = required("R2_BUCKET");
const client = new S3Client({
  region: "auto",
  endpoint: process.env.S3_ENDPOINT ?? `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
});

console.log(`Purging every object from ${bucket}\n`);

let deleted = 0;
let bytes = 0;
let continuationToken: string | undefined;

do {
  const page = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
  );
  const objects = page.Contents ?? [];
  if (objects.length > 0) {
    bytes += objects.reduce((sum, o) => sum + (o.Size ?? 0), 0);
    // DeleteObjects takes up to 1000 keys per call, which is also the
    // page size ListObjectsV2 returns, so one page maps to one delete.
    const result = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects.map((o) => ({ Key: o.Key! })), Quiet: true },
      }),
    );
    for (const err of result.Errors ?? []) {
      console.error(`  failed: ${err.Key} - ${err.Code} ${err.Message}`);
    }
    deleted += objects.length - (result.Errors?.length ?? 0);
    process.stdout.write(`\r  deleted ${deleted}…`);
  }
  // Paginate off the server's own token rather than assuming a full
  // page means more remains.
  continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (continuationToken);

console.log(`\n\nDeleted ${deleted} objects, ${(bytes / (1024 * 1024)).toFixed(1)} MB freed.`);
client.destroy();

// Keeps the hosted Postgres instance from being paused for inactivity.
// Run on a schedule (see .github/workflows/keep-db-alive.yml) - this is
// not a migration or app logic, just a heartbeat query.
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1 });

try {
  const rows = await sql<{ now: Date }[]>`select now() as now`;
  console.log(`Database is alive. Server time: ${rows[0]!.now.toISOString()}`);
} finally {
  await sql.end();
}

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolveDatabaseUrl } from "./env.js";

const connectionString = resolveDatabaseUrl("db:migrate");

const sql = postgres(connectionString, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "./drizzle" });
await sql.end();

// Names the target again, so the success line can never be read as
// "applied to production" when it went somewhere else.
console.log(`Migrations applied to ${new URL(connectionString).hostname}.`);

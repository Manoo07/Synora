import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const connectionString = process.env.DATABASE_URL ?? "postgres://synora:synora@localhost:5435/synora";

const sql = postgres(connectionString, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "./drizzle" });
await sql.end();

console.log("Migrations applied.");

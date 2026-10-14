import { readFileSync, existsSync } from "node:fs";

// Loads packages/backend/.env (gitignored) if it is there, so the
// connection string is set once instead of pasted into every command.
// Deliberately not a dependency: this reads KEY=value lines and nothing
// more, which is all these scripts need.
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // A real environment variable always wins over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const LOCAL_DEV_URL = "postgres://synora:synora@localhost:5435/synora";

// Resolves which database a script will touch, and says so out loud.
//
// This used to silently fall back to the local docker database when
// DATABASE_URL was unset, then print "Migrations applied." - so a
// migration you believed had reached production could have gone to a
// throwaway container on your laptop, with nothing in the output to
// tell the difference. Any script that writes has to be explicit about
// which database it is writing to.
export function resolveDatabaseUrl(scriptName: string): string {
  loadDotEnv();
  const fromEnv = process.env.DATABASE_URL;
  const wantsLocal = process.argv.includes("--local");

  if (!fromEnv && !wantsLocal) {
    console.error(
      `${scriptName}: DATABASE_URL is not set.\n\n` +
        `  Set it for this command:   DATABASE_URL='postgres://…' npm run ${scriptName}\n` +
        `  Or put it in packages/backend/.env (gitignored), once.\n` +
        `  Or target the local docker database on purpose:   npm run ${scriptName} -- --local\n`,
    );
    process.exit(1);
  }

  const url = fromEnv ?? LOCAL_DEV_URL;
  // Host only - never the credentials.
  let target = "unparseable url";
  try {
    const parsed = new URL(url);
    target = `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    // Leave the placeholder; postgres.js will complain soon enough.
  }
  console.log(`${scriptName}: using ${fromEnv ? "DATABASE_URL" : "LOCAL dev database"} → ${target}`);
  return url;
}

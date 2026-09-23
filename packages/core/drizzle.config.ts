import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

/**
 * Drizzle CLI configuration. Paths here are relative because drizzle-kit
 * resolves them against the working directory, which is why the root `db:*`
 * scripts invoke the matching package script with `--cwd packages/core`.
 *
 * There is deliberately no `db:push`. Change the schema with `db:generate`,
 * which diffs the schema file against migration snapshots and never inspects
 * a live database, review the SQL it writes, then apply it with `db:migrate`.
 */

// drizzle-kit only looks for a .env beside its working directory, and the
// repository keeps a single one at the root. CI has no file and sets
// DATABASE_URL in the environment instead, which this leaves alone.
const rootEnv = join(dirname(fileURLToPath(import.meta.url)), "../../.env");
if (existsSync(rootEnv)) {
	process.loadEnvFile(rootEnv);
}

export default defineConfig({
	dialect: "postgresql",
	schema: ["./src/**/*.sql.ts", "./src/**/sql.ts"],
	out: "./drizzle",
	dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});

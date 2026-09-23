import { Effect } from "effect";
import { clientLayer } from "./database.ts";
import { applyMigrations } from "./migrations.ts";

/** Applies pending migrations to the database at `DATABASE_URL`, then exits. */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is required. Copy .env.example to .env.");
}

await Effect.runPromise(applyMigrations.pipe(Effect.provide(clientLayer(databaseUrl))));
console.log("database migrations applied");

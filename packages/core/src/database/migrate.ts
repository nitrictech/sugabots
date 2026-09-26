import { Effect } from "effect";
import { clientLayer } from "./database.ts";
import { applyMigrations } from "./migrations.ts";

/** Applies pending migrations to the database at `DATABASE_URL`, then exits. */

await Effect.runPromise(applyMigrations.pipe(Effect.provide(clientLayer)));
console.log("database migrations applied");

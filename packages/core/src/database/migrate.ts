import { Pool } from "pg";
import { applyMigrations } from "./migrations.ts";

/** Applies pending migrations to the database at `DATABASE_URL`, then exits. */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is required. Copy .env.example to .env.");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
	await applyMigrations(pool);
	console.log("database migrations applied");
} finally {
	await pool.end();
}

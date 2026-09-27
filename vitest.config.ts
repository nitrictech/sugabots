import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { testDatabaseUrl } from "./packages/core/src/database/test-database.ts";

// A database of the tests' own, always. The store tests write rows and queue
// jobs, so sharing the development one means junk in the sidebar and a running
// dev server racing them for their own jobs. `testDatabaseUrl` derives a
// `_test` database when none is named, and refuses the development one.
// A `.env` locally, the environment in CI, which has no file.
const env = loadEnv("", import.meta.dirname, ["DATABASE_URL", "TEST_DATABASE_URL"]);
const DATABASE_URL = testDatabaseUrl({ ...process.env, ...env });

/**
 * One runner for the whole workspace. `vitest run` at the root executes every
 * project; `vitest run --project web` narrows to one.
 */
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "contracts",
					root: "packages/contracts",
					environment: "node",
					include: ["src/**/*.test.ts"],
				},
			},
			{
				test: {
					name: "sdk",
					root: "packages/sdk",
					environment: "node",
					include: ["src/**/*.test.ts"],
				},
			},
			{
				test: {
					name: "backend",
					root: ".",
					environment: "node",
					include: ["packages/{core,server,workflow}/src/**/*.test.ts"],
					// The store tests share one Postgres; files that clear or claim from
					// shared tables, such as the routine queue, cannot run beside each other.
					fileParallelism: false,
					env: DATABASE_URL ? { DATABASE_URL } : {},
					// Creates it, migrates it and empties it before the run.
					globalSetup: ["packages/core/src/database/test-setup.ts"],
				},
			},
			{
				plugins: [react()],
				// `@/` as the app imports it, kept in step with packages/web's
				// vite.config.ts and tsconfig paths.
				resolve: {
					alias: { "@": new URL("packages/web/src/", import.meta.url).pathname },
				},
				test: {
					name: "web",
					root: "packages/web",
					environment: "jsdom",
					include: ["src/**/*.test.{ts,tsx}"],
					setupFiles: ["src/test-setup.ts"],
				},
			},
		],
	},
});

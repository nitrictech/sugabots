import { Effect } from "effect";
import { inject } from "vitest";
import { workerDatabaseUrl } from "./test-database.ts";
import { copyTemplateIfMissing } from "./test-setup.ts";

/**
 * Points this Vitest worker at a database of its own, copied from the template
 * `test-setup.ts` prepared, before the test file loads and reads
 * `DATABASE_URL`. A worker runs one file at a time, so files that clear or
 * claim from shared tables, such as the routine queue, can run beside files in
 * other workers.
 */

const templateUrl = inject("testDatabaseTemplateUrl");
const poolId = process.env.VITEST_POOL_ID;

if (templateUrl && poolId) {
	const url = workerDatabaseUrl(templateUrl, poolId);
	await Effect.runPromise(copyTemplateIfMissing(url, templateUrl));
	process.env.DATABASE_URL = url;
}

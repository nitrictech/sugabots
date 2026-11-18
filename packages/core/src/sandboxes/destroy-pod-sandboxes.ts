/**
 * Destroys every computer that belonged to a pod, at the provider that made
 * it. Run once with `bun run --cwd packages/core destroy-pod-sandboxes`
 * against the database before the migration that gives each bot its own
 * computer: a `sandbox` row is the only way anything finds a machine at its
 * provider, and that migration refuses to run while any pod's row is left.
 *
 * It reads the rows with plain SQL and names the pods' `pod_id` column, which
 * the migration drops: on a database already migrated, whose rows are the
 * bots' computers in use, it fails before contacting any provider.
 * A machine its provider no longer has is already gone; one whose provider
 * can't be reached is reported and left, to be deleted in that provider's
 * console, and the script exits with a failure. Every row it destroyed a
 * machine for is deleted.
 */

import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Credentials } from "../credentials/credentials.ts";
import { layer as databaseLayer, query } from "../database/database.ts";
import { Ids } from "../ids/ids.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import { Sandboxes } from "./sandboxes.ts";

interface RecordedSandbox {
	id: string;
	pod_id: string;
	workspace_id: string;
	sandbox_provider_id: string;
	provider_sandbox_id: Sandboxes.SandboxId;
}

const destroyPodSandboxes = Effect.gen(function* () {
	const providers = yield* SandboxProviderRepository.Service;
	const sandboxes = yield* Sandboxes.Service;
	const rows = yield* query((db) =>
		db.execute<RecordedSandbox>(
			sql`select id, pod_id, workspace_id, sandbox_provider_id, provider_sandbox_id from sandbox`,
			"objects",
		),
	);
	let destroyed = 0;
	const left: string[] = [];
	for (const row of rows) {
		const configured = yield* providers.connection(row.workspace_id, row.sandbox_provider_id);
		if (!configured) {
			left.push(`${row.provider_sandbox_id}: its provider has lost its settings`);
			continue;
		}
		const outcome = yield* Effect.result(
			sandboxes.forConnection(configured.connection).destroy(row.provider_sandbox_id),
		);
		if (outcome._tag === "Failure") {
			left.push(`${row.provider_sandbox_id}: ${outcome.failure.message}`);
			continue;
		}
		yield* query((db) => db.execute(sql`delete from sandbox where id = ${row.id}`));
		destroyed += 1;
	}
	yield* Effect.log(`Destroyed ${destroyed} of ${rows.length} pod computers`);
	if (left.length > 0) {
		yield* Effect.logError(
			`Left ${left.length}, to delete in their providers' consoles:\n${left.join("\n")}`,
		);
		process.exitCode = 1;
	}
});

await Effect.runPromise(
	destroyPodSandboxes.pipe(
		Effect.provide(
			Layer.mergeAll(SandboxProviderRepository.layer, Sandboxes.layer).pipe(
				Layer.provideMerge(Layer.mergeAll(Credentials.layer, Ids.layer)),
				Layer.provideMerge(databaseLayer),
			),
		),
	),
);

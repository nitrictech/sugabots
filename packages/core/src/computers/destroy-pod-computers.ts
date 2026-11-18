/**
 * Destroys every computer that belonged to a pod, at the provider that made
 * it. Run once with `bun run --cwd packages/core destroy-pod-computers`
 * against the database before the migration that gives each bot its own
 * computer: a row of the `sandbox` table, as computers were recorded then, is
 * the only way anything finds a machine at its provider, and that migration
 * refuses to run while any pod's row is left.
 *
 * It runs before any of the migrations after that one, which rename the
 * tables to `computer` and `computer_provider`, so it reads and deletes the
 * rows with plain SQL by their old names rather than through the schema. It
 * names the pods' `pod_id` column, which the migration drops: on a database
 * already migrated, whose rows are the bots' computers in use, it fails
 * before contacting any provider.
 * A machine its provider no longer has is already gone; one whose provider
 * can't be reached is reported and left, to be deleted in that provider's
 * console, and the script exits with a failure. Every row it destroyed a
 * machine for is deleted.
 */

import type { ComputerProviderSettings } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";
import { Credentials } from "../credentials/credentials.ts";
import { layer as databaseLayer, query } from "../database/database.ts";
import { Ids } from "../ids/ids.ts";
import { connectionOf } from "./computer-provider-repository.ts";
import { Computers } from "./computers.ts";

/** A pod's computer, with what its provider was configured with, if the provider is still there. */
interface RecordedComputer {
	id: string;
	pod_id: string;
	provider_computer_id: Computers.ComputerId;
	settings: ComputerProviderSettings | null;
	api_key_encrypted: string | null;
}

const destroyPodComputers = Effect.gen(function* () {
	const cipher = yield* Credentials.Service;
	const computers = yield* Computers.Service;
	const rows = yield* query((db) =>
		db.execute<RecordedComputer>(
			sql`select sandbox.id, sandbox.pod_id, sandbox.provider_sandbox_id as provider_computer_id,
				provider.settings, provider.api_key_encrypted
			from sandbox
			left join sandbox_provider as provider
				on provider.id = sandbox.sandbox_provider_id and provider.workspace_id = sandbox.workspace_id`,
			"objects",
		),
	);
	let destroyed = 0;
	const left: string[] = [];
	for (const row of rows) {
		const connection =
			row.settings && row.api_key_encrypted
				? connectionOf(row.settings, Redacted.make(cipher.decrypt(row.api_key_encrypted)))
				: undefined;
		if (!connection) {
			left.push(`${row.provider_computer_id}: its provider has lost its settings`);
			continue;
		}
		const outcome = yield* Effect.result(
			computers.forConnection(connection).destroy(row.provider_computer_id),
		);
		if (outcome._tag === "Failure") {
			left.push(`${row.provider_computer_id}: ${outcome.failure.message}`);
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
	destroyPodComputers.pipe(
		Effect.provide(
			Computers.layer.pipe(
				Layer.provideMerge(Layer.mergeAll(Credentials.layer, Ids.layer)),
				Layer.provideMerge(databaseLayer),
			),
		),
	),
);

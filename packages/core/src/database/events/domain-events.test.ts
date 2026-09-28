import { Data, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { transaction } from "../database.ts";
import { closeDatabase, runOnPostgres } from "../testing.ts";
import { DomainEvents } from "./domain-events.ts";

class Abandoned extends Data.TaggedError("Abandoned") {}

describe.skipIf(!process.env.DATABASE_URL)("DomainEvents", () => {
	let heard: string[] = [];
	const hear = (handler: string, events: ReadonlyArray<string>) =>
		Effect.sync(() => {
			heard.push(...events.map((event) => `${handler}: ${event}`));
		});
	const emit: DomainEvents.Emit<string> = DomainEvents.emitTo<string>([
		(events) => hear("feed", events),
		// Reacts to a fact by recording another.
		(events) =>
			Effect.andThen(
				hear("settlement", events),
				emit(events.flatMap((event) => (event === "turn ended" ? ["run settled"] : []))),
			),
	]);

	afterAll(closeDatabase);

	beforeEach(() => {
		heard = [];
	});

	it("hands each batch to every handler in the declared order, just before the commit", async () => {
		const heardBeforeCommit = await runOnPostgres(
			transaction(
				Effect.gen(function* () {
					yield* emit(["turn ended"]);
					yield* emit(["reply posted"]);
					return [...heard];
				}),
			),
		);

		expect(heardBeforeCommit).toEqual([]);
		expect(heard).toEqual([
			"feed: turn ended",
			"settlement: turn ended",
			"feed: reply posted",
			"settlement: reply posted",
			"feed: run settled",
			"settlement: run settled",
		]);
	});

	it("hands nothing over when the transaction rolls back", async () => {
		await expect(
			runOnPostgres(transaction(Effect.andThen(emit(["turn ended"]), new Abandoned()))),
		).rejects.toBeInstanceOf(Abandoned);

		expect(heard).toEqual([]);
	});

	it("drops what a rolled-back savepoint emitted and keeps the rest", async () => {
		await runOnPostgres(
			transaction(
				Effect.gen(function* () {
					yield* emit(["kept"]);
					yield* transaction(Effect.andThen(emit(["dropped"]), new Abandoned())).pipe(
						Effect.catchTag("Abandoned", () => Effect.void),
					);
				}),
			),
		);

		expect(heard).toEqual(["feed: kept", "settlement: kept"]);
	});
});

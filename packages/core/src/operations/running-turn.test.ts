import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { chatServicesForTests } from "../chats/testing.ts";
import { aChatAwaitingReply, openTurn, runningTurns, runOver } from "../chats/turns/testing.ts";
import { Turns } from "../chats/turns/turns.ts";
import { closeDatabase, runOnPostgres } from "../database/testing.ts";
import { unimplemented } from "../testing.ts";
import { asMember } from "./chats/testing.ts";
import { Operations } from "./registry.ts";
import { RunningTurn } from "./running-turn.ts";
import { servedOperations } from "./testing.ts";

describe.skipIf(!process.env.DATABASE_URL)("the running turn, against Postgres", async () => {
	const services = await chatServicesForTests({ publishCommitted: async () => undefined });
	const run = runOver(services);
	const call = await servedOperations({ chats: services });

	afterAll(async () => {
		await closeDatabase();
	});

	it("releases what a step's tools hold when the step ends, not when the process does", async () => {
		const { chatId } = await aChatAwaitingReply((memberId) => asMember(call, memberId));
		const [running] = await runOnPostgres(runningTurns(chatId));
		if (!running) throw new Error("no turn running");
		const opened = await run(openTurn(running));
		let stepEnded = false;
		const tools = unimplemented(Turns.Tools.Service, {
			forStep: () =>
				Effect.as(
					Effect.addFinalizer(() => Effect.sync(() => (stepEnded = true))),
					{} as never,
				),
		});
		const runningTurn = RunningTurn.layerNoDeps.pipe(
			Layer.provide(Layer.mergeAll(tools, unimplemented(Operations.Service))),
		);

		const endedWithStep = await run(
			Effect.gen(function* () {
				const turns = yield* RunningTurn.Service;
				yield* Effect.scoped(
					Effect.orDie(turns.offerStepTools(opened.principal, {} as never, {} as never)),
				);
				return stepEnded;
			}).pipe(Effect.provide(runningTurn)),
		);

		expect(endedWithStep).toBe(true);
	});
});

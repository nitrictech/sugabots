import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import type { BotPrincipal } from "../../principal.ts";
import { Operations } from "../registry.ts";
import { asRunningTurn } from "./running-turn.ts";

/** makeOfferStepTools builds the loop's operation for offering live tool callbacks in a step's scope. */
export const makeOfferStepTools = Effect.gen(function* () {
	const database =
		yield* Effect.context<Effect.Services<ReturnType<typeof asRunningTurn<void, never, never>>>>();
	const operations = yield* Operations.Service;
	const tools = yield* Turns.Tools.Service;
	return (
		principal: BotPrincipal,
		turn: Omit<Turns.Tools.StepTurn, "turnId" | "executionNumber">,
		recorder: Turns.Tools.ToolCallRecorder,
	) =>
		asRunningTurn(principal, { chatId: principal.chat, turnId: principal.turn }, (running) =>
			tools.forStep(running, operations, turn, recorder),
		).pipe(Effect.provideContext(database), Effect.withSpan("turns.offerStepTools"));
});

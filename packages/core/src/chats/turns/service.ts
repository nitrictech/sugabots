import { Cause, Effect, Exit, Option } from "effect";
import { afterCommit, serviceOperations, transaction } from "../../database/database.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatEvent } from "../events.ts";
import { SYSTEM_TURN_INTERRUPTED, TURN_STOPPED_UNEXPECTEDLY } from "./lifecycle.ts";
import { TurnSignals } from "./signals.ts";
import { TurnStore } from "./store.ts";
import { admitTurn, Turn } from "./turn.workflow.ts";
import type { Turns } from "./turns.ts";

/** `Turns.Service`: what the rest of the system asks of turns. */
export const makeService = Effect.gen(function* () {
	const operation = yield* serviceOperations<Turns.Interface>("Turns");
	const lanes = yield* Lanes.Service;
	const turns = yield* TurnStore.Service;
	const signals = yield* TurnSignals.Service;
	const { emit } = yield* ChatEvents.Service;

	const recordSystemTurn: Turns.Interface["recordSystemTurn"] = (systemTurn, work) =>
		Effect.gen(function* () {
			const opened = yield* turns.openSystemBotTurn(systemTurn);
			if (opened._tag === "NotRunnable") {
				return { _tag: "Skipped", reason: opened.reason } as const;
			}
			return yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const worked = yield* Effect.exit(restore(work(opened.turnId)));
					if (Exit.isSuccess(worked)) {
						yield* turns.completeSystemBotTurn(opened.turnId, worked.value.contextTokens);
						return { _tag: "Completed", value: worked.value.value } as const;
					}
					const expected = Cause.findErrorOption(worked.cause);
					if (Option.isSome(expected)) {
						yield* Effect.logWarning(`A ${systemTurn.name} failed: ${expected.value.message}`);
					} else {
						yield* Effect.logError(`A ${systemTurn.name} did not finish`, worked.cause);
					}
					const userMessage = Option.isSome(expected)
						? expected.value.userMessage
						: Cause.hasInterruptsOnly(worked.cause)
							? SYSTEM_TURN_INTERRUPTED
							: TURN_STOPPED_UNEXPECTEDLY;
					yield* turns.failSystemBotTurn(opened.turnId, userMessage);
					return { _tag: "Failed" } as const;
				}),
			);
		});

	return {
		ask: (request) =>
			operation(
				"ask",
				transaction(
					Effect.gen(function* () {
						const admission = yield* admitTurn(lanes, request);
						if (admission === "waiting") {
							yield* emit([ChatEvent.TurnQueued({ chatId: request.chatId })]);
						}
					}),
				),
			),
		stopUnder: (chatIds) =>
			operation(
				"stopUnder",
				transaction(
					Effect.gen(function* () {
						if (chatIds.length === 0) return;
						// A cancelled waiting turn's workflow still waits for its approvals,
						// holding its lane, until it is told to stop.
						const stillWaiting = yield* turns.cancelUnder(chatIds);
						yield* afterCommit(
							Effect.forEach(stillWaiting, (owner) => signals.cancel(owner), { discard: true }),
						);
						yield* lanes.dropWaiting(chatIds, [Turn._tag]);
					}),
				),
			),
		recordSystemTurn: (systemTurn, work) =>
			operation("recordSystemTurn", recordSystemTurn(systemTurn, work)),
	} satisfies Turns.Interface;
});

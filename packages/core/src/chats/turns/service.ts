import type { UserText } from "@sugabots/errors";
import { Cause, Effect, Exit, Option } from "effect";
import { afterCommit, serviceOperations, transaction } from "../../database/database.ts";
import { Ids } from "../../ids/ids.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { logTurnDefect, SYSTEM_TURN_INTERRUPTED } from "./lifecycle.ts";
import { TURN_WORKFLOW } from "./requests.ts";
import { TurnSignals } from "./signals.ts";
import { TurnStore } from "./store.ts";
import type { Turns } from "./turns.ts";

/** `Turns.Service`: what the rest of the system asks of turns. */
export const makeService = Effect.gen(function* () {
	const operation = yield* serviceOperations<Turns.Interface>("Turns");
	const ids = yield* Ids.Service;
	const lanes = yield* Lanes.Service;
	const turns = yield* TurnStore.Service;
	const signals = yield* TurnSignals.Service;

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
					const interrupted = Cause.hasInterruptsOnly(worked.cause);
					let userMessage: UserText;
					if (Option.isSome(expected) && !Cause.hasDies(worked.cause)) {
						yield* Effect.logWarning(`A ${systemTurn.name} failed: ${expected.value.message}`);
						userMessage = expected.value.userMessage;
					} else if (interrupted) {
						yield* Effect.logError(`A ${systemTurn.name} did not finish`, worked.cause);
						userMessage = SYSTEM_TURN_INTERRUPTED;
					} else {
						userMessage = yield* logTurnDefect(
							yield* ids.random,
							`A ${systemTurn.name} did not finish`,
							worked.cause,
						);
					}
					yield* turns.failSystemBotTurn(opened.turnId, userMessage);
					return { _tag: "Failed" } as const;
				}),
			);
		});

	return {
		ask: (request) => operation("ask", turns.ask(request)),
		stopUnder: (chatIds) =>
			operation(
				"stopUnder",
				transaction(
					Effect.gen(function* () {
						if (chatIds.length === 0) return;
						// Workflows waiting on approvals or a retry still hold their lanes
						// until they hear that their turns were cancelled.
						const stillWaiting = yield* turns.cancelUnder(chatIds);
						yield* afterCommit(
							Effect.forEach(stillWaiting, (executionId) => signals.cancel(executionId), {
								discard: true,
							}),
						);
						yield* lanes.dropWaiting(chatIds, [TURN_WORKFLOW]);
					}),
				),
			),
		recordSystemTurn: (systemTurn, work) =>
			operation("recordSystemTurn", recordSystemTurn(systemTurn, work)),
	} satisfies Turns.Interface;
});

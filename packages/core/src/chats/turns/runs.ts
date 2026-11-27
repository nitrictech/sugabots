export * as TurnRuns from "./runs.ts";

import { Context, Effect, Layer } from "effect";
import { serviceOperations, transaction } from "../../database/database.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatEvent } from "../events.ts";
import { type OpenedTurn, TurnExecution, type TurnRun } from "./execution.ts";
import type { TurnRequest } from "./requests.ts";
import { type Abandonment, type NotRunnable, type TurnStanding, TurnStore } from "./store.ts";

/**
 * What the bot loop's turn workflow does for a turn with no principal:
 * opening it for a run, before the loop can authenticate whom it acts for;
 * ending it when the workflow fails, or when it has nobody to act for; and,
 * once its lane is free, saying so. Everything the loop records while the
 * turn runs goes through `RunningTurn` instead.
 */
export interface Interface {
	/** Opens the turn for this run (see `TurnExecution.open`). */
	readonly open: (run: TurnRun) => Effect.Effect<OpenedTurn | NotRunnable>;
	/**
	 * Ends the active turn the run's workflow execution runs, as `ending` says,
	 * when the workflow gave up on it or the turn has nobody to act for. With no
	 * turn to end, members are told of a failure as a notice in the chat, so
	 * nobody waits on a reply that cannot come.
	 */
	readonly abandon: (run: TurnRun, ending: Abandonment) => Effect.Effect<void>;
	/**
	 * Where the turn stands for whoever runs a step of it: running, as which
	 * execution; asked to stop; failed, to run again, and when; or ended.
	 */
	readonly standing: (turnId: string) => Effect.Effect<TurnStanding>;
	/**
	 * Announces that the turn's lane is free. An automation run cannot settle
	 * while any of its lanes is busy, so this may let it.
	 */
	readonly announceReleased: (request: TurnRequest) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnRuns") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("TurnRuns");
	const execution = yield* TurnExecution.Service;
	const turns = yield* TurnStore.Service;
	const { emit } = yield* ChatEvents.Service;
	return Service.of({
		open: (run) => execution.open(run),
		abandon: (run, ending) =>
			operation(
				"abandon",
				transaction(
					Effect.gen(function* () {
						const ended = yield* turns.abandon(run.executionId, ending);
						// Ending an active turn announced how it ended.
						if (ended) return;
						yield* emit([
							ChatEvent.TurnAbandoned({
								chatId: run.request.chatId,
								botId: run.request.botId,
								triggerMessageId: run.request.triggerMessageId,
								reason: run.request.reason,
								outcome:
									ending.status === "failed"
										? { state: "failed", error: ending.userMessage }
										: { state: "cancelled" },
							}),
						]);
					}),
				),
			),
		standing: (turnId) => turns.standing(turnId),
		announceReleased: (request) =>
			operation(
				"announceReleased",
				transaction(
					emit([
						ChatEvent.LaneReleased({
							chatId: request.chatId,
							botId: request.botId,
							triggerMessageId: request.triggerMessageId,
							reason: request.reason,
						}),
					]),
				),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide([TurnExecution.layer, TurnStore.layer]));

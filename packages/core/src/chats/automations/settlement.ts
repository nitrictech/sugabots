export * as AutomationSettlement from "./settlement.ts";

import { FILE_WRITING_TOOLS, filesWrittenBy, textWithoutNarration } from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
	afterCommit,
	batchedBeforeCommit,
	Database,
	query,
	serviceOperations,
	transaction,
} from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import type * as schema from "../../database/schema.ts";
import { automationRun, message, toolCall, turn } from "../../database/schema.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatEvent } from "../events.ts";
import { ChatStore } from "../store/store.ts";
import { Turns } from "../turns/turns.ts";
import type { AutomationRun } from "./automation.workflow.ts";
import { lockAutomationSettlement, lockAutomationSettlementOf } from "./execution.ts";
import { AutomationRuns } from "./runs.ts";
import { AutomationStore, endingAfter, endingOf, RUN_STOPPED_UNEXPECTEDLY } from "./store.ts";

/**
 * Settles automation runs: records how a run ended once nothing in its chat
 * is running, waiting or about to start: its bot's turns, the turns of the
 * bots it asked for help and its hand-backs. A completed run has its bot's last
 * reply posted in the automation's feed. An automation that fails twice in a row gets a pending pause when the
 * second failure is recorded.
 *
 * `handler` reacts to the chat events that can end a run. In the
 * emitting transaction it only records how an event says the run should end,
 * without locking the run; the run settles once that transaction commits, in
 * its own. A turn of the run's own bot that failed for good, or was
 * cancelled, starts ending its run early: the rest of its work is cancelled,
 * and it ends that way once what is still running stops. A helper's turn
 * ending, however it ends, only lets the run settle: the run's outcome is its
 * own bot's, and the helper's failure shows to that bot in its hand-back.
 * Every later settlement of an ending run cancels whatever work is
 * left, since some may have been held by another transaction. A settlement
 * lost to a crash after commit is made by the run's workflow's next check.
 */
export interface Interface {
	readonly handler: DomainEvents.Handler<ChatEvent>;
	/**
	 * Settles the run if its work is done, for the run's workflow to check in
	 * case a signal was lost. Returns whether the run has ended.
	 */
	readonly settleRun: (run: AutomationRun) => Effect.Effect<boolean>;
	/**
	 * Records a run that has not ended as failed, at once, and stops its work.
	 * Members are told only that it stopped unexpectedly. Does nothing once the
	 * run has ended.
	 */
	readonly failRun: (run: AutomationRun) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AutomationSettlement",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AutomationSettlement");
	const { emit } = yield* ChatEvents.Service;
	const turns = yield* Turns.Service;
	const automations = yield* AutomationStore.Service;
	const runs = yield* AutomationRuns.Service;
	const chats = yield* ChatStore.Service;

	/**
	 * Posts the bot's last reply in the run's own chat, with the files
	 * the run wrote there, into the automation's feed. A run whose bot wrote
	 * nothing to show posts nothing.
	 */
	const postResult = (run: schema.RunRow) =>
		Effect.gen(function* () {
			const result = {
				content: (yield* lastReplyText(run)).trim(),
				files: yield* filesWrittenIn(run.chatId),
			};
			if (result.content === "" && result.files.length === 0) return;
			yield* chats.postRunResult({ run, result });
		});

	/**
	 * Settles the running automation run the chat `chatId` belongs to, if its
	 * work is done, first adding `outcome` to how it is ending. `announce` says
	 * the run started ending since it last settled, so watching clients are
	 * told its work was cancelled.
	 *
	 * The run is read without locking it, and written only after its work is
	 * cancelled (see `AutomationStore.recordEnding`). An ending recorded
	 * after the read settles the run again once its transaction commits.
	 */
	const settle = (chatId: string, options: { outcome?: Turns.Ended; announce?: boolean } = {}) =>
		transaction(
			Effect.gen(function* () {
				const runId = yield* lockAutomationSettlementOf(chatId);
				if (!runId) return;
				const run = yield* runningRun(runId);
				if (!run) return;
				const wasEnding = endingOf(run);
				const ending = endingAfter(wasEnding, options.outcome);
				if (ending) yield* turns.stopUnder([run.chatId]);
				if (ending && (options.announce || !wasEnding)) {
					yield* emit([
						ChatEvent.AutomationWorkCancelled({
							workspaceId: run.workspaceId,
							chatId: run.chatId,
						}),
					]);
				}
				if (ending && ending !== wasEnding) yield* automations.recordEnding(run.id, ending);
				if (yield* stillBusy(run.chatId, ending !== undefined)) return;
				const settled = settledAs(ending, yield* lastTurnOf(run));
				if (!(yield* automations.settle(run.id, settled))) return;
				if (settled.state === "completed") yield* postResult(run);
				yield* runs.settled({ automationId: run.automationId, runId: run.id });
			}),
		);

	/**
	 * Settles the runs of these chats once the transaction commits. Batched,
	 * so it is registered after the chat event stream's outbox, which the handlers
	 * reach first: clients hear what a turn did before they hear its run settled.
	 */
	const settleAfterCommit = batchedBeforeCommit(
		(settlements: ReadonlyArray<{ chatId: string; announce: boolean }>) =>
			Effect.flatMap(Database, (database) => {
				const announced = new Map<string, boolean>();
				for (const { chatId, announce } of settlements) {
					announced.set(chatId, announce || (announced.get(chatId) ?? false));
				}
				return afterCommit(
					Effect.forEach(announced, ([chatId, announce]) => settle(chatId, { announce }), {
						discard: true,
					}).pipe(Effect.provideService(Database, database)),
				);
			}),
	);

	return Service.of({
		handler: (events) =>
			Effect.gen(function* () {
				const settlements = yield* Effect.forEach(
					events.flatMap(settlementFor),
					({ chatId, endedEarly }) =>
						Effect.gen(function* () {
							if (!endedEarly) return { chatId, announce: false };
							const run = yield* runOf(chatId);
							// Another bot's turn is a helper's, which only lets the run settle.
							if (run?.botId !== endedEarly.botId) return { chatId, announce: false };
							const started = yield* automations.recordEnding(run.id, endedEarly.outcome);
							return { chatId, announce: started };
						}),
				);
				yield* settleAfterCommit(settlements);
			}),

		settleRun: (run) =>
			operation(
				"settleRun",
				Effect.gen(function* () {
					const chatId = yield* runChatOf(run.runId);
					if (!chatId) return true;
					yield* settle(chatId);
					const [after] = yield* query((db) =>
						db
							.select({ state: automationRun.state })
							.from(automationRun)
							.where(eq(automationRun.id, run.runId))
							.limit(1),
					);
					return after?.state !== "running";
				}),
			),

		failRun: (run) =>
			operation(
				"failRun",
				transaction(
					Effect.gen(function* () {
						yield* lockAutomationSettlement(run.runId);
						const chatId = yield* runChatOf(run.runId);
						if (chatId) {
							yield* settle(chatId, {
								outcome: { state: "failed", error: RUN_STOPPED_UNEXPECTEDLY },
							});
						}
						// Settling waits for work that is still stopping, but the run ends
						// now: its automation's next run cannot start while it is running.
						yield* automations.fail(run.runId, RUN_STOPPED_UNEXPECTEDLY);
					}),
				),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide([AutomationStore.layer, ChatStore.layer]));

/**
 * The chat an event may let an automation run settle in, and, for a turn
 * that ended early, whose turn it was and how it ended, which ends the run
 * early if it was the run's own bot's.
 */
function settlementFor(event: ChatEvent): Array<{
	readonly chatId: string;
	readonly endedEarly?: { readonly botId: string; readonly outcome: Turns.Ended };
}> {
	switch (event._tag) {
		case "TurnCompleted":
		case "TurnStayedSilent":
		case "LaneReleased":
			return [{ chatId: event.chatId }];
		case "TurnFailed":
			// A turn that runs again has not failed for good.
			return event.willRetry
				? []
				: [
						{
							chatId: event.chatId,
							endedEarly: {
								botId: event.botId,
								outcome: { state: "failed", error: event.userMessage },
							},
						},
					];
		case "TurnInterrupted":
			return [
				{
					chatId: event.chatId,
					endedEarly: { botId: event.botId, outcome: { state: "cancelled" } },
				},
			];
		case "TurnAbandoned":
			return [{ chatId: event.chatId, endedEarly: { botId: event.botId, outcome: event.outcome } }];
		default:
			return [];
	}
}

/** settledAs returns how a run whose work is over ends: as it was ending, or else as its last turn did. */
function settledAs(
	ending: Turns.Ended | undefined,
	lastTurn: { status: string; error: UserText | null } | undefined,
): AutomationStore.Settled {
	if (ending) return ending;
	if (lastTurn?.status === "failed" && lastTurn.error !== null) {
		return { state: "failed", error: lastTurn.error };
	}
	if (lastTurn?.status === "cancelled") return { state: "cancelled" };
	return { state: "completed" };
}

/** The run, if it is still running. */
const runningRun = (runId: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(automationRun)
				.where(and(eq(automationRun.id, runId), eq(automationRun.state, "running")))
				.limit(1),
		),
		([row]) => row,
	);

/** The automation run whose chat is `chatId`, with its bot, if the chat is a run's. */
const runOf = (chatId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: automationRun.id, botId: automationRun.botId })
				.from(automationRun)
				.where(eq(automationRun.chatId, chatId))
				.limit(1),
		),
		([row]) => row,
	);

/**
 * The text of the run's bot's last finished reply in the run's chat, as the
 * chat shows it: its hand-back, when it asked other bots for help, whose
 * replies are their work, not its answer.
 */
const lastReplyText = (run: schema.RunRow) =>
	Effect.map(
		query((db) =>
			db
				.select({ parts: message.parts })
				.from(message)
				.where(
					and(
						eq(message.chatId, run.chatId),
						eq(message.authorBotId, run.botId),
						eq(message.status, "complete"),
					),
				)
				.orderBy(desc(message.createdAt), desc(message.id))
				.limit(1),
		),
		([row]) => (row ? textWithoutNarration(row.parts) : ""),
	);

/** Each file written in the chat `chatId`, as `filesWrittenBy` its calls in the order they finished. */
const filesWrittenIn = (chatId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ tool: toolCall.tool, status: toolCall.status, output: toolCall.output })
				.from(toolCall)
				.where(
					and(
						eq(toolCall.chatId, chatId),
						eq(toolCall.status, "completed"),
						inArray(toolCall.tool, [...FILE_WRITING_TOOLS]),
					),
				)
				.orderBy(asc(toolCall.finishedAt), asc(toolCall.id)),
		),
		filesWrittenBy,
	);

const runChatOf = (runId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ chatId: automationRun.chatId })
				.from(automationRun)
				.where(eq(automationRun.id, runId))
				.limit(1),
		),
		([row]) => row?.chatId,
	);

/**
 * stillBusy reports whether work in the run's chat `chatId` keeps the run
 * from settling. Until the run is `ending`, that is any turn running, waiting
 * or asked for, so it waits for the bots its bot asked for help and for its
 * hand-backs, which are asked for before the helpers' lanes are free. An
 * ending run waits only for its running turns, which record how they ended:
 * its waiting turns were cancelled, and the turns its workflows still ask for
 * are refused.
 */
const stillBusy = (chatId: string, ending: boolean) =>
	Effect.map(
		query((db) =>
			db.execute<{ busy: boolean }>(
				sql`select (
					exists (
						select 1 from ${turn}
						where ${eq(turn.chatId, chatId)}
							and ${inArray(turn.status, ending ? ["running"] : ["running", "waiting"])}
					)
					${ending ? sql`` : sql`or ${Turns.busyIn(sql`${chatId}`)}`}
				) as busy`,
				"objects",
			),
		),
		([row]) => row?.busy ?? false,
	);

/**
 * How the last of the run's own turns to end in its chat ended, if any has:
 * its bot's, the first and its hand-backs, not its helpers'.
 */
const lastTurnOf = (run: schema.RunRow) =>
	Effect.map(
		query((db) =>
			db
				.select({ status: turn.status, error: turn.error })
				.from(turn)
				.where(and(eq(turn.chatId, run.chatId), eq(turn.botId, run.botId)))
				.orderBy(sql`${turn.finishedAt} desc nulls last`, desc(turn.id))
				.limit(1),
		),
		([row]) => row,
	);

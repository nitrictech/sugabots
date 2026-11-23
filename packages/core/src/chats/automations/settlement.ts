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
import { automationRun, collaboration, message, toolCall, turn } from "../../database/schema.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatEvent } from "../events.ts";
import { ChatStore } from "../store/store.ts";
import { workingChatsOf } from "../store/tree.ts";
import { Collaborations } from "../tools/collaborate/collaborations.ts";
import { Turns } from "../turns/turns.ts";
import type { AutomationRun } from "./automation.workflow.ts";
import { findRunId, lockAutomationSettlement } from "./execution.ts";
import { AutomationRuns } from "./runs.ts";
import { AutomationStore, endingAfter, endingOf, RUN_STOPPED_UNEXPECTEDLY } from "./store.ts";

/**
 * Settles automation runs: records how a run ended once nothing in its chats
 * is running, waiting or about to start. A completed run has its bot's last
 * reply posted in the automation's feed. An automation that fails twice in a row pauses
 * itself (see `AutomationStore.settle`).
 *
 * `handler` reacts to the chat events that can end a run. In the
 * emitting transaction it only records how an event says the run should end,
 * without locking the run; the run settles once that transaction commits, in
 * its own. A turn that failed for good, or a turn that was cancelled, starts
 * ending its run early: the rest of its work is cancelled, and it ends that
 * way once what is still running stops. Every later settlement of an ending run cancels whatever work is
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
	 * People are told only that it stopped unexpectedly. Does nothing once the
	 * run has ended.
	 */
	readonly failRun: (run: AutomationRun) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AutomationSettlement",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AutomationSettlement");
	const { emit } = yield* ChatEvents.Service;
	const turns = yield* Turns.Service;
	const collaborations = yield* Collaborations.Service;
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
	 * Cancels the work still going on in the run's chats `work`. Turns before
	 * collaborations, the order a turn writer takes them in when ending a turn
	 * fails its collaboration, so the two never wait on each other.
	 */
	const cancelWork = (work: readonly string[]) =>
		Effect.gen(function* () {
			yield* turns.stopUnder(work);
			yield* collaborations.failUnder(work);
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
				const runId = yield* query((db) => findRunId(db, chatId));
				if (!runId) return;
				yield* lockAutomationSettlement(runId);
				const run = yield* runningRun(runId);
				if (!run) return;
				const work = yield* workingChats(run.chatId);
				const wasEnding = endingOf(run);
				const ending = endingAfter(wasEnding, options.outcome);
				if (ending) yield* cancelWork(work);
				if (ending && (options.announce || !wasEnding)) {
					yield* emit([
						ChatEvent.AutomationWorkCancelled({
							workspaceId: run.workspaceId,
							chatIds: work,
						}),
					]);
				}
				if (ending && ending !== wasEnding) yield* automations.recordEnding(run.id, ending);
				if (yield* stillBusy(work, ending !== undefined)) return;
				const settled = settledAs(ending, yield* lastTurnIn(work));
				if (!(yield* automations.settle(run.id, settled))) return;
				if (settled.state === "completed") yield* postResult(run);
				yield* runs.settled({ automationId: run.automationId, runId: run.id });
			}),
		);

	/**
	 * Settles the runs of these chats once the transaction commits. Batched,
	 * so it is registered after the chat feed's outbox, which the handlers
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
					({ chatId, outcome }) =>
						Effect.gen(function* () {
							if (!outcome) return { chatId, announce: false };
							const runId = yield* query((db) => findRunId(db, chatId));
							const started = runId ? yield* automations.recordEnding(runId, outcome) : false;
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

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Collaborations.layer, AutomationStore.layer, ChatStore.layer]),
);

/** The chat an event may let an automation run settle in, and how the run ends if it ends it early. */
function settlementFor(
	event: ChatEvent,
): Array<{ readonly chatId: string; readonly outcome?: Turns.Ended }> {
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
							outcome: { state: "failed", error: event.userMessage },
						},
					];
		case "TurnCancelled":
			return [{ chatId: event.chatId, outcome: { state: "cancelled" } }];
		case "TurnAbandoned":
			return [{ chatId: event.chatId, outcome: event.outcome }];
		case "CollaborationAnswered":
		case "CollaborationStoppedWaiting":
			return [{ chatId: event.parentChatId }];
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
	if (lastTurn?.status === "failed") {
		// `turn.error` is nullable in the schema; a failure recorded without one
		// reads as having stopped unexpectedly.
		return { state: "failed", error: lastTurn.error ?? RUN_STOPPED_UNEXPECTEDLY };
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

/**
 * The text of the bot's last finished reply in the run's own chat, as the
 * chat shows it. Its collaborators' chats are their work, not its answer.
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

/** The chats a run's work happens in, under its own chat `rootChatId` (see `workingChatsOf`). */
const workingChats = (rootChatId: string) =>
	Effect.map(
		query((db) =>
			db.execute<{ id: string }>(
				sql`select id from ${workingChatsOf(sql`${rootChatId}`)} as work`,
				"objects",
			),
		),
		(rows) => rows.map(({ id }) => id),
	);

/** `chatIds` as a subquery of one uuid column. */
const chatIdsRelation = (chatIds: readonly string[]) =>
	sql`select unnest(array[${sql.join(
		chatIds.map((id) => sql`${id}`),
		sql`, `,
	)}]::uuid[])`;

/**
 * stillBusy reports whether work in the chats `work` keeps the run from
 * settling. Until the run is `ending`, that is anything running, waiting or
 * asked for. An ending run waits only for its running turns, which record how
 * they ended: its waiting turns and collaborations were cancelled, and the
 * turns its workflows still ask for are refused.
 */
const stillBusy = (work: readonly string[], ending: boolean) =>
	Effect.map(
		query((db) =>
			db.execute<{ busy: boolean }>(
				sql`select (
					exists (
						select 1 from ${turn}
						where ${inArray(turn.chatId, [...work])}
							and ${inArray(turn.status, ending ? ["running"] : ["running", "waiting"])}
					)
					${ending ? sql`` : sql`or ${turnsBusy(work)} or ${unansweredCollaborations(work)}`}
				) as busy`,
				"objects",
			),
		),
		([row]) => row?.busy ?? false,
	);

const turnsBusy = (work: readonly string[]) =>
	sql`exists (
		select 1 from (${chatIdsRelation(work)}) as work(id)
		where ${Turns.busyIn(sql`work.id`)}
	)`;

const unansweredCollaborations = (work: readonly string[]) =>
	sql`exists (
		select 1 from ${collaboration}
		where ${inArray(collaboration.parentChatId, [...work])}
			and ${inArray(collaboration.status, ["waiting", "pending"])}
	)`;

/** How the last turn to end in the chats `work` ended, if any has. */
const lastTurnIn = (work: readonly string[]) =>
	Effect.map(
		query((db) =>
			db
				.select({ status: turn.status, error: turn.error })
				.from(turn)
				.where(inArray(turn.chatId, [...work]))
				.orderBy(sql`${turn.finishedAt} desc nulls last`, desc(turn.id))
				.limit(1),
		),
		([row]) => row,
	);

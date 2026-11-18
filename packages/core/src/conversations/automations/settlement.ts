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
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { ConversationRepository } from "../repository/repository.ts";
import { workingConversationsOf } from "../repository/tree.ts";
import { Collaborations } from "../tools/collaborate/collaborations.ts";
import { Turns } from "../turns/turns.ts";
import type { AutomationRun } from "./automation.workflow.ts";
import { findRunId, lockAutomationSettlement } from "./execution.ts";
import {
	AutomationRepository,
	endingAfter,
	endingOf,
	RUN_STOPPED_UNEXPECTEDLY,
} from "./repository.ts";
import { AutomationRuns } from "./runs.ts";

/**
 * Settles automation runs: records how a run ended once nothing in its conversations
 * is running, waiting or about to start. A completed run has its bot's last
 * reply posted in the automation's feed. An automation that fails twice in a row pauses
 * itself (see `AutomationRepository.settle`).
 *
 * `handler` reacts to the conversation events that can end a run. In the
 * emitting transaction it only records how an event says the run should end,
 * without locking the run; the run settles once that transaction commits, in
 * its own. A turn that failed for good, or a turn that was cancelled, starts
 * ending its run early: the rest of its work is cancelled, and it ends that
 * way once what is still running stops. Every later settlement of an ending run cancels whatever work is
 * left, since some may have been held by another transaction. A settlement
 * lost to a crash after commit is made by the run's workflow's next check.
 */
export interface Interface {
	readonly handler: DomainEvents.Handler<ConversationEvent>;
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
	const { emit } = yield* ConversationEvents.Service;
	const turns = yield* Turns.Service;
	const collaborations = yield* Collaborations.Service;
	const automations = yield* AutomationRepository.Service;
	const runs = yield* AutomationRuns.Service;
	const conversations = yield* ConversationRepository.Service;

	/**
	 * Posts the bot's last reply in the run's own conversation, with the files
	 * the run wrote there, into the automation's feed. A run whose bot wrote
	 * nothing to show posts nothing.
	 */
	const postResult = (run: schema.RunRow) =>
		Effect.gen(function* () {
			const result = {
				content: (yield* lastReplyText(run)).trim(),
				files: yield* filesWrittenIn(run.conversationId),
			};
			if (result.content === "" && result.files.length === 0) return;
			yield* conversations.postRunResult({ run, result });
		});

	/**
	 * Cancels the work still going on in the run's conversations `work`. Turns before
	 * collaborations, the order a turn writer takes them in when ending a turn
	 * fails its collaboration, so the two never wait on each other.
	 */
	const cancelWork = (work: readonly string[]) =>
		Effect.gen(function* () {
			yield* turns.stopUnder(work);
			yield* collaborations.failUnder(work);
		});

	/**
	 * Settles the running automation run the conversation `conversationId` belongs to, if its
	 * work is done, first adding `outcome` to how it is ending. `announce` says
	 * the run started ending since it last settled, so watching clients are
	 * told its work was cancelled.
	 *
	 * The run is read without locking it, and written only after its work is
	 * cancelled (see `AutomationRepository.recordEnding`). An ending recorded
	 * after the read settles the run again once its transaction commits.
	 */
	const settle = (
		conversationId: string,
		options: { outcome?: Turns.Ended; announce?: boolean } = {},
	) =>
		transaction(
			Effect.gen(function* () {
				const runId = yield* query((db) => findRunId(db, conversationId));
				if (!runId) return;
				yield* lockAutomationSettlement(runId);
				const run = yield* runningRun(runId);
				if (!run) return;
				const work = yield* workingConversations(run.conversationId);
				const wasEnding = endingOf(run);
				const ending = endingAfter(wasEnding, options.outcome);
				if (ending) yield* cancelWork(work);
				if (ending && (options.announce || !wasEnding)) {
					yield* emit([
						ConversationEvent.AutomationWorkCancelled({
							workspaceId: run.workspaceId,
							conversationIds: work,
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
	 * Settles the runs of these conversations once the transaction commits. Batched,
	 * so it is registered after the conversation feed's outbox, which the handlers
	 * reach first: clients hear what a turn did before they hear its run settled.
	 */
	const settleAfterCommit = batchedBeforeCommit(
		(settlements: ReadonlyArray<{ conversationId: string; announce: boolean }>) =>
			Effect.flatMap(Database, (database) => {
				const announced = new Map<string, boolean>();
				for (const { conversationId, announce } of settlements) {
					announced.set(conversationId, announce || (announced.get(conversationId) ?? false));
				}
				return afterCommit(
					Effect.forEach(
						announced,
						([conversationId, announce]) => settle(conversationId, { announce }),
						{
							discard: true,
						},
					).pipe(Effect.provideService(Database, database)),
				);
			}),
	);

	return Service.of({
		handler: (events) =>
			Effect.gen(function* () {
				const settlements = yield* Effect.forEach(
					events.flatMap(settlementFor),
					({ conversationId, outcome }) =>
						Effect.gen(function* () {
							if (!outcome) return { conversationId, announce: false };
							const runId = yield* query((db) => findRunId(db, conversationId));
							const started = runId ? yield* automations.recordEnding(runId, outcome) : false;
							return { conversationId, announce: started };
						}),
				);
				yield* settleAfterCommit(settlements);
			}),

		settleRun: (run) =>
			operation(
				"settleRun",
				Effect.gen(function* () {
					const conversationId = yield* runConversationOf(run.runId);
					if (!conversationId) return true;
					yield* settle(conversationId);
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
						const conversationId = yield* runConversationOf(run.runId);
						if (conversationId) {
							yield* settle(conversationId, {
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
	Layer.provide([Collaborations.layer, AutomationRepository.layer, ConversationRepository.layer]),
);

/** The conversation an event may let an automation run settle in, and how the run ends if it ends it early. */
function settlementFor(
	event: ConversationEvent,
): Array<{ readonly conversationId: string; readonly outcome?: Turns.Ended }> {
	switch (event._tag) {
		case "TurnCompleted":
		case "LaneReleased":
			return [{ conversationId: event.conversationId }];
		case "TurnFailed":
			// A turn that runs again has not failed for good.
			return event.willRetry
				? []
				: [
						{
							conversationId: event.conversationId,
							outcome: { state: "failed", error: event.userMessage },
						},
					];
		case "TurnCancelled":
			return [{ conversationId: event.conversationId, outcome: { state: "cancelled" } }];
		case "TurnAbandoned":
			return [{ conversationId: event.conversationId, outcome: event.outcome }];
		case "CollaborationAnswered":
		case "CollaborationStoppedWaiting":
			return [{ conversationId: event.parentConversationId }];
		default:
			return [];
	}
}

/** settledAs returns how a run whose work is over ends: as it was ending, or else as its last turn did. */
function settledAs(
	ending: Turns.Ended | undefined,
	lastTurn: { status: string; error: UserText | null } | undefined,
): AutomationRepository.Settled {
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
 * The text of the bot's last finished reply in the run's own conversation, as the
 * conversation shows it. Its collaborators' conversations are their work, not its answer.
 */
const lastReplyText = (run: schema.RunRow) =>
	Effect.map(
		query((db) =>
			db
				.select({ parts: message.parts })
				.from(message)
				.where(
					and(
						eq(message.conversationId, run.conversationId),
						eq(message.authorBotId, run.botId),
						eq(message.status, "complete"),
					),
				)
				.orderBy(desc(message.createdAt), desc(message.id))
				.limit(1),
		),
		([row]) => (row ? textWithoutNarration(row.parts) : ""),
	);

/** Each file written in the conversation `conversationId`, as `filesWrittenBy` its calls in the order they finished. */
const filesWrittenIn = (conversationId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ tool: toolCall.tool, status: toolCall.status, output: toolCall.output })
				.from(toolCall)
				.where(
					and(
						eq(toolCall.conversationId, conversationId),
						eq(toolCall.status, "completed"),
						inArray(toolCall.tool, [...FILE_WRITING_TOOLS]),
					),
				)
				.orderBy(asc(toolCall.finishedAt), asc(toolCall.id)),
		),
		filesWrittenBy,
	);

const runConversationOf = (runId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ conversationId: automationRun.conversationId })
				.from(automationRun)
				.where(eq(automationRun.id, runId))
				.limit(1),
		),
		([row]) => row?.conversationId,
	);

/** The conversations a run's work happens in, under its own conversation `rootConversationId` (see `workingConversationsOf`). */
const workingConversations = (rootConversationId: string) =>
	Effect.map(
		query((db) =>
			db.execute<{ id: string }>(
				sql`select id from ${workingConversationsOf(sql`${rootConversationId}`)} as work`,
				"objects",
			),
		),
		(rows) => rows.map(({ id }) => id),
	);

/** `conversationIds` as a subquery of one uuid column. */
const conversationIdsRelation = (conversationIds: readonly string[]) =>
	sql`select unnest(array[${sql.join(
		conversationIds.map((id) => sql`${id}`),
		sql`, `,
	)}]::uuid[])`;

/**
 * stillBusy reports whether work in the conversations `work` keeps the run from
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
						where ${inArray(turn.conversationId, [...work])}
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
		select 1 from (${conversationIdsRelation(work)}) as work(id)
		where ${Turns.busyIn(sql`work.id`)}
	)`;

const unansweredCollaborations = (work: readonly string[]) =>
	sql`exists (
		select 1 from ${collaboration}
		where ${inArray(collaboration.parentConversationId, [...work])}
			and ${inArray(collaboration.status, ["waiting", "pending"])}
	)`;

/** How the last turn to end in the conversations `work` ended, if any has. */
const lastTurnIn = (work: readonly string[]) =>
	Effect.map(
		query((db) =>
			db
				.select({ status: turn.status, error: turn.error })
				.from(turn)
				.where(inArray(turn.conversationId, [...work]))
				.orderBy(sql`${turn.finishedAt} desc nulls last`, desc(turn.id))
				.limit(1),
		),
		([row]) => row,
	);

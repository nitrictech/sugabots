export * as Compactions from "./compactions.ts";

import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
	afterCommit,
	type Database,
	type Executor,
	query,
	serviceOperations,
	transaction,
} from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import { threadCompaction } from "../../database/schema.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { COMPACT_SYSTEM_AGENT, findSystemAgent } from "../../workspaces/agents/system-agents.ts";
import type { ConversationEvent } from "../events.ts";
import { ThreadRepository } from "../threads/repository.ts";
import {
	loadSystemAgentScope,
	loadTranscript,
	type TranscriptEntry,
} from "../threads/system-agent-threads.ts";
import { Turns } from "../turns/turns.ts";
import { admitCompaction, type CompactionRequest } from "./compaction.workflow.ts";
import { CompactionRepository } from "./repository.ts";
import { needsCompaction, planCompaction } from "./window.ts";

/**
 * Thread compaction, done by the `compact` system agent, Compaction.
 *
 * When a turn's prompt passes the compaction line, the thread is queued for
 * compaction. The Compaction agent summarises the stretch of history just
 * before the newest messages, and from then on a bot in the thread reads that
 * summary and the newest messages instead of the whole thread. People still
 * see every message. Like the Scribe, its turns live in a child thread of the
 * one it works on. It runs on the model of the bot whose reply asked for it,
 * so a thread is summarised as well as it is read, and falls back to the
 * system agents' model for a bot with none.
 */
export interface Interface {
	/**
	 * Opens the Compaction agent's thread and loads what it summarises, or says
	 * why there is nothing to do: the thread is gone, neither the bot nor the
	 * Compaction agent has a model, the turn that asked was measured before
	 * the latest compaction, or there is nothing new to summarise.
	 */
	readonly prepare: (
		request: CompactionRequest,
	) => Effect.Effect<PreparedCompaction | CompactionSkipped>;
	/** Records the summary as what the thread's bots read from now on. */
	readonly complete: (prepared: PreparedCompaction, summary: string) => Effect.Effect<void>;
	/**
	 * Asks for a compaction once a completed reply's prompt reaches the
	 * compaction line, after it commits. One that can't be asked for is logged
	 * and lost: the next reply past the line asks again.
	 */
	readonly handler: DomainEvents.Handler<ConversationEvent>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Compactions") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Compactions");
	const lanes = yield* Lanes.Service;
	const threads = yield* ThreadRepository.Service;
	const compactions = yield* CompactionRepository.Service;
	return Service.of({
		prepare: (request) =>
			operation(
				"prepare",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						PreparedCompaction | CompactionSkipped,
						never,
						Database
					> {
						const scope = yield* query((db) => loadSystemAgentScope(db, request));
						if (!scope) {
							return skipped("The thread, the agent that triggered it, or its message is gone");
						}
						const compactor = yield* query((db) =>
							findSystemAgent(db, scope.workspaceId, COMPACT_SYSTEM_AGENT),
						);
						if (!compactor) return skipped("This workspace has no Compaction agent");
						const model = scope.agentModel ?? compactor.model;
						if (model === null) {
							return skipped("Neither the bot nor the Compaction agent has a model");
						}

						const previous = yield* query((db) => loadCompaction(db, scope.threadId));
						if (previous && previous.keptFrom.toISOString() !== request.readKeptFrom) {
							return skipped("The turn was measured before the thread's latest compaction");
						}
						const transcript = yield* query((db) => loadTranscript(db, scope.threadId));
						const sourceIndex = transcript.findIndex((row) => row.id === request.sourceMessageId);
						const history = transcript
							.slice(0, sourceIndex + 1)
							.flatMap(({ createdAt, entry }) =>
								entry
									? [{ ...entry, createdAt, tokens: Turns.estimatedTokens(entry.content) }]
									: [],
							);
						// Sized to the bot that reads the thread next, and capped to what
						// the model summarising it can read.
						const readerModel = scope.agentModel;
						const readerTokens =
							readerModel === null
								? Turns.MAX_CONTEXT_WINDOW_TOKENS
								: yield* query((db) => Turns.loadContextWindow(db, scope.workspaceId, readerModel));
						const summariserTokens =
							model === readerModel
								? readerTokens
								: yield* query((db) => Turns.loadContextWindow(db, scope.workspaceId, model));
						const plan = planCompaction(history, previous?.keptFrom, {
							readerTokens,
							summariserTokens,
						});
						if (!plan) return skipped("There is nothing new to summarise");

						const systemAgentThreadId = yield* threads.openSystemAgentThread({
							served: {
								id: scope.threadId,
								workspaceId: scope.workspaceId,
								podId: scope.podId,
								initiatorUserId: scope.initiatorUserId,
							},
							systemAgentId: compactor.id,
							systemAgentKey: COMPACT_SYSTEM_AGENT,
							title: `Compactions of ${scope.threadTitle}`,
						});
						return {
							_tag: "Prepared",
							request,
							compactor: { threadId: systemAgentThreadId, agentId: compactor.id },
							threadId: scope.threadId,
							workspaceId: scope.workspaceId,
							podId: scope.podId,
							threadTitle: scope.threadTitle,
							model,
							transcript: plan.summarised.map(({ author, kind, content, createdAt }) => ({
								author,
								kind,
								content,
								createdAt,
							})),
							previousSummary: previous?.summary,
							// The previous summary is folded into this one, so what it covers
							// still starts where the first compaction's history did.
							historyStartsAt: previous?.historyStartsAt ?? plan.historyStartsAt,
							keptFrom: plan.keptFrom,
						};
					}),
				),
			),

		complete: (prepared, summary) =>
			operation(
				"complete",
				transaction(
					Effect.gen(function* () {
						yield* compactions.save({
							workspaceId: prepared.workspaceId,
							podId: prepared.podId,
							threadId: prepared.threadId,
							summary,
							historyStartsAt: prepared.historyStartsAt,
							keptFrom: prepared.keptFrom,
						});
					}),
				),
			),

		handler: (events) =>
			Effect.forEach(
				events,
				(event) =>
					event._tag === "TurnCompleted" &&
					needsCompaction(event.contextTokens, event.contextCapacity)
						? afterCommit(
								admitCompaction(lanes, {
									threadId: event.threadId,
									agentId: event.agentId,
									sourceMessageId: event.messageId,
									readKeptFrom: event.readKeptFrom,
								}),
							)
						: Effect.void,
				{ discard: true },
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([ThreadRepository.layer, CompactionRepository.layer]),
);

/**
 * A compaction with nothing to do: its thread or source is gone, there is
 * nothing new to summarise, or the Compaction agent's turn may not run.
 * `reason` is for the logs.
 */
export interface CompactionSkipped {
	readonly _tag: "Skipped";
	readonly reason: string;
}

/** A requested compaction with its turn opened and its input loaded. */
export interface PreparedCompaction {
	readonly _tag: "Prepared";
	request: CompactionRequest;
	/** The Compaction agent, and the thread its turns are recorded in. */
	compactor: { threadId: string; agentId: string };
	threadId: string;
	workspaceId: string;
	podId: string;
	threadTitle: string;
	model: string;
	/** The summary the thread's bots read until now, which this one replaces and carries forward. */
	previousSummary: string | undefined;
	/** The messages to summarise, oldest first: those since the previous summary's. */
	transcript: Array<TranscriptEntry & { createdAt: Date }>;
	historyStartsAt: Date;
	keptFrom: Date;
}

function skipped(reason: string): CompactionSkipped {
	return { _tag: "Skipped", reason };
}

/** A thread's current compaction, if it has one. */
const loadCompaction = Effect.fn("Compactions.loadCompaction")(function* (
	db: Executor,
	threadId: string,
) {
	const [row] = yield* db
		.select({
			summary: threadCompaction.summary,
			historyStartsAt: threadCompaction.historyStartsAt,
			keptFrom: threadCompaction.keptFrom,
		})
		.from(threadCompaction)
		.where(eq(threadCompaction.threadId, threadId))
		.limit(1);
	return row;
});

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
import { conversationCompaction } from "../../database/schema.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { COMPACT_SYSTEM_BOT, findSystemBot } from "../../workspaces/bots/system-bots.ts";
import type { ConversationEvent } from "../events.ts";
import { ConversationRepository } from "../repository/repository.ts";
import {
	loadSystemBotScope,
	loadTranscript,
	type TranscriptEntry,
} from "../repository/system-bot-conversations.ts";
import { Turns } from "../turns/turns.ts";
import { admitCompaction, type CompactionRequest } from "./compaction.workflow.ts";
import { makeRecords } from "./repository.ts";
import { needsCompaction, planCompaction } from "./window.ts";

/**
 * Compaction, done by the `compact` system bot, Compaction.
 *
 * When a turn's prompt passes the compaction line, the conversation is queued for
 * compaction. The Compaction bot summarises the stretch of history just
 * before the newest messages, and from then on a bot in the conversation reads that
 * summary and the newest messages instead of the whole conversation. People still
 * see every message. Like the Summariser, its turns live in a system conversation hanging off the
 * one it works on. It runs on the model of the bot whose reply asked for it,
 * so a conversation is summarised as well as it is read, and falls back to the
 * system bots' model for a bot with none.
 */
export interface Interface {
	/**
	 * Opens the Compaction bot's conversation and loads what it summarises, or says
	 * why there is nothing to do: the conversation is gone, neither the bot nor the
	 * Compaction bot has a model, the turn that asked was measured before
	 * the latest compaction, or there is nothing new to summarise.
	 */
	readonly prepare: (
		request: CompactionRequest,
	) => Effect.Effect<PreparedCompaction | CompactionSkipped>;
	/** Records the summary as what the conversation's bots read from now on. */
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
	const conversations = yield* ConversationRepository.Service;
	const compactions = yield* makeRecords;
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
						const scope = yield* query((db) =>
							loadSystemBotScope(db, {
								conversationId: request.conversationId,
								botId: request.botId,
								sourceMessageId: request.sourceMessageId,
							}),
						);
						if (!scope) {
							return skipped("The conversation, the bot that triggered it, or its message is gone");
						}
						const compactor = yield* query((db) =>
							findSystemBot(db, scope.workspaceId, COMPACT_SYSTEM_BOT),
						);
						if (!compactor) return skipped("This workspace has no Compaction bot");
						const model = scope.botModel ?? compactor.model;
						if (model === null) {
							return skipped("Neither the bot nor the Compaction bot has a model");
						}

						const previous = yield* query((db) => loadCompaction(db, scope.conversationId));
						if (previous && previous.keptFrom.toISOString() !== request.readKeptFrom) {
							return skipped("The turn was measured before the conversation's latest compaction");
						}
						// Only what the last compaction kept can be summarised now (see
						// `planCompaction`), so nothing before it is read.
						const transcript = yield* query((db) =>
							loadTranscript(db, scope.conversationId, { from: previous?.keptFrom }),
						);
						const sourceIndex = transcript.findIndex((row) => row.id === request.sourceMessageId);
						const history = transcript
							.slice(0, sourceIndex + 1)
							.flatMap(({ createdAt, entry }) =>
								entry
									? [{ ...entry, createdAt, tokens: Turns.estimatedTokens(entry.content) }]
									: [],
							);
						// Sized to the bot that reads the conversation next, and capped to what
						// the model summarising it can read.
						const readerModel = scope.botModel;
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

						const systemConversationId = yield* conversations.openSystemConversation({
							served: { id: scope.conversationId, workspaceId: scope.workspaceId },
							systemBotId: compactor.id,
							systemBotKey: COMPACT_SYSTEM_BOT,
							title: `Compactions of ${scope.conversationTitle}`,
						});
						return {
							_tag: "Prepared",
							request,
							compactor: { conversationId: systemConversationId, botId: compactor.id },
							conversationId: scope.conversationId,
							workspaceId: scope.workspaceId,
							conversationTitle: scope.conversationTitle,
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
							conversationId: prepared.conversationId,
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
									conversationId: event.conversationId,
									botId: event.botId,
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

export const layer = layerNoDeps.pipe(Layer.provide(ConversationRepository.layer));

/**
 * A compaction with nothing to do: its conversation or source is gone, there is
 * nothing new to summarise, or the Compaction bot's turn may not run.
 * `reason` is for the logs.
 */
interface CompactionSkipped {
	readonly _tag: "Skipped";
	readonly reason: string;
}

/** A requested compaction with its turn opened and its input loaded. */
export interface PreparedCompaction {
	readonly _tag: "Prepared";
	request: CompactionRequest;
	/** The Compaction bot, and the conversation its turns are recorded in. */
	compactor: { conversationId: string; botId: string };
	conversationId: string;
	workspaceId: string;
	conversationTitle: string;
	model: string;
	/** The summary the conversation's bots read until now, which this one replaces and carries forward. */
	previousSummary: string | undefined;
	/** The messages to summarise, oldest first: those since the previous summary's. */
	transcript: Array<TranscriptEntry & { createdAt: Date }>;
	historyStartsAt: Date;
	keptFrom: Date;
}

function skipped(reason: string): CompactionSkipped {
	return { _tag: "Skipped", reason };
}

/** A conversation's current compaction, if it has one. */
const loadCompaction = Effect.fn("Compactions.loadCompaction")(function* (
	db: Executor,
	conversationId: string,
) {
	const [row] = yield* db
		.select({
			summary: conversationCompaction.summary,
			historyStartsAt: conversationCompaction.historyStartsAt,
			keptFrom: conversationCompaction.keptFrom,
		})
		.from(conversationCompaction)
		.where(eq(conversationCompaction.conversationId, conversationId))
		.limit(1);
	return row;
});

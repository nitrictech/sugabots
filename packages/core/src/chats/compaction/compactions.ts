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
import { chatCompaction } from "../../database/schema.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { COMPACT_SYSTEM_BOT, findSystemBot } from "../../workspaces/bots/system-bots.ts";
import type { ChatEvent } from "../events.ts";
import { ChatStore } from "../store/store.ts";
import {
	loadSystemBotScope,
	loadTranscript,
	type TranscriptEntry,
} from "../store/system-bot-chats.ts";
import { Turns } from "../turns/turns.ts";
import { admitCompaction, type CompactionRequest } from "./compaction.workflow.ts";
import { makeCompactionStore } from "./store.ts";
import { needsCompaction, planCompaction } from "./window.ts";

/**
 * Compaction, done by the `compact` system bot, Compaction.
 *
 * When a turn's prompt passes the compaction line, the chat is queued for
 * compaction. The Compaction bot condenses the stretch of history just
 * before the newest messages, and from then on a bot in the chat reads that
 * condensed account and the newest messages instead of the whole chat. Members still
 * see every message. Its turns live in a system chat hanging off the
 * one it works on. It runs on the model of the bot whose reply asked for it,
 * so a chat is condensed as well as it is read, and falls back to the
 * system bots' model for a bot with none.
 */
export interface Interface {
	/**
	 * Opens the Compaction bot's chat and loads what it condenses, or says
	 * why there is nothing to do: the chat is gone, neither the bot nor the
	 * Compaction bot has a model, the turn that asked was measured before
	 * the latest compaction, or there is nothing new to condense.
	 */
	readonly prepare: (
		request: CompactionRequest,
	) => Effect.Effect<PreparedCompaction | CompactionSkipped>;
	/** Records the condensed account as what the chat's bots read from now on. */
	readonly complete: (prepared: PreparedCompaction, condensed: string) => Effect.Effect<void>;
	/**
	 * Asks for a compaction once a completed reply's prompt reaches the
	 * compaction line, after it commits. One that can't be asked for is logged
	 * and lost: the next reply past the line asks again.
	 */
	readonly handler: DomainEvents.Handler<ChatEvent>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Compactions") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Compactions");
	const lanes = yield* Lanes.Service;
	const chats = yield* ChatStore.Service;
	const compactions = yield* makeCompactionStore;
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
								chatId: request.chatId,
								botId: request.botId,
								sourceMessageId: request.sourceMessageId,
							}),
						);
						if (!scope) {
							return skipped("The chat, the bot that triggered it, or its message is gone");
						}
						const compactor = yield* query((db) =>
							findSystemBot(db, scope.workspaceId, COMPACT_SYSTEM_BOT),
						);
						if (!compactor) return skipped("This workspace has no Compaction bot");
						const model = scope.botModel ?? compactor.model;
						if (model === null) {
							return skipped("Neither the bot nor the Compaction bot has a model");
						}

						const previous = yield* query((db) => loadCompaction(db, scope.chatId));
						if (previous && previous.keptFrom.toISOString() !== request.readKeptFrom) {
							return skipped("The turn was measured before the chat's latest compaction");
						}
						// Only what the last compaction kept can be condensed now (see
						// `planCompaction`), so nothing before it is read.
						const transcript = yield* query((db) =>
							loadTranscript(db, scope.chatId, { from: previous?.keptFrom }),
						);
						const sourceIndex = transcript.findIndex((row) => row.id === request.sourceMessageId);
						const history = transcript
							.slice(0, sourceIndex + 1)
							.flatMap(({ createdAt, entry }) =>
								entry
									? [{ ...entry, createdAt, tokens: Turns.estimatedTokens(entry.content) }]
									: [],
							);
						// Sized to the bot that reads the chat next, and capped to what
						// the model condensing it can read.
						const readerModel = scope.botModel;
						const readerTokens =
							readerModel === null
								? Turns.MAX_CONTEXT_WINDOW_TOKENS
								: yield* query((db) => Turns.loadContextWindow(db, scope.workspaceId, readerModel));
						const compactorTokens =
							model === readerModel
								? readerTokens
								: yield* query((db) => Turns.loadContextWindow(db, scope.workspaceId, model));
						const plan = planCompaction(history, previous?.keptFrom, {
							readerTokens,
							compactorTokens,
						});
						if (!plan) return skipped("There is nothing new to condense");

						const systemChatId = yield* chats.openSystemChat({
							served: { id: scope.chatId, workspaceId: scope.workspaceId },
							systemBotId: compactor.id,
							systemBotKey: COMPACT_SYSTEM_BOT,
							title: `Compactions of ${scope.chatTitle}`,
						});
						return {
							_tag: "Prepared",
							compactor: { chatId: systemChatId, botId: compactor.id },
							chatId: scope.chatId,
							workspaceId: scope.workspaceId,
							chatTitle: scope.chatTitle,
							model,
							transcript: plan.toCondense.map(({ author, kind, content, createdAt }) => ({
								author,
								kind,
								content,
								createdAt,
							})),
							previousCondensed: previous?.condensed,
							// The previous condensed account is folded into this one, so what it covers
							// still starts where the first compaction's history did.
							historyStartsAt: previous?.historyStartsAt ?? plan.historyStartsAt,
							keptFrom: plan.keptFrom,
						};
					}),
				),
			),

		complete: (prepared, condensed) =>
			operation(
				"complete",
				transaction(
					Effect.gen(function* () {
						yield* compactions.save({
							workspaceId: prepared.workspaceId,
							chatId: prepared.chatId,
							condensed,
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
									chatId: event.chatId,
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

export const layer = layerNoDeps.pipe(Layer.provide(ChatStore.layer));

/**
 * A compaction with nothing to do: its chat or source is gone, there is
 * nothing new to condense, or the Compaction bot's turn may not run.
 * `reason` is for the logs.
 */
interface CompactionSkipped {
	readonly _tag: "Skipped";
	readonly reason: string;
}

/** A requested compaction with its turn opened and its input loaded. */
export interface PreparedCompaction {
	readonly _tag: "Prepared";
	/** The Compaction bot, and the chat its turns are recorded in. */
	compactor: { chatId: string; botId: string };
	chatId: string;
	workspaceId: string;
	chatTitle: string;
	model: string;
	/** The condensed account the chat's bots read until now, which this one replaces and carries forward. */
	previousCondensed: string | undefined;
	/** The messages to condense, oldest first: those since the previous condensed account's. */
	transcript: Array<TranscriptEntry & { createdAt: Date }>;
	historyStartsAt: Date;
	keptFrom: Date;
}

function skipped(reason: string): CompactionSkipped {
	return { _tag: "Skipped", reason };
}

/** A chat's current compaction, if it has one. */
const loadCompaction = Effect.fn("Compactions.loadCompaction")(function* (
	db: Executor,
	chatId: string,
) {
	const [row] = yield* db
		.select({
			condensed: chatCompaction.condensed,
			historyStartsAt: chatCompaction.historyStartsAt,
			keptFrom: chatCompaction.keptFrom,
		})
		.from(chatCompaction)
		.where(eq(chatCompaction.chatId, chatId))
		.limit(1);
	return row;
});

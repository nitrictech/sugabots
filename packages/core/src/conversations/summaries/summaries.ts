export * as Summaries from "./summaries.ts";

import type { ConversationKind } from "@sugabots/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
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
import { bot, botSummary, conversationSummary, placedConversation } from "../../database/schema.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { findRunnableSystemBot, SUMMARISE_SYSTEM_BOT } from "../../workspaces/bots/system-bots.ts";
import type { ConversationEvent } from "../events.ts";
import { madeByPeople } from "../repository/participants.ts";
import { ConversationRepository } from "../repository/repository.ts";
import { type BotConversationId, isBotConversation } from "../repository/rooms.ts";
import {
	loadSystemBotScope,
	loadTranscript,
	type TranscriptEntry,
} from "../repository/system-bot-conversations.ts";
import { makeRecords } from "./repository.ts";
import { admitSummary, type SummaryRequest } from "./summary.workflow.ts";

/**
 * Summaries, written by the `summarise` system bot.
 *
 * After a bot completes a turn, a summary is requested for the conversation, though
 * a project's thread or a direct message is never summarised. The
 * system bot reads what was said since the last summary and rewrites it, and on
 * the first pass also titles the conversation. Its turns live in a system conversation hanging off
 * the one being summarised, so a person can read back what the system bot did
 * without it appearing in their conversation.
 */
export interface Interface {
	/**
	 * Opens the Summariser's conversation and loads the transcript, or says why there is
	 * nothing to do.
	 */
	readonly prepare: (request: SummaryRequest) => Effect.Effect<PreparedSummary | SummarySkipped>;
	/**
	 * What rewriting the summary of the bot whose conversation `conversationId` is takes:
	 * the newest summaries of its conversations, and what it said before. Nothing
	 * for a conversation no bot people made hosts.
	 */
	readonly prepareBotSummary: (
		conversationId: string,
	) => Effect.Effect<PreparedBotSummary | undefined>;
	/** Replaces what the bot has been doing lately. */
	readonly completeBotSummary: (
		prepared: PreparedBotSummary,
		content: string,
	) => Effect.Effect<void>;
	/** Records the summary, and titles the conversation on its first. */
	readonly complete: (
		prepared: PreparedSummary,
		result: { content: string; title?: string },
	) => Effect.Effect<void>;
	/**
	 * Asks for a summary after each completed reply, once it commits. A request
	 * still waiting for the conversation is pointed at the newer reply instead. One
	 * that can't be asked for is logged and lost: the next reply asks again.
	 */
	readonly handler: DomainEvents.Handler<ConversationEvent>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Summaries") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Summaries");
	const lanes = yield* Lanes.Service;
	const conversations = yield* ConversationRepository.Service;
	const summaries = yield* makeRecords;
	return Service.of({
		prepare: (request) =>
			operation(
				"prepare",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						PreparedSummary | SummarySkipped,
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
						// A thread of a project people made goes on and on, and keeps the name people
						// gave it: only a bot's conversation, one piece of work, its threads included,
						// is summarised and titled from its summary.
						const served = {
							id: scope.conversationId,
							kind: scope.conversationKind,
							botId: scope.conversationBotId,
						};
						if (!isBotConversation(served))
							return skipped("Projects' threads and direct messages are not summarised");
						const summariser = yield* query((db) =>
							findRunnableSystemBot(db, scope.workspaceId, SUMMARISE_SYSTEM_BOT),
						);
						if (!summariser)
							return skipped("This workspace has chosen no model for the Summariser");

						// One query at a time: inside a transaction the executor is a single
						// connection, and queries sent concurrently down one are not run concurrently
						// anyway. The driver queues them, and warns that it is about to stop accepting
						// them at all.
						const previous = yield* query((db) =>
							loadConversationSummary(db, scope.conversationId),
						);
						const transcriptRows = yield* query((db) => loadTranscript(db, scope.conversationId));
						const sourceIndex = transcriptRows.findIndex(
							(row) => row.id === request.sourceMessageId,
						);
						if (sourceIndex === -1) {
							return yield* Effect.die(
								new Error("Conversation summary source message disappeared during preparation"),
							);
						}
						const previousSourceIndex = previous
							? transcriptRows.findIndex((row) => row.id === previous.sourceMessageId)
							: -1;
						if (previousSourceIndex >= sourceIndex) {
							return skipped("The conversation is already summarised to this message");
						}

						const systemConversationId = yield* conversations.openSystemConversation({
							served: { id: scope.conversationId, workspaceId: scope.workspaceId },
							systemBotId: summariser.id,
							systemBotKey: SUMMARISE_SYSTEM_BOT,
							title: summariesTitle(scope.conversationTitle),
						});
						return {
							_tag: "Prepared",
							request,
							summariser: { conversationId: systemConversationId, botId: summariser.id },
							conversationId: served.id,
							workspaceId: scope.workspaceId,
							sourceMessageId: request.sourceMessageId,
							conversationTitle: scope.conversationTitle,
							model: summariser.model,
							previousContent: previous?.content,
							transcript: transcriptRows
								.slice(
									Math.max(0, previousSourceIndex + 1 - SUMMARY_TRANSCRIPT_OVERLAP_MESSAGES),
									sourceIndex + 1,
								)
								.flatMap(({ entry }) => (entry ? [entry] : [])),
						};
					}),
				),
			),

		prepareBotSummary: (conversationId) =>
			operation(
				"prepareBotSummary",
				Effect.gen(function* () {
					const [host] = yield* query((db) =>
						db
							.select({
								id: bot.id,
								name: bot.name,
								workspaceId: bot.workspaceId,
								previous: botSummary.content,
							})
							.from(placedConversation)
							.innerJoin(bot, and(eq(bot.id, placedConversation.botId), madeByPeople))
							.leftJoin(botSummary, eq(botSummary.botId, bot.id))
							.where(
								and(
									eq(placedConversation.id, conversationId),
									inArray(placedConversation.kind, [...BOT_SUMMARY_SOURCES]),
								),
							)
							.limit(1),
					);
					if (!host) return undefined;
					const summariser = yield* query((db) =>
						findRunnableSystemBot(db, host.workspaceId, SUMMARISE_SYSTEM_BOT),
					);
					if (!summariser) return undefined;
					const conversations = yield* query((db) =>
						db
							.select({
								title: placedConversation.title,
								summary: conversationSummary.content,
								updatedAt: conversationSummary.updatedAt,
								doneAt: placedConversation.doneAt,
							})
							.from(conversationSummary)
							.innerJoin(
								placedConversation,
								eq(placedConversation.id, conversationSummary.conversationId),
							)
							.where(
								and(
									eq(placedConversation.botId, host.id),
									inArray(placedConversation.kind, [...BOT_SUMMARY_SOURCES]),
								),
							)
							.orderBy(desc(conversationSummary.updatedAt))
							.limit(BOT_SUMMARY_CONVERSATIONS),
					);
					return {
						botId: host.id,
						botName: host.name,
						workspaceId: host.workspaceId,
						model: summariser.model,
						previousContent: host.previous ?? undefined,
						conversations,
					} satisfies PreparedBotSummary;
				}),
			),

		completeBotSummary: (prepared, content) =>
			operation(
				"completeBotSummary",
				Effect.gen(function* () {
					const [newest] = prepared.conversations;
					// Written from no conversation's summary, it has nothing to say.
					if (!newest) return;
					yield* summaries.saveBotSummary({
						botId: prepared.botId,
						content,
						coversThrough: newest.updatedAt,
					});
				}),
			),

		complete: (prepared, result) =>
			operation(
				"complete",
				transaction(
					Effect.gen(function* () {
						if (
							result.title &&
							(yield* conversations.retitle(prepared.conversationId, result.title))
						) {
							// The conversation holding the summaries is named after this one, which
							// had no real title until the first summary gave it one.
							yield* conversations.retitleSystemConversation({
								servedConversationId: prepared.conversationId,
								systemBotKey: SUMMARISE_SYSTEM_BOT,
								title: summariesTitle(result.title),
							});
						}
						yield* summaries.save({
							workspaceId: prepared.workspaceId,
							conversationId: prepared.conversationId,
							content: result.content,
							sourceMessageId: prepared.sourceMessageId,
						});
					}),
				),
			),

		handler: (events) =>
			Effect.forEach(
				events,
				(event) =>
					event._tag === "TurnCompleted"
						? afterCommit(
								admitSummary(lanes, {
									conversationId: event.conversationId,
									botId: event.botId,
									sourceMessageId: event.messageId,
								}),
							)
						: Effect.void,
				{ discard: true },
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ConversationRepository.layer));

const SUMMARY_TRANSCRIPT_OVERLAP_MESSAGES = 10;

/** How many of a bot's most recently summarised conversations its own summary is written from. */
const BOT_SUMMARY_CONVERSATIONS = 15;

/**
 * The conversations a bot's summary is written from: its own threads, in its
 * default project, and automation feeds, which everyone who reaches the bot
 * sees. A collaboration it was asked in belongs to the conversation that
 * asked, which they may not see; so does a thread of a project people made,
 * whose `bot_id` the view leaves null.
 */
const BOT_SUMMARY_SOURCES = [
	"project_thread",
	"automation_feed",
] as const satisfies readonly ConversationKind[];

/** What the Summariser writes a bot's summary from. */
export interface PreparedBotSummary {
	readonly botId: string;
	readonly botName: string;
	readonly workspaceId: string;
	readonly model: string;
	readonly previousContent: string | undefined;
	/** Its conversations' summaries, most recently changed first. */
	readonly conversations: ReadonlyArray<{
		title: string;
		summary: string;
		updatedAt: Date;
		doneAt: Date | null;
	}>;
}

/**
 * A summary that has nothing to do: its conversation or source is gone, it is
 * already written, or the Summariser's turn may not run. `reason` is for the logs.
 */
interface SummarySkipped {
	readonly _tag: "Skipped";
	readonly reason: string;
}

/** A requested summary with its input loaded. */
export interface PreparedSummary {
	readonly _tag: "Prepared";
	request: SummaryRequest;
	/** The Summariser, and the conversation its turns are recorded in. */
	summariser: { conversationId: string; botId: string };
	conversationId: BotConversationId;
	workspaceId: string;
	/** The last message this summary will cover. */
	sourceMessageId: string;
	conversationTitle: string;
	model: string;
	previousContent?: string;
	/** New messages plus recent overlap with the previous summary, oldest first. */
	transcript: TranscriptEntry[];
}

function skipped(reason: string): SummarySkipped {
	return { _tag: "Skipped", reason };
}

/** A conversation's current summary, and the last message it covers. */
const loadConversationSummary = Effect.fn("Summaries.loadConversationSummary")(function* (
	db: Executor,
	conversationId: string,
) {
	const [row] = yield* db
		.select({
			content: conversationSummary.content,
			sourceMessageId: conversationSummary.sourceMessageId,
		})
		.from(conversationSummary)
		.where(eq(conversationSummary.conversationId, conversationId))
		.limit(1);
	return row;
});

/** What the conversation holding a conversation's summaries is called. */
function summariesTitle(conversationTitle: string): string {
	return `Summaries of ${conversationTitle}`;
}

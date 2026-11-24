export * as ChatStore from "./store.ts";

import {
	type AutomationTriggerAuthor,
	type ChatKind,
	MAX_REACTION_EMOJI_PER_MESSAGE,
	type Message,
	type MessageReaction,
	type SystemBotKey,
	type WrittenFilePart,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, isNull, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction, writtenRow } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import {
	automationFeed,
	automationRun,
	bot,
	chat,
	chatParticipant,
	message,
	messageReaction,
	placedChat,
	project,
	projectChat,
	readCursor,
	systemChat,
} from "../../database/schema.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import type { UserFacing } from "../../user-message.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatEvent } from "../events.ts";
import type { StoredMessagePart } from "../sql.ts";
import { loadFileParts, toFilePart } from "./file-parts.ts";
import {
	authorRow,
	automationResultOf,
	type MemberIdentity,
	memberAuthor,
	memberColumns,
	quotedMessageColumns,
	reactionColumns,
	toMember,
	toMessage,
	toReactions,
	toReplyTo,
	withReplyTo,
} from "./participants.ts";

/**
 * The only writer of `chat` and of each kind's own table, except a run's,
 * which its store writes in the same transaction as the chat; of `chat_participant` and
 * `read_cursor`; and of the messages posted into chats. A
 * turn's reply is the exception: it is `TurnStore`'s while the turn
 * writes it.
 *
 * Commands take the ids and facts they write, and return rows. Whether
 * somebody may ask for any of this is decided by the caller.
 */
export interface Interface {
	/**
	 * Starts a chat in the project, called `title`, with `startedById` and the
	 * project's lead bot in it, and announces it. In a bot's default project
	 * the lead bot is that bot.
	 */
	readonly startChat: (placement: NewChat) => Effect.Effect<schema.PlacedChatRow>;
	/**
	 * Starts a chat in the bot's default project `projectId` for the member
	 * `startedById`, with them and the bot in it. Its first message is `brief`,
	 * written by the bot `briefingBotId`, which may be the chat's own bot;
	 * announced so the chat's bot takes its turn on the brief. Dies on a
	 * project members made, which has no bot of its own to brief.
	 */
	readonly startBriefedChat: (
		input: NewChat & { briefingBotId: string; brief: string },
	) => Effect.Effect<schema.PlacedChatRow>;
	/**
	 * Marks the project's chat `chat` resolved, or reopens it, and announces it
	 * when that changed it. Only a project's chat is ever resolved, so any
	 * other chat is left as it is.
	 */
	readonly setResolved: (
		chat: Pick<schema.PlacedChatRow, "id" | "workspaceId">,
		resolved: boolean,
	) => Effect.Effect<void>;
	/** Renames the project's chat `chat` to `title`, and announces it. Any other chat is left as it is. */
	readonly renameChat: (
		chat: Pick<schema.PlacedChatRow, "id" | "workspaceId">,
		title: string,
	) => Effect.Effect<void>;
	/**
	 * The automation's feed, where each of its runs posts, created on first use
	 * with its project's lead bot in it.
	 */
	readonly openAutomationFeed: (
		owned: Pick<schema.AutomationRow, "id" | "workspaceId" | "name">,
		leadBotId: string,
	) => Effect.Effect<schema.PlacedChatRow>;
	/**
	 * Posts a member's message with the files they attach, making them a
	 * participant, and announces it. Posting a message again with the same
	 * `id` returns the one already posted, unchanged and unannounced; an `id`
	 * already used by a different message, or the same text with other files,
	 * fails, and so does quoting a message that is not in the chat.
	 * Fails with `UnsentAttachmentsNotFound`, posting nothing, when an attachment is not
	 * one of the author's unsent uploads in the chat.
	 */
	readonly post: (input: {
		/** The id the member's client chose, which makes sending it again safe to detect. */
		id: string;
		chatId: string;
		author: MemberIdentity;
		/** May be empty when the message carries files. */
		content: string;
		/** Ids of the author's uploads to attach. */
		attachments: readonly string[];
		/** The id of the message in the chat that this one quotes and answers. */
		replyTo?: string;
	}) => Effect.Effect<
		Posted | AlreadyPosted,
		MessageIdConflict | ReplyTargetNotFound | ChatFileStore.UnsentAttachmentsNotFound
	>;
	/** Brings bots into the chat, announcing the ones who were not there yet. */
	readonly addBots: (chatId: string, botIds: readonly string[]) => Effect.Effect<void>;
	/**
	 * Opens an automation run's chat, with the bot in it. The caller
	 * writes its `run` row in the same transaction.
	 */
	readonly openRun: (input: {
		workspaceId: string;
		botId: string;
		title: string;
	}) => Effect.Effect<schema.ChatRow>;
	/** Posts what started an automation run into its chat, as the run's first message. */
	readonly postAutomationTrigger: (input: {
		chatId: string;
		trigger: AutomationTriggerAuthor;
		content: string;
	}) => Effect.Effect<schema.MessageRow>;
	/**
	 * Posts an automation run's result into the automation's feed, from the
	 * run's bot and linked to the run, which it opens, and announces it. A run
	 * has one result: posting a second fails.
	 */
	readonly postRunResult: (input: {
		run: RunPosting;
		result: RunResult;
	}) => Effect.Effect<schema.MessageRow>;
	/**
	 * The chat the system bot `systemBotKey` works in on `served`,
	 * with `systemBotId`: one per system bot per chat, created on
	 * first use.
	 */
	readonly openSystemChat: (input: {
		served: Pick<schema.PlacedChatRow, "id" | "workspaceId">;
		systemBotId: string;
		systemBotKey: SystemBotKey;
		title: string;
	}) => Effect.Effect<string>;
	/**
	 * Records that `memberId` has read the chat `chatId` up to
	 * its newest finished message, and tells its watchers when that moved
	 * them on. Never moves past a reply still being written, which is not yet
	 * read, so it is news once it is done, however much was written after it
	 * began. Never moves anyone back.
	 */
	readonly markRead: (memberId: string, chatId: string) => Effect.Effect<void>;
	/**
	 * Records that `memberId` has read an automation run as a nested chat, by
	 * its own chat `nestedChatId`: that chat up to when the run began, or up
	 * to when it ended once it has. The chat it is listed in, and what was
	 * written in the run's chat since, stay as they were. Tells the run
	 * chat's watchers when that moved them on. Never moves anyone back, and
	 * does nothing for any other chat.
	 */
	readonly markNestedChatRead: (memberId: string, nestedChatId: string) => Effect.Effect<void>;
	/**
	 * Adds the member's reaction to a finished message, and announces what the
	 * message has now. A reaction already there changes nothing and is not
	 * announced. A new emoji past `MAX_REACTION_EMOJI_PER_MESSAGE` fails.
	 */
	readonly addReaction: (
		reaction: Reaction,
	) => Effect.Effect<MessageReaction[], MessageNotFinished | TooManyReactionEmoji>;
	/** Takes the member's reaction back, announcing it as `addReaction` does, if it was there. */
	readonly removeReaction: (reaction: Reaction) => Effect.Effect<MessageReaction[]>;
}

/** What of an automation run its posted result names. */
type RunPosting = Pick<
	schema.RunRow,
	"id" | "chatId" | "botId" | "automationId" | "automationName"
>;

/**
 * What an automation run's result says: its bot's last reply, and the files
 * the run wrote, which the calls that wrote them show only in the run's
 * chat.
 */
interface RunResult {
	readonly content: string;
	readonly files: readonly WrittenFilePart[];
}

/** One member's emoji on a message in a chat. */
export interface Reaction {
	readonly chatId: string;
	readonly messageId: string;
	readonly memberId: string;
	readonly emoji: string;
}

/** A new chat in the project `projectId`. */
export interface NewChat {
	workspaceId: string;
	projectId: string;
	startedById: string;
	title: string;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ChatStore") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChatStore");
	const { emit } = yield* ChatEvents.Service;
	const files = yield* ChatFileStore.Service;

	/** Writes the shared row of a new chat; its kind's row is written beside it. */
	const insertChat = (row: { workspaceId: string; kind: ChatKind; title: string }) =>
		query((db) => db.insert(chat).values(row).returning()).pipe(Effect.flatMap(writtenRow("chat")));

	/**
	 * Takes back a chat whose kind row lost a race to one already
	 * there, such as a second feed for one automation, so it is never left
	 * without one.
	 */
	const discardChat = (id: string) => query((db) => db.delete(chat).where(eq(chat.id, id)));

	const placedById = (id: string) =>
		query((db) => db.select().from(placedChat).where(eq(placedChat.id, id)).limit(1)).pipe(
			Effect.flatMap(writtenRow("chat")),
		);

	/** What the message has now, announced when `changed`. */
	const reactionsAfter = (reaction: Reaction, changed: boolean) =>
		Effect.gen(function* () {
			const rows = yield* query((db) =>
				db.query.messageReaction.findMany({
					where: { messageId: reaction.messageId },
					...reactionColumns,
				}),
			);
			const reactions = toReactions(rows);
			if (changed) {
				yield* emit([
					ChatEvent.ReactionsChanged({
						chatId: reaction.chatId,
						messageId: reaction.messageId,
						reactions,
					}),
				]);
			}
			return reactions;
		});

	/**
	 * Posts the run's `result` into `chatId` from the run's bot, and
	 * announces it as the run's result, which opens the run.
	 */
	const postFromRunBot = (input: { chatId: string; run: RunPosting; result: RunResult }) =>
		Effect.gen(function* () {
			const [author] = yield* query((db) =>
				db
					.select({
						id: bot.id,
						name: bot.name,
						handle: bot.handle,
						color: bot.color,
						eyes: bot.eyes,
						shape: bot.shape,
					})
					.from(bot)
					.where(eq(bot.id, input.run.botId))
					.limit(1),
			);
			if (!author) return yield* Effect.die(new Error("An automation run's bot is gone"));
			const created = yield* insertTextMessage(
				{
					chatId: input.chatId,
					authorBotId: input.run.botId,
					runId: input.run.id,
					content: input.result.content,
				},
				input.result.files,
			);
			const placed = yield* touchChat(input.chatId);
			yield* emit([
				ChatEvent.MessagePosted({
					chatId: input.chatId,
					workspaceId: placed.workspaceId,
					message: {
						...toMessage(created, authorRow(null, author)),
						automationResultOf: automationResultOf(input.run),
					},
				}),
			]);
			return created;
		});

	/**
	 * Moves how far `memberId` has read `chatId` on to `at`, a timestamp
	 * as text, and tells the chat's watchers. Never moves anyone back.
	 */
	const readThrough = Effect.fn("ChatStore.readThrough")(function* (
		memberId: string,
		chatId: string,
		at: string,
	) {
		const through = sql`${at}::timestamptz`;
		const [moved] = yield* query((db) =>
			db
				.insert(readCursor)
				.values({ memberId, chatId, readThrough: through })
				.onConflictDoUpdate({
					target: [readCursor.memberId, readCursor.chatId],
					set: { readThrough: through },
					setWhere: lt(readCursor.readThrough, through),
				})
				.returning({
					readThrough: readCursor.readThrough,
					readAt: readCursor.updatedAt,
				}),
		);
		if (!moved) return;
		const reader = yield* query((db) =>
			db.query.member.findFirst({ where: { id: memberId }, ...memberColumns }),
		);
		if (!reader) return;
		yield* emit([
			ChatEvent.ChatRead({
				chatId,
				member: toMember(reader),
				readThrough: moved.readThrough,
				readAt: moved.readAt,
			}),
		]);
	});

	/**
	 * Starts a project's chat, with the member who started it in it, and the
	 * project's lead bot, which answers it by default: in a bot's default
	 * project, the bot.
	 */
	const insertProjectChat = (input: NewChat) =>
		Effect.gen(function* () {
			const created = yield* insertChat({
				workspaceId: input.workspaceId,
				kind: "project_chat",
				title: input.title,
			});
			yield* query((db) =>
				db.insert(projectChat).values({
					chatId: created.id,
					workspaceId: input.workspaceId,
					projectId: input.projectId,
					startedById: input.startedById,
				}),
			);
			const [led] = yield* query((db) =>
				db
					.select({ leadBotId: project.leadBotId })
					.from(project)
					.where(eq(project.id, input.projectId))
					.limit(1),
			);
			if (!led) return yield* Effect.die(new Error("The chat's project no longer exists"));
			yield* query((db) =>
				db.insert(chatParticipant).values([
					{ chatId: created.id, memberId: input.startedById },
					{ chatId: created.id, botId: led.leadBotId },
				]),
			);
			return yield* placedById(created.id);
		});

	/** The feed of the automation `automationId`, if it has been opened. */
	const feedOf = (automationId: string) =>
		query((db) =>
			db
				.select({ chatId: automationFeed.chatId })
				.from(automationFeed)
				.where(eq(automationFeed.automationId, automationId))
				.limit(1),
		).pipe(Effect.map(([found]) => found?.chatId));

	/** The chat `systemBotKey` works in on `servedChatId`, if it has been opened. */
	const systemChatOf = (servedChatId: string, systemBotKey: SystemBotKey) =>
		query((db) =>
			db
				.select({ chatId: systemChat.chatId })
				.from(systemChat)
				.where(
					and(eq(systemChat.servedChatId, servedChatId), eq(systemChat.systemBotKey, systemBotKey)),
				)
				.limit(1),
		).pipe(Effect.map(([found]) => found?.chatId));

	return Service.of({
		startChat: (input) =>
			operation(
				"startChat",
				transaction(
					Effect.gen(function* () {
						const created = yield* insertProjectChat(input);
						yield* emit([
							ChatEvent.ChatStarted({
								workspaceId: created.workspaceId,
								chatId: created.id,
							}),
						]);
						return created;
					}),
				),
			),

		startBriefedChat: (input) =>
			operation(
				"startBriefedChat",
				transaction(
					Effect.gen(function* () {
						// One bot per chat: the briefing bot writes the first message without joining.
						const created = yield* insertProjectChat(input);
						const briefedBotId = created.botId;
						if (!briefedBotId) {
							return yield* Effect.die(
								new Error(`Project ${input.projectId} is not a bot's default project`),
							);
						}
						const brief = yield* insertTextMessage({
							chatId: created.id,
							authorBotId: input.briefingBotId,
							content: input.brief,
						});
						yield* emit([
							ChatEvent.BriefedChatStarted({
								workspaceId: created.workspaceId,
								chatId: created.id,
								briefedBotId,
								briefMessageId: brief.id,
							}),
						]);
						return created;
					}),
				),
			),

		setResolved: (marked, resolved) =>
			operation(
				"setResolved",
				transaction(
					Effect.gen(function* () {
						const changed = yield* query((db) =>
							db
								.update(projectChat)
								.set({ resolvedAt: resolved ? sql`now()` : null })
								.where(
									and(
										eq(projectChat.chatId, marked.id),
										resolved
											? isNull(projectChat.resolvedAt)
											: sql`${projectChat.resolvedAt} is not null`,
									),
								)
								.returning({ id: projectChat.chatId }),
						);
						if (changed.length === 0) return;
						yield* emit([
							ChatEvent.ChatResolvedChanged({
								workspaceId: marked.workspaceId,
								chatId: marked.id,
							}),
						]);
					}),
				),
			),

		renameChat: (renaming, title) =>
			operation(
				"renameChat",
				transaction(
					Effect.gen(function* () {
						const changed = yield* query((db) =>
							db
								.update(chat)
								.set({ title })
								.where(
									and(
										eq(chat.id, renaming.id),
										sql`exists (${db
											.select({ one: sql`1` })
											.from(projectChat)
											.where(eq(projectChat.chatId, renaming.id))})`,
									),
								)
								.returning({ id: chat.id }),
						);
						if (changed.length === 0) return;
						yield* emit([
							ChatEvent.ProjectChatChanged({
								workspaceId: renaming.workspaceId,
								chatId: renaming.id,
							}),
						]);
					}),
				),
			),

		post: (input) =>
			operation(
				"post",
				transaction(
					Effect.gen(function* () {
						// Two sends of one message wait here for each other, so the second
						// finds the first rather than failing on its primary key.
						yield* lockMessageId(input.id);
						const [existing] = yield* query((db) =>
							db.select().from(message).where(eq(message.id, input.id)).limit(1),
						);
						const author = memberAuthor(input.author);
						if (existing) {
							const attached =
								(yield* query((db) => loadFileParts(db, [existing.id]))).get(existing.id) ?? [];
							if (
								existing.chatId !== input.chatId ||
								existing.authorMemberId !== input.author.id ||
								existing.content !== input.content ||
								(existing.replyToMessageId ?? undefined) !== input.replyTo ||
								!sameIds(
									attached.map(({ id }) => id),
									input.attachments,
								)
							) {
								return yield* new MessageIdConflict();
							}
							const replyTo = yield* quotedIn(existing.chatId, existing.replyToMessageId);
							return {
								_tag: "AlreadyPosted",
								message: withReplyTo(toMessage(existing, author, { files: attached }), replyTo),
							} as const;
						}
						const replyTo = yield* quotedIn(input.chatId, input.replyTo);
						if (input.replyTo && !replyTo) return yield* new ReplyTargetNotFound();
						const created = yield* insertTextMessage({
							id: input.id,
							chatId: input.chatId,
							authorMemberId: input.author.id,
							content: input.content,
							replyToMessageId: input.replyTo,
						});
						const placed = yield* touchChat(input.chatId);
						yield* query((db) =>
							db
								.insert(chatParticipant)
								.values({ chatId: input.chatId, memberId: input.author.id })
								.onConflictDoNothing(),
						);
						const attached =
							input.attachments.length === 0
								? []
								: (yield* files.attach({
										chatId: input.chatId,
										messageId: created.id,
										uploaderId: input.author.id,
										fileIds: input.attachments,
									})).map(toFilePart);
						const posted = withReplyTo(toMessage(created, author, { files: attached }), replyTo);
						yield* emit([
							ChatEvent.MessagePosted({
								chatId: input.chatId,
								workspaceId: placed.workspaceId,
								message: posted,
							}),
						]);
						return { _tag: "Posted", message: posted } as const;
					}),
				),
			),

		addBots: (chatId, botIds) =>
			operation(
				"addBots",
				transaction(
					Effect.gen(function* () {
						if (botIds.length === 0) return;
						const inserted = yield* query((db) =>
							db
								.insert(chatParticipant)
								.values(botIds.map((botId) => ({ chatId, botId })))
								.onConflictDoNothing()
								.returning({ botId: chatParticipant.botId }),
						);
						const joined = new Set(inserted.map((row) => row.botId));
						if (joined.size === 0) return;
						yield* emit([
							ChatEvent.BotsJoined({
								chatId,
								botIds: botIds.filter((botId) => joined.has(botId)),
							}),
						]);
					}),
				),
			),

		openRun: (input) =>
			operation(
				"openRun",
				transaction(
					Effect.gen(function* () {
						const created = yield* insertChat({
							workspaceId: input.workspaceId,
							kind: "run",
							title: input.title,
						});
						yield* query((db) =>
							db.insert(chatParticipant).values({ chatId: created.id, botId: input.botId }),
						);
						return created;
					}),
				),
			),

		postAutomationTrigger: (input) =>
			operation(
				"postAutomationTrigger",
				insertTextMessage({
					chatId: input.chatId,
					automationTrigger: input.trigger,
					content: input.content,
				}),
			),

		openAutomationFeed: (owned, leadBotId) =>
			operation(
				"openAutomationFeed",
				transaction(
					Effect.gen(function* () {
						const existing = yield* feedOf(owned.id);
						if (existing) return yield* placedById(existing);
						const created = yield* insertChat({
							workspaceId: owned.workspaceId,
							kind: "automation_feed",
							title: owned.name,
						});
						const [opened] = yield* query((db) =>
							db
								.insert(automationFeed)
								.values({
									chatId: created.id,
									workspaceId: owned.workspaceId,
									automationId: owned.id,
								})
								.onConflictDoNothing({ target: automationFeed.automationId })
								.returning({ chatId: automationFeed.chatId }),
						);
						if (opened) {
							yield* query((db) =>
								db.insert(chatParticipant).values({ chatId: created.id, botId: leadBotId }),
							);
							return yield* placedById(created.id);
						}
						yield* discardChat(created.id);
						const raced = yield* feedOf(owned.id);
						if (!raced) return yield* Effect.die(new Error("The automation's feed was not opened"));
						return yield* placedById(raced);
					}),
				),
			),

		postRunResult: ({ run, result }) =>
			operation(
				"postRunResult",
				transaction(
					Effect.gen(function* () {
						const feed = yield* feedOf(run.automationId);
						if (!feed) {
							return yield* Effect.die(new Error("An automation run's automation has no feed"));
						}
						return yield* postFromRunBot({ chatId: feed, run, result });
					}),
				),
			),

		openSystemChat: (input) =>
			operation(
				"openSystemChat",
				transaction(
					Effect.gen(function* () {
						const existing = yield* systemChatOf(input.served.id, input.systemBotKey);
						if (existing) return existing;
						const created = yield* insertChat({
							workspaceId: input.served.workspaceId,
							kind: "system_chat",
							title: input.title,
						});
						const [opened] = yield* query((db) =>
							db
								.insert(systemChat)
								.values({
									chatId: created.id,
									workspaceId: input.served.workspaceId,
									botId: input.systemBotId,
									systemBotKey: input.systemBotKey,
									servedChatId: input.served.id,
								})
								.onConflictDoNothing({
									target: [systemChat.servedChatId, systemChat.systemBotKey],
								})
								.returning({ chatId: systemChat.chatId }),
						);
						if (opened) return opened.chatId;
						yield* discardChat(created.id);
						const raced = yield* systemChatOf(input.served.id, input.systemBotKey);
						if (!raced) {
							return yield* Effect.die(new Error("Opening a system bot's chat returned none"));
						}
						return raced;
					}),
				),
			),

		markRead: (memberId, chatId) =>
			operation(
				"markRead",
				transaction(
					Effect.gen(function* () {
						// The newest item's own time rather than this server's clock, so
						// one stamped later is never counted as read. As text, which
						// keeps the microseconds a `Date` would drop.
						const [newest] = yield* query((db) => {
							const writing = alias(message, "writing_message");
							const oldestStreaming = db
								// Through `sql`, because `min` of a timestamp column is cast to text for reading.
								.select({ at: sql`min(${writing.createdAt})` })
								.from(writing)
								.where(and(eq(writing.chatId, chatId), eq(writing.status, "writing")));
							// An automation's feed lists its runs among its messages, so reading it reads
							// them too: through when the newest ended, or began while it still runs.
							const newestRun = db
								.select({
									at: sql`max(coalesce(${automationRun.finishedAt}, ${automationRun.acceptedAt}))`,
								})
								.from(automationRun)
								.innerJoin(
									automationFeed,
									eq(automationFeed.automationId, automationRun.automationId),
								)
								.where(eq(automationFeed.chatId, chatId));
							return db
								.select({
									at: sql<string | null>`greatest(max(${message.createdAt}), (${newestRun}))::text`,
								})
								.from(message)
								.where(
									and(
										eq(message.chatId, chatId),
										ne(message.status, "writing"),
										sql`${message.createdAt} < coalesce((${oldestStreaming}), 'infinity')`,
									),
								);
						});
						if (!newest?.at) return;
						yield* readThrough(memberId, chatId, newest.at);
					}),
				),
			),

		markNestedChatRead: (memberId, nestedChatId) =>
			operation(
				"markNestedChatRead",
				transaction(
					Effect.gen(function* () {
						// Through when a run ended, so one opened while it ran is news
						// again once it ends. As text, which keeps the microseconds a
						// `Date` would drop.
						const [readUpTo] = yield* query((db) =>
							db
								.select({
									at: sql<
										string | null
									>`coalesce(${automationRun.finishedAt}, ${automationRun.acceptedAt})::text`,
								})
								.from(automationRun)
								.where(eq(automationRun.chatId, nestedChatId))
								.limit(1),
						);
						if (!readUpTo?.at) return;
						yield* readThrough(memberId, nestedChatId, readUpTo.at);
					}),
				),
			),

		addReaction: (reaction) =>
			operation(
				"addReaction",
				transaction(
					Effect.gen(function* () {
						// Locked, so two members adding new emoji at once cannot both pass the limit.
						const [target] = yield* query((db) =>
							db
								.select({ status: message.status })
								.from(message)
								.where(and(eq(message.id, reaction.messageId), eq(message.chatId, reaction.chatId)))
								.for("update"),
						);
						if (target?.status !== "complete") return yield* new MessageNotFinished();
						const used = yield* query((db) =>
							db
								.selectDistinct({ emoji: messageReaction.emoji })
								.from(messageReaction)
								.where(eq(messageReaction.messageId, reaction.messageId)),
						);
						const isNewEmoji = !used.some((row) => row.emoji === reaction.emoji);
						if (isNewEmoji && used.length >= MAX_REACTION_EMOJI_PER_MESSAGE) {
							return yield* new TooManyReactionEmoji();
						}
						const added = yield* query((db) =>
							db
								.insert(messageReaction)
								.values({
									messageId: reaction.messageId,
									memberId: reaction.memberId,
									emoji: reaction.emoji,
								})
								.onConflictDoNothing()
								.returning({ id: messageReaction.id }),
						);
						return yield* reactionsAfter(reaction, added.length > 0);
					}),
				),
			),

		removeReaction: (reaction) =>
			operation(
				"removeReaction",
				transaction(
					Effect.gen(function* () {
						const removed = yield* query((db) =>
							db
								.delete(messageReaction)
								.where(
									and(
										eq(messageReaction.messageId, reaction.messageId),
										eq(messageReaction.memberId, reaction.memberId),
										eq(messageReaction.emoji, reaction.emoji),
									),
								)
								.returning({ id: messageReaction.id }),
						);
						return yield* reactionsAfter(reaction, removed.length > 0);
					}),
				),
			),
	});
});

/** Posting a message ends its files' wait to be sent, so this provides `ChatFileStore`. */
export const layer = Layer.effect(Service, make).pipe(Layer.provide(ChatFileStore.layer));

/** A message posted now, and announced. */
export interface Posted {
	readonly _tag: "Posted";
	readonly message: Message;
}

/** A message posted before with the same id, content and files, returned as it was. */
export interface AlreadyPosted {
	readonly _tag: "AlreadyPosted";
	readonly message: Message;
}

/**
 * Holds the message id `messageId` until the transaction ends, so two sends
 * of one message, which may start what it is posted in, run one at a time.
 */
export const lockMessageId = (messageId: string) =>
	query((db) =>
		db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`message:${messageId}`}, 0))`),
	);

/** The message `messageId` in `chatId`, as a reply quotes it, or nothing when it is not there. */
/**
 * Writes a finished message of `content`, its parts being that text, unless
 * it is empty, and then `moreParts`.
 */
const insertTextMessage = (
	values: Omit<typeof message.$inferInsert, "status" | "parts" | "content"> & { content: string },
	moreParts: readonly StoredMessagePart[] = [],
) =>
	query((db) =>
		db
			.insert(message)
			.values({
				...values,
				status: "complete",
				parts: [
					...(values.content === "" ? [] : [{ type: "text" as const, text: values.content }]),
					...moreParts,
				],
			})
			.returning(),
	).pipe(Effect.flatMap(writtenRow("message")));

/** Marks the chat `chatId` as changed now, returning its workspace. */
const touchChat = (chatId: string) =>
	Effect.flatMap(DateTime.nowAsDate, (now) =>
		query((db) =>
			db
				.update(chat)
				.set({ updatedAt: now })
				.where(eq(chat.id, chatId))
				.returning({ workspaceId: chat.workspaceId }),
		).pipe(Effect.flatMap(writtenRow("chat"))),
	);

const quotedIn = (chatId: string, messageId: string | null | undefined) =>
	messageId
		? query((db) =>
				db.query.message.findFirst({
					where: { id: messageId, chatId },
					...quotedMessageColumns,
				}),
			).pipe(Effect.map((quoted) => (quoted ? toReplyTo(quoted) : undefined)))
		: Effect.succeed(undefined);

export class MessageNotFinished
	extends Data.TaggedError("MessageNotFinished")
	implements UserFacing
{
	override get message() {
		return "A reaction was added to a message that is not finished";
	}
	get userMessage() {
		return userText`You can react once the message is finished`;
	}
}

export class TooManyReactionEmoji
	extends Data.TaggedError("TooManyReactionEmoji")
	implements UserFacing
{
	override get message() {
		return "A message already has as many different reaction emoji as it can";
	}
	get userMessage() {
		return userText`This message has as many different reactions as it can take. React with one already on it`;
	}
}

export class ReplyTargetNotFound
	extends Data.TaggedError("ReplyTargetNotFound")
	implements UserFacing
{
	override get message() {
		return "A reply quoted a message that is not in its chat";
	}
	get userMessage() {
		return userText`The message you replied to isn't in this chat`;
	}
}

/** Whether two lists hold the same ids, in any order. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
	const wanted = new Set(right);
	return left.length === wanted.size && left.every((id) => wanted.has(id));
}

export class MessageIdConflict extends Data.TaggedError("MessageIdConflict") implements UserFacing {
	override get message() {
		return "A message id was reused for a different message";
	}
	get userMessage() {
		return userText`That message ID is already used by a different message`;
	}
}

import { randomUUID } from "node:crypto";
import type { ConnectorTool, JsonValue, WrittenFileKind } from "@sugabots/contracts";
import { CONNECTOR_TOOL_SEPARATOR, FILE_WRITE_TOOL } from "@sugabots/contracts";
import { askerColumns } from "@sugabots/core/authentication/turn-facts";
import { reachesChatFor } from "@sugabots/core/authorization/access";
import { chatTitleFrom } from "@sugabots/core/chats/chats/chat-title";
import { seedChat } from "@sugabots/core/chats/seed.test-support";
import { query } from "@sugabots/core/database/database";
import {
	automation,
	automationFeed,
	automationRun,
	bot,
	chat,
	chatParticipant,
	connector,
	file,
	fileVersion,
	membership,
	message,
	messageReaction,
	type PlacedChatRow,
	placedChat,
	projectBot,
	projectChat,
	readCursor,
	type StoredMessagePart,
	toolCall,
	turn,
} from "@sugabots/core/database/schema";
import { Files } from "@sugabots/core/files/files";
import type { ToolAccess } from "@sugabots/core/providers/sql";
import { defaultProjectIdOf } from "@sugabots/core/workspaces/bots/bot";
import type { UserText } from "@sugabots/errors";
import { and, eq, getColumns, isNull, max, sql } from "drizzle-orm";
import { Effect } from "effect";

/**
 * The showcase's chats, written straight into the tables the app reads
 * them from, so the screenshots need no model, no second sign-in and no waiting.
 * Nothing is announced: the app shows them when it next loads.
 *
 * Each project's chat and bot's chat gets only the scripted messages it does not have
 * yet, matched by their text, so a scene added later reaches a showcase seeded
 * before it. An automation that already has a run at a scheduled time keeps it.
 */

/** Who the chats name, by the keys `seed.ts` gives them. */
interface Cast<Member extends string> {
	workspaceId: string;
	members: Record<Member, string>;
	/** By the seed's key for each project. */
	projectIds: Record<string, string>;
	/** By name. */
	botIds: ReadonlyMap<string, string>;
	/** By bot name: the model each is on, which their turns record. */
	botModels: ReadonlyMap<string, string>;
}

/**
 * A time of day on the day the chats happen, or on the weekday or
 * Monday before it.
 */
interface Clock {
	time: `${number}:${number}`;
	day?: "previous weekday" | "previous monday";
}

type Speaker<Member extends string> = { member: Member } | { bot: string };

type ScriptedPart<Member extends string> =
	| { text: string }
	| {
			toolCall: {
				/** The bot's connector it went through; without one, a tool built into every bot. */
				connector?: string;
				tool: string;
				input: JsonValue;
				/** What the call returned, once it has run. */
				output?: JsonValue;
				/** A call that only reads, so it ran without anyone being asked. */
				readOnly?: boolean;
				/** Who allowed it, and when; without it (and not `readOnly`), the call is still waiting for someone to. */
				allowed?: { by: Member; at: Clock };
			};
	  }
	| { file: { kind: WrittenFileKind; title: string; content: string } };

interface ScriptedMessage<Member extends string> {
	/** How a later message quotes this one. */
	key?: string;
	at: Clock;
	from: Speaker<Member>;
	parts: readonly ScriptedPart<Member>[];
	replyTo?: string;
	reactions?: readonly { emoji: string; by: readonly Member[] }[];
}

/**
 * A bot's chat: somebody's chat with that one bot. The first message
 * is theirs, and names the chat as the app would.
 */
export interface BotChatScene<Member extends string> {
	bot: string;
	messages: readonly [
		ScriptedMessage<Member> & { from: { member: Member } },
		...ScriptedMessage<Member>[],
	];
}

/**
 * What was said in one of a project's chats: its members, and the project's
 * bots answering when they are mentioned. The first message is a member's, who
 * started the chat.
 */
export interface ProjectChatScene<Member extends string> {
	project: string;
	/** What the chat is called. */
	chat: string;
	messages: readonly [
		ScriptedMessage<Member> & { from: { member: Member } },
		...ScriptedMessage<Member>[],
	];
}

/** Support's chat, where the seed writes the morning's handover and the demo's story starts (see `stage.ts`). */
export const SUPPORT_HANDOVER_CHAT = "Today's tickets";

/** One past run of a bot's automation, which posts its result in the automation's feed. */
export interface AutomationRun {
	bot: string;
	automation: string;
	scheduledAt: Clock;
	finishedAt: Clock;
	/** What the run posted; with `failed`, what it got as far as saying. */
	result: string;
	/** Why the run failed, as its members are told; without it, the run finished. */
	failed?: UserText;
}

/** A connector every bot in a project has, with the tools its server lists and what they may do with each. */
export interface SeedConnector {
	project: string;
	name: string;
	handle: string;
	url: string;
	tools: readonly ConnectorTool[];
	toolAccess: ToolAccess;
}

/**
 * The day the chats happen: the latest weekday whose morning is over,
 * so none of them is in the future and the weekday automations ran on it.
 */
function chatDay(now: Date): Date {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	if (now.getHours() < LATEST_SCRIPTED_HOUR) day.setDate(day.getDate() - 1);
	while (isWeekend(day)) day.setDate(day.getDate() - 1);
	return day;
}

/** Every scripted time is before noon. */
const LATEST_SCRIPTED_HOUR = 12;

function timeOn(day: Date, clock: Clock): Date {
	const [hours = 0, minutes = 0] = clock.time.split(":").map(Number);
	const at = new Date(day);
	if (clock.day) {
		const wanted = (date: Date) =>
			clock.day === "previous monday" ? date.getDay() === MONDAY : !isWeekend(date);
		do at.setDate(at.getDate() - 1);
		while (!wanted(at));
	}
	at.setHours(hours, minutes, 0, 0);
	return at;
}

const MONDAY = 1;

function isWeekend(date: Date): boolean {
	return date.getDay() === 0 || date.getDay() === 6;
}

export const ensureConnectors = (input: {
	workspaceId: string;
	projectIds: Record<string, string>;
	createdById: string;
	connectors: readonly SeedConnector[];
}) =>
	Effect.forEach(
		input.connectors,
		// Each bot in the seed's project has its own connector to it, in its default project.
		(seed) =>
			query((db) =>
				db
					.insert(connector)
					.select(
						db
							.select({
								workspaceId: bot.workspaceId,
								projectId: defaultProjectIdOf(bot.id).as("project_id"),
								name: sql<string>`${seed.name}`.as("name"),
								handle: sql<string>`${seed.handle}`.as("handle"),
								url: sql<string>`${seed.url}`.as("url"),
								authKind: sql<"oauth">`'oauth'`.as("auth_kind"),
								tools: sql<ConnectorTool[]>`${JSON.stringify(seed.tools)}::jsonb`.as("tools"),
								toolAccess: sql<ToolAccess>`${JSON.stringify(seed.toolAccess)}::jsonb`.as(
									"tool_access",
								),
								createdById: sql<string>`${input.createdById}::uuid`.as("created_by_id"),
							})
							.from(bot)
							.innerJoin(projectBot, eq(projectBot.botId, bot.id))
							.where(
								and(
									eq(bot.workspaceId, input.workspaceId),
									eq(projectBot.projectId, projectIdOf(input.projectIds, seed.project)),
								),
							),
					)
					.onConflictDoNothing(),
			),
		{ discard: true },
	);

export const ensureChats = <Member extends string>(
	cast: Cast<Member>,
	written: {
		projectChats: readonly ProjectChatScene<Member>[];
		botChats: readonly BotChatScene<Member>[];
		runs: readonly AutomationRun[];
	},
) =>
	Effect.gen(function* () {
		const day = chatDay(new Date());
		let count = 0;
		for (const run of written.runs) {
			if (yield* writeAutomationRun(cast, day, run)) count += 1;
		}
		for (const scene of written.projectChats) {
			const found = yield* projectChatOf(cast, day, scene);
			if (yield* writeScene(cast, day, found, scene.messages)) count += 1;
		}
		for (const scene of written.botChats) {
			const found = yield* botChatOf(cast, day, scene);
			if (yield* writeScene(cast, day, found, scene.messages)) count += 1;
		}
		yield* markEverythingRead(cast);
		return count;
	});

/**
 * The bot's chat `scene` tells, made if it is not there yet: one with its bot and
 * the title its first message gives it.
 */
const botChatOf = <Member extends string>(
	cast: Cast<Member>,
	day: Date,
	scene: BotChatScene<Member>,
) =>
	Effect.gen(function* () {
		const botId = idOf(cast.botIds, scene.bot);
		const [first] = scene.messages;
		const title = chatTitleFrom(textOf(first.parts));
		const [existing] = yield* query((db) =>
			db
				.select({ chat: getColumns(placedChat) })
				.from(placedChat)
				.where(
					and(
						eq(placedChat.kind, "project_chat"),
						eq(placedChat.botId, botId),
						eq(placedChat.title, title),
					),
				),
		);
		if (existing) return existing.chat;
		const startedById = cast.members[first.from.member];
		const at = timeOn(day, first.at);
		const { id } = yield* query((db) =>
			seedChat(db, {
				workspaceId: cast.workspaceId,
				kind: "project_chat",
				botId,
				startedById,
				title,
				createdAt: at,
			}),
		);
		yield* query((db) =>
			db.insert(chatParticipant).values([
				{ chatId: id, memberId: startedById, createdAt: at },
				{ chatId: id, botId, createdAt: at },
			]),
		);
		return yield* placedById(id);
	});

/**
 * The project's chat `scene` tells, made if it is not there yet: one in its
 * project, by its name, started by whoever wrote first in it, who
 * joins it with their first message.
 */
const projectChatOf = <Member extends string>(
	cast: Cast<Member>,
	day: Date,
	scene: ProjectChatScene<Member>,
) =>
	Effect.gen(function* () {
		const projectId = projectIdOf(cast.projectIds, scene.project);
		const [existing] = yield* query((db) =>
			db
				.select({ chat: getColumns(placedChat) })
				.from(projectChat)
				.innerJoin(placedChat, eq(placedChat.id, projectChat.chatId))
				.where(and(eq(projectChat.projectId, projectId), eq(placedChat.title, scene.chat))),
		);
		if (existing) return existing.chat;
		const [first] = scene.messages;
		const startedById = cast.members[first.from.member];
		const at = timeOn(day, first.at);
		const { id } = yield* query((db) =>
			seedChat(db, {
				workspaceId: cast.workspaceId,
				kind: "project_chat",
				projectId,
				startedById,
				title: scene.chat,
				createdAt: at,
			}),
		);
		return yield* placedById(id);
	});

/** An automation's feed, where each of its runs posts its result, made if it is not there yet. */
const automationFeedOf = (
	cast: Cast<string>,
	automationRow: { id: string; botId: string; name: string },
) =>
	Effect.gen(function* () {
		const [existing] = yield* query((db) =>
			db
				.select({ id: automationFeed.chatId })
				.from(automationFeed)
				.where(eq(automationFeed.automationId, automationRow.id)),
		);
		if (existing) return yield* placedById(existing.id);
		const { id } = yield* query((db) =>
			seedChat(db, {
				workspaceId: cast.workspaceId,
				kind: "automation_feed",
				automationId: automationRow.id,
				title: automationRow.name,
			}),
		);
		yield* query((db) =>
			db.insert(chatParticipant).values({ chatId: id, botId: automationRow.botId }),
		);
		return yield* placedById(id);
	});

/** Writes into a scene's chat the scene's messages it does not have yet. */
const writeScene = <Member extends string>(
	cast: Cast<Member>,
	day: Date,
	inChat: PlacedChatRow,
	messages: readonly ScriptedMessage<Member>[],
) =>
	Effect.gen(function* () {
		const wrote = yield* writeMessages(cast, day, { inChat, messages });
		if (wrote) yield* touch(inChat.id);
		return wrote;
	});

/**
 * Writes the scripted messages into the chat, each bot reply answering the
 * member's message before it, leaving out those it already has: a member's or a
 * bot's with the same words. Says whether it wrote any.
 */
const writeMessages = <Member extends string>(
	cast: Cast<Member>,
	day: Date,
	input: {
		inChat: PlacedChatRow;
		messages: readonly ScriptedMessage<Member>[];
	},
) =>
	Effect.gen(function* () {
		const chatId = input.inChat.id;
		const said = yield* query((db) =>
			db
				.select({
					id: message.id,
					content: message.content,
					authorMemberId: message.authorMemberId,
				})
				.from(message)
				.where(eq(message.chatId, chatId)),
		);
		const saidAlready = new Map(
			said.map((row) => [`${row.authorMemberId ? "member" : "bot"}:${row.content}`, row.id]),
		);
		const keyed = new Map<string, string>();
		let lastMemberMessage: string | undefined;
		let wrote = false;
		for (const scripted of input.messages) {
			const byMember = "member" in scripted.from;
			const already = saidAlready.get(`${byMember ? "member" : "bot"}:${textOf(scripted.parts)}`);
			if (already) {
				if (scripted.key) keyed.set(scripted.key, already);
				if (byMember) lastMemberMessage = already;
				continue;
			}
			wrote = true;
			const at = timeOn(day, scripted.at);
			const replyToMessageId = scripted.replyTo ? keyed.get(scripted.replyTo) : undefined;
			const messageId =
				"member" in scripted.from
					? yield* writeMemberMessage({
							chatId,
							memberId: cast.members[scripted.from.member],
							text: textOf(scripted.parts),
							at,
							replyToMessageId,
						})
					: yield* writeBotReply(cast, day, {
							chatId,
							bot: scripted.from.bot,
							triggerMessageId: lastMemberMessage,
							parts: scripted.parts,
							at,
							replyToMessageId,
						});
			if ("member" in scripted.from) lastMemberMessage = messageId;
			if (scripted.key) keyed.set(scripted.key, messageId);
			yield* writeReactions(cast, messageId, at, scripted.reactions);
		}
		return wrote;
	});

const writeReactions = <Member extends string>(
	cast: Cast<Member>,
	messageId: string,
	at: Date,
	reactions: ScriptedMessage<Member>["reactions"],
) =>
	Effect.forEach(
		reactions ?? [],
		(reaction) =>
			query((db) =>
				db.insert(messageReaction).values(
					reaction.by.map((member) => ({
						messageId,
						memberId: cast.members[member],
						emoji: reaction.emoji,
						createdAt: new Date(at.getTime() + REACTION_DELAY_MILLISECONDS),
					})),
				),
			),
		{ discard: true },
	);

const REACTION_DELAY_MILLISECONDS = 60_000;
/** How long a scripted bot takes to reply, from its turn starting to its message being done. */
const REPLY_MILLISECONDS = 20_000;
/** How much longer a scripted reply takes for each tool call it makes, and how far apart they start. */
const CALL_MILLISECONDS = 6_000;

const writeMemberMessage = (input: {
	chatId: string;
	memberId: string;
	text: string;
	at: Date;
	replyToMessageId: string | undefined;
}) =>
	Effect.gen(function* () {
		yield* query((db) =>
			db
				.insert(chatParticipant)
				.values({ chatId: input.chatId, memberId: input.memberId, createdAt: input.at })
				.onConflictDoNothing(),
		);
		const id = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id,
				chatId: input.chatId,
				authorMemberId: input.memberId,
				status: "complete",
				parts: [{ type: "text", text: input.text }],
				content: input.text,
				replyToMessageId: input.replyToMessageId ?? null,
				createdAt: input.at,
			}),
		);
		return id;
	});

/**
 * A bot's reply as its turn left it: the turn, the message, and the
 * tool calls placed in it.
 */
const writeBotReply = <Member extends string>(
	cast: Cast<Member>,
	day: Date,
	input: {
		chatId: string;
		bot: string;
		triggerMessageId: string | undefined;
		parts: readonly ScriptedPart<Member>[];
		at: Date;
		replyToMessageId?: string | undefined;
	},
) =>
	Effect.gen(function* () {
		if (!input.triggerMessageId) {
			return yield* Effect.die(new Error(`${input.bot} replies before anyone has written`));
		}
		const botId = idOf(cast.botIds, input.bot);
		const { stored, content, placed } = placeParts(input.parts);
		// A call still waiting for approval leaves its turn waiting and its reply unfinished.
		const waiting = placed.some(
			({ part }) => "toolCall" in part && !part.toolCall.allowed && !part.toolCall.readOnly,
		);
		const calls = placed.filter(({ part }) => "toolCall" in part).length;
		const workMilliseconds = REPLY_MILLISECONDS + calls * CALL_MILLISECONDS;
		// The reply is written from its turn's start, as a real one is, so it shows how long the bot worked.
		const startedAt = new Date(input.at.getTime() - workMilliseconds);
		const turnId = yield* writeTurn(cast, {
			chatId: input.chatId,
			bot: input.bot,
			triggerMessageId: input.triggerMessageId,
			at: input.at,
			waiting,
			workMilliseconds,
		});
		const messageId = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id: messageId,
				chatId: input.chatId,
				authorBotId: botId,
				status: waiting ? "writing" : "complete",
				parts: stored,
				content,
				turnId,
				replyToMessageId: input.replyToMessageId ?? null,
				createdAt: startedAt,
			}),
		);
		let callsStarted = 0;
		for (const { id, atOffset, part } of placed) {
			if ("file" in part) {
				yield* writeFile(cast, {
					id,
					chatId: input.chatId,
					messageId,
					turnId,
					bot: input.bot,
					atOffset,
					writtenAt: input.at,
					...part.file,
				});
			} else {
				yield* writeToolCall(cast, day, {
					id,
					chatId: input.chatId,
					messageId,
					turnId,
					botId,
					atOffset,
					startedAt: new Date(startedAt.getTime() + ++callsStarted * CALL_MILLISECONDS),
					...part.toolCall,
				});
			}
		}
		return messageId;
	});

/**
 * A turn of `bot`'s, started by `triggerMessageId`: finished at `at`, or
 * waiting since then for a call to be approved. A waiting turn names a
 * workflow execution, as a real one does, though no workflow runs it: `stage.ts`
 * plays what happens once the call is allowed.
 */
const writeTurn = (
	cast: Cast<string>,
	input: {
		chatId: string;
		bot: string;
		triggerMessageId: string;
		at: Date;
		waiting?: boolean;
		/** How long before `at` the turn started. */
		workMilliseconds?: number;
	},
) =>
	Effect.gen(function* () {
		const id = randomUUID();
		const startedAt = new Date(input.at.getTime() - (input.workMilliseconds ?? REPLY_MILLISECONDS));
		yield* query((db) =>
			db.insert(turn).values({
				id,
				chatId: input.chatId,
				botId: idOf(cast.botIds, input.bot),
				triggerMessageId: input.triggerMessageId,
				status: input.waiting ? "waiting" : "done",
				executionId: input.waiting ? STAGED_EXECUTION_ID : null,
				model: cast.botModels.get(input.bot) ?? "",
				reason: "default",
				startedAt,
				finishedAt: input.waiting ? null : input.at,
				createdAt: startedAt,
				...askerColumns({
					chatId: input.chatId,
					botId: idOf(cast.botIds, input.bot),
					triggerMessageId: input.triggerMessageId,
				}),
			}),
		);
		return id;
	});

/** The workflow execution a staged waiting turn names, though none runs it. */
export const STAGED_EXECUTION_ID = "showcase-stage";

/** How long a scripted call that only reads takes to run. */
const READ_CALL_MILLISECONDS = 1_400;

/**
 * A tool call in a bot's reply: one that only read and ran straight away, or a
 * connector's call that waited for a member, who allowed it, and then ran.
 * Without a connector it is a tool built into every bot.
 */
const writeToolCall = (
	cast: Cast<string>,
	day: Date,
	input: {
		id: string;
		chatId: string;
		messageId: string;
		turnId: string;
		botId: string;
		atOffset: number;
		startedAt: Date;
		connector?: string;
		tool: string;
		input: JsonValue;
		/** What the call returned, once it has run. */
		output?: JsonValue;
		readOnly?: boolean;
		allowed?: { by: string; at: Clock };
	},
) =>
	Effect.gen(function* () {
		const handle = input.connector;
		const [used] =
			handle === undefined
				? [undefined]
				: yield* query((db) =>
						db
							.select({ id: connector.id, revision: connector.configurationRevision })
							.from(connector)
							.where(
								and(
									eq(connector.projectId, defaultProjectIdOf(sql`${input.botId}::uuid`)),
									eq(connector.handle, handle),
								),
							),
					);
		if (handle !== undefined && !used)
			return yield* Effect.die(new Error(`No ${handle} connector`));
		const allowedAt = input.allowed ? timeOn(day, input.allowed.at) : undefined;
		const ranAt = new Date(input.startedAt.getTime() + READ_CALL_MILLISECONDS);
		const decided = input.readOnly
			? {
					output: input.output ?? null,
					status: "completed" as const,
					finishedAt: ranAt,
					updatedAt: ranAt,
				}
			: input.allowed && allowedAt
				? {
						approvalStatus: "allowed" as const,
						decidedById: (cast.members as Record<string, string>)[input.allowed.by] ?? null,
						decidedAt: allowedAt,
						output: input.output ?? null,
						status: "completed" as const,
						finishedAt: allowedAt,
						updatedAt: allowedAt,
					}
				: {
						approvalStatus: "pending" as const,
						status: "awaiting_approval" as const,
						updatedAt: input.startedAt,
					};
		yield* query((db) =>
			db.insert(toolCall).values({
				id: input.id,
				chatId: input.chatId,
				messageId: input.messageId,
				turnId: input.turnId,
				tool:
					handle === undefined ? input.tool : `${handle}${CONNECTOR_TOOL_SEPARATOR}${input.tool}`,
				sdkToolCallId: randomUUID(),
				approvalId: input.readOnly ? null : randomUUID(),
				connectorId: used?.id ?? null,
				connectorRevision: used?.revision ?? null,
				remoteToolName: handle === undefined ? null : input.tool,
				executionInput: input.input,
				input: input.input,
				writeOrDelete: !input.readOnly,
				atOffset: input.atOffset,
				startedAt: input.startedAt,
				createdAt: input.startedAt,
				...decided,
			}),
		);
	});

/** How long a scripted bot takes to write a file. */
const FILE_WRITE_MILLISECONDS = 8_000;

/**
 * A file the bot wrote, made the way its file tool makes one, and the
 * `file_write` call that shows it under the reply.
 */
const writeFile = (
	cast: Cast<string>,
	input: {
		id: string;
		chatId: string;
		messageId: string;
		turnId: string;
		bot: string;
		atOffset: number;
		writtenAt: Date;
		kind: WrittenFileKind;
		title: string;
		content: string;
	},
) =>
	Effect.gen(function* () {
		const { kind, title, content } = input;
		const written = yield* Files.seedWrittenFile(
			{
				botId: idOf(cast.botIds, input.bot),
				chatId: input.chatId,
			},
			{ kind, title, content },
		).pipe(Effect.orDie);
		yield* query((db) =>
			db
				.update(file)
				.set({ createdAt: input.writtenAt, updatedAt: input.writtenAt })
				.where(eq(file.id, written.id)),
		);
		yield* query((db) =>
			db
				.update(fileVersion)
				.set({ createdAt: input.writtenAt })
				.where(eq(fileVersion.fileId, written.id)),
		);
		yield* query((db) =>
			db.insert(toolCall).values({
				id: input.id,
				chatId: input.chatId,
				messageId: input.messageId,
				turnId: input.turnId,
				tool: FILE_WRITE_TOOL,
				sdkToolCallId: randomUUID(),
				input: { kind, title, content },
				output: {
					status: "written",
					fileId: written.id,
					kind,
					title,
					version: written.version,
				},
				status: "completed",
				writeOrDelete: true,
				atOffset: input.atOffset,
				startedAt: new Date(input.writtenAt.getTime() - FILE_WRITE_MILLISECONDS),
				finishedAt: input.writtenAt,
				createdAt: input.writtenAt,
				updatedAt: input.writtenAt,
			}),
		);
	});

/**
 * A finished or failed run, as the automation runner leaves one: its
 * chat in the automation's own, what started it, the bot's reply
 * there, and that reply posted as the run's result in the automation's feed.
 * Skipped when the automation already has a run at that time.
 */
const writeAutomationRun = (cast: Cast<string>, day: Date, run: AutomationRun) =>
	Effect.gen(function* () {
		const botId = idOf(cast.botIds, run.bot);
		const [defined] = yield* query((db) =>
			db
				.select()
				.from(automation)
				.where(
					and(
						eq(automation.projectId, defaultProjectIdOf(sql`${botId}::uuid`)),
						eq(automation.name, run.automation),
						isNull(automation.deletedAt),
					),
				),
		);
		if (!defined)
			return yield* Effect.die(new Error(`${run.bot} has no automation ${run.automation}`));
		const scheduledAt = timeOn(day, run.scheduledAt);
		const [ranAlready] = yield* query((db) =>
			db
				.select({ id: automationRun.id })
				.from(automationRun)
				.where(
					and(
						eq(automationRun.automationId, defined.id),
						eq(automationRun.triggerIdentity, scheduledAt.toISOString()),
					),
				),
		);
		if (ranAlready) return false;

		const feed = yield* automationFeedOf(cast, { id: defined.id, botId, name: defined.name });
		const finishedAt = timeOn(day, run.finishedAt);
		const runId = randomUUID();
		const runChat = yield* query((db) =>
			seedChat(db, {
				workspaceId: cast.workspaceId,
				kind: "run",
				title: `${run.automation} - ${scheduledAt.toISOString()}`,
				createdAt: scheduledAt,
				updatedAt: finishedAt,
				run: {
					id: runId,
					automationId: defined.id,
					botId,
					triggerKind: "routine",
					triggerIdentity: scheduledAt.toISOString(),
					trigger: {
						kind: "routine",
						scheduledAt: scheduledAt.toISOString(),
						acceptedAt: scheduledAt.toISOString(),
					},
					automationName: defined.name,
					instructions: defined.instructions,
					state: run.failed ? "failed" : "completed",
					error: run.failed ?? null,
					acceptedAt: scheduledAt,
					startedAt: scheduledAt,
					finishedAt,
					createdAt: scheduledAt,
					updatedAt: finishedAt,
				},
			}),
		);
		yield* query((db) => db.insert(chatParticipant).values({ chatId: runChat.id, botId }));
		const triggerId = randomUUID();
		yield* query((db) =>
			db.insert(message).values({
				id: triggerId,
				chatId: runChat.id,
				automationTrigger: {
					kind: "automation_trigger",
					runId,
					automationName: defined.name,
					triggerKind: "routine",
				},
				status: "complete",
				parts: [{ type: "text", text: defined.instructions }],
				content: defined.instructions,
				createdAt: scheduledAt,
			}),
		);
		const turnId = yield* writeTurn(cast, {
			chatId: runChat.id,
			bot: run.bot,
			triggerMessageId: triggerId,
			at: finishedAt,
		});
		// A failed run's reply says why from its turn, as a real failed turn's does.
		const failed = run.failed;
		if (failed) {
			yield* query((db) =>
				db.update(turn).set({ status: "failed", error: failed }).where(eq(turn.id, turnId)),
			);
		}
		const posts = [
			{ chatId: runChat.id, runId: null, turnId },
			{ chatId: feed.id, runId, turnId: null },
		];
		for (const post of posts) {
			yield* query((db) =>
				db.insert(message).values({
					...post,
					authorBotId: botId,
					status: run.failed ? "failed" : "complete",
					parts: [{ type: "text", text: run.result }],
					content: run.result,
					createdAt: finishedAt,
				}),
			);
		}
		yield* touch(feed.id);
		return true;
	});

/** Stamps the chat with its latest message, so it sorts where that happened. */
const touch = (chatId: string) =>
	Effect.gen(function* () {
		const [latest] = yield* query((db) =>
			db
				.select({ at: max(message.createdAt) })
				.from(message)
				.where(eq(message.chatId, chatId)),
		);
		if (!latest?.at) return;
		const at = latest.at;
		yield* query((db) => db.update(chat).set({ updatedAt: at }).where(eq(chat.id, chatId)));
	});

/** Everyone has read every chat they reach, so nothing seeded shows as unread. */
const markEverythingRead = (cast: Cast<string>) =>
	Effect.gen(function* () {
		const now = new Date();
		const rows = yield* query((db) =>
			db
				.select({ chatId: placedChat.id, memberId: membership.memberId })
				.from(placedChat)
				.innerJoin(membership, eq(membership.workspaceId, placedChat.workspaceId))
				.where(
					and(
						eq(placedChat.workspaceId, cast.workspaceId),
						reachesChatFor(placedChat, membership.memberId),
					),
				),
		);
		if (rows.length === 0) return;
		yield* query((db) =>
			db
				.insert(readCursor)
				.values(rows.map((row) => ({ ...row, readThrough: now })))
				.onConflictDoUpdate({
					target: [readCursor.memberId, readCursor.chatId],
					set: { readThrough: now },
				}),
		);
	});

type PlacedPart<Member extends string> = Exclude<ScriptedPart<Member>, { text: string }>;

/**
 * A reply's parts as they are stored: its text, and an id for each
 * tool call with how much text came before it. Its content
 * is the text parts run together, as the app requires.
 */
function placeParts<Member extends string>(parts: readonly ScriptedPart<Member>[]) {
	const stored: StoredMessagePart[] = [];
	const placed: { id: string; atOffset: number; part: PlacedPart<Member> }[] = [];
	let content = "";
	for (const part of parts) {
		if ("text" in part) {
			stored.push({ type: "text", text: part.text });
			content += part.text;
			continue;
		}
		const id = randomUUID();
		stored.push({ type: "tool_call", toolCallId: id });
		placed.push({ id, atOffset: content.length, part });
	}
	return { stored, content, placed };
}

/** The text of a message's parts, run together, as its content is. */
export function textOf(parts: readonly (ScriptedPart<string> | StoredMessagePart)[]): string {
	return parts.flatMap((part) => ("text" in part ? [part.text] : [])).join("");
}

function idOf(ids: ReadonlyMap<string, string>, name: string): string {
	const id = ids.get(name);
	if (!id) throw new Error(`No bot is named ${name}`);
	return id;
}

function projectIdOf(projectIds: Record<string, string>, project: string): string {
	const id = projectIds[project];
	if (!id) throw new Error(`No project is keyed ${project}`);
	return id;
}

/** The chat `id`, as the scenes read it back. */
export const placedById = (id: string) =>
	Effect.flatMap(
		query((db) => db.select().from(placedChat).where(eq(placedChat.id, id)).limit(1)),
		([found]) => (found ? Effect.succeed(found) : Effect.die(new Error(`Chat ${id} is not there`))),
	);

import { NodeRuntime } from "@effect/platform-node";
import type { JsonValue, Message } from "@sugabots/contracts";
import {
	CONNECTION_TOOL_SEPARATOR,
	conversationChannel,
	handleFromName,
	streamEvent,
} from "@sugabots/contracts";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { toTask } from "@sugabots/core/conversations/chats/conversation";
import { taskTitleFrom } from "@sugabots/core/conversations/chats/task-title";
import { ConversationEvents } from "@sugabots/core/conversations/conversation-events";
import { ConversationFeed } from "@sugabots/core/conversations/conversation-feed";
import { ConversationEvent, type ToolCallChange } from "@sugabots/core/conversations/events";
import { toCollaborationPart } from "@sugabots/core/conversations/repository/collaboration-parts";
import {
	type ParticipantRow,
	personAuthor,
	toMessage,
	toPerson,
	toReactions,
} from "@sugabots/core/conversations/repository/participants";
import { toToolCallPart } from "@sugabots/core/conversations/repository/tool-calls";
import { seedConversation } from "@sugabots/core/conversations/seed.test-support";
import { FILE_WRITE_TOOL } from "@sugabots/core/conversations/tools/files/tool";
import { Credentials } from "@sugabots/core/credentials/credentials";
import { layer as databaseLayer, query, transaction } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import { DomainEvents } from "@sugabots/core/database/events/domain-events";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import { EventStore } from "@sugabots/core/database/events/store";
import {
	type BotRow,
	bot as botTable,
	channel,
	channelMember,
	collaboration,
	connection,
	conversation,
	conversationParticipant,
	conversationRead,
	file,
	message,
	messageReaction,
	type PlacedConversationRow,
	placedConversation,
	type StoredMessagePart,
	task,
	toolCall,
	turn,
	user,
	WRITTEN_FILE_KINDS,
	workspace,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { Files } from "@sugabots/core/files/files";
import { Ids } from "@sugabots/core/ids/ids";
import { Installation } from "@sugabots/core/installation/installation";
import { and, eq, getColumns, gt, inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { STAGED_TURN_OWNER } from "./conversations.ts";

/**
 * Plays the demo video's story in the showcase seed (see `seed.ts`),
 * where no model runs: the bots' replies are staged, written as the app
 * writes them and announced on its event stream, so a running server shows
 * them on the open page as it would real ones.
 *
 *   node --env-file=.env packages/demo/src/showcase/stage.ts reset
 *   node --env-file=.env packages/demo/src/showcase/stage.ts start <botId> <messageId> <text>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts send <conversationId> <messageId> <text>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts allow <toolCallId>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts cue mention
 *
 * `reset` takes the story back to where it starts. `start` starts a task with
 * the bot, with the owner's message in it, prints them as the API would
 * answer, then plays the bot's part in the task. `send` posts the owner's
 * message in a channel's conversation or a task, and plays whoever answers her
 * there. `allow` plays what follows an allowed approval, and `cue mention`
 * has Doreen ask Anita something when the demo is looking.
 *
 * The story: in Support's chat, Lorraine says Kestrel Freight was charged
 * twice. Anita starts a task asking Ticket Desk to refund it, and Ticket Desk
 * offers to find out why too. Told to go ahead, it checks Stripe and hands
 * the why to Billing Engineer, which runs the billing tests on its computer
 * and writes the incident up; then it asks to refund. Support's people answer
 * as she goes.
 */

const WORKSPACE_SLUG = "fieldnote";
/** The channel whose people the story is told with, by slug. */
const SUPPORT_CHANNEL = "support";

/** Pauses that make the staged work read as a model's pace. */
const BEFORE_REPLY_STARTS = 1_200;
const BETWEEN_STEPS = 800;
const STRIPE_LOOKUP = 1_300;
const TEST_RUN = 3_500;
const STRIPE_REFUND = 1_600;
/** How replies stream: this many words at a time, this far apart. */
const WORDS_PER_DELTA = 3;
const DELTA_MILLISECONDS = 70;
/** The context window completed turns report, as a Claude model's. */
const CONTEXT_CAPACITY = 200_000;

const STRIPE = "stripe";

const TICKET_DESK = {
	bot: "Ticket Desk",
	/** Its first answer, before it does anything: a question back to Anita. */
	question:
		"Happy to. Two charges on one invoice is usually a retry gone wrong. Want me to ask Billing Engineer to find out why while I sort the refund?",
	lookup: {
		tool: "list_payment_intents",
		input: { customer: "Kestrel Freight", created: "2026-10-03" },
		output: {
			data: [
				{ id: "pi_3QhF7uLz2mN4", amount: 128_000, status: "succeeded", created: "3 Oct, 14:02" },
				{ id: "pi_3QhF8kLz2mN4", amount: 128_000, status: "succeeded", created: "3 Oct, 14:03" },
			],
		},
	},
	found:
		"There are two charges of $1,280 on 3 Oct, a minute apart. I've asked Billing Engineer why, and I'll refund the second once you allow it.\n\n",
	refund: {
		tool: "create_refund",
		input: {
			customer: "Kestrel Freight",
			amount: "$1,280",
			reason: "Charged twice on 3 Oct",
		},
		output: { id: "re_3QhF8kLz2mN4", status: "succeeded", amount: 128_000, currency: "usd" },
	},
	reply:
		"Refunded. It should reach their card in 5 to 10 days, and I've replied on the ticket.\n\nWhy it happened: a charge to Stripe timed out and the billing job retried it without an idempotency key, so Stripe took the retry as a new charge. Billing Engineer has opened #491 with the fix and written the incident up.",
} as const;

const BILLING_ENGINEER = {
	bot: "Billing Engineer",
	title: "Why Kestrel Freight was charged twice",
	brief:
		"Kestrel Freight was charged $1,280 twice on 3 Oct, a minute apart (pi_3QhF7uLz2mN4 and pi_3QhF8kLz2mN4). Can you find out why in the billing code?",
	opening: "Reproducing it against the billing code.\n\n",
	tests: {
		input: { command: "npm test -- billing", timeout_seconds: 300 },
		output: {
			exitCode: 1,
			stdout: [
				" ✓ billing/invoices.test.ts (14 tests)",
				" ✓ billing/webhooks.test.ts (9 tests)",
				" ✗ billing/charge.test.ts > retries a timed-out charge once",
				"   Expected 1 charge to Stripe, received 2",
				"",
				" Tests  1 failed | 46 passed (47)",
			].join("\n"),
			stderr: "",
		},
	},
	incident: {
		title: "Incident: Kestrel Freight charged twice",
		content: [
			"# Incident: Kestrel Freight charged twice",
			"",
			"**Billing · 3 Oct · Resolved**",
			"",
			"## What happened",
			"Kestrel Freight was charged $1,280 twice for their October invoice, a minute apart. Ticket Desk refunded the second charge, with Anita's approval.",
			"",
			"## Why",
			"A charge to Stripe timed out and the billing job retried it. The retry carried no idempotency key, so Stripe took it as a new charge.",
			"",
			"## Fix",
			"- Pass the invoice id as the idempotency key in `chargeInvoice` (#491).",
			"- A new test retries a timed-out charge and expects one charge.",
			"",
			"## Follow-ups",
			"- Check the other invoices charged during the 3 Oct timeouts.",
			"- Alert when one invoice has two successful charges.",
		].join("\n"),
	},
	answer:
		"Found it. When a charge to Stripe times out, the billing job retries it without an idempotency key, so Stripe takes the retry as a second charge. That's what happened to Kestrel on 3 Oct. The fix is to pass the invoice id as the idempotency key in `chargeInvoice`: I've opened #491 with it, and written the incident up.",
} as const;

/** What Support's people do while Anita works through the story. */
const PEOPLE = {
	/** Lorraine, in the task, once the refund is through. */
	thanks: { person: "Lorraine Delgado", emoji: "🙏", text: "Thanks! I'll let Kestrel know." },
	/** Doreen, in Support's chat, asking Anita what to tell Kestrel: written after Anita's handle. */
	mention: {
		person: "Doreen Nakamura",
		text: "Kestrel are asking whether this could happen again. Anything I can tell them?",
	},
	/** Doreen again, answering Anita. */
	closing: { person: "Doreen Nakamura", text: "Great, I've closed the ticket with Kestrel." },
} as const;

/** How long someone shows as typing before their message arrives. */
const TYPING = 1_800;

const wait = (milliseconds: number) => Effect.sleep(milliseconds);

/** The showcase workspace and its owner, who plays Anita's part. */
const showcase = Effect.gen(function* () {
	const [found] = yield* query((db) =>
		db
			.select({ workspace, owner: user })
			.from(workspace)
			.innerJoin(workspaceMember, eq(workspaceMember.workspaceId, workspace.id))
			.innerJoin(user, eq(user.id, workspaceMember.userId))
			.where(and(eq(workspace.slug, WORKSPACE_SLUG), eq(workspaceMember.role, "owner"))),
	);
	if (!found) {
		return yield* Effect.die(
			new Error(
				"No showcase workspace: run `bun run db:seed:showcase` against this database first.",
			),
		);
	}
	return found;
});

const botNamed = (workspaceId: string, name: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select()
				.from(botTable)
				.where(and(eq(botTable.workspaceId, workspaceId), eq(botTable.name, name))),
		),
		([row]) => (row ? Effect.succeed(row) : Effect.die(new Error(`No bot named ${name}`))),
	);

/** The main chat of the showcase channel whose slug is `channelSlug`, which the seed writes in. */
const mainChatOf = (workspaceId: string, channelSlug: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ conversation: getColumns(placedConversation) })
				.from(placedConversation)
				.innerJoin(channel, eq(channel.id, placedConversation.channelId))
				.where(
					and(
						eq(channel.workspaceId, workspaceId),
						eq(channel.slug, channelSlug),
						eq(placedConversation.main, true),
					),
				),
		),
		([row]) =>
			row ? Effect.succeed(row.conversation) : Effect.die(new Error(`${channelSlug} has no chat`)),
	);

function botAuthor(bot: BotRow): ParticipantRow {
	return {
		userId: null,
		userName: null,
		userEmail: null,
		userImage: null,
		botId: bot.id,
		botName: bot.name,
		botHandle: bot.handle,
		botColor: bot.color,
		botFace: bot.face,
		botShape: bot.shape,
	};
}

/** Where a reply is being written: its conversation, turn and message, and its parts so far. */
interface Reply {
	readonly bot: BotRow;
	readonly conversation: PlacedConversationRow;
	readonly turnId: string;
	readonly messageId: string;
	readonly parts: StoredMessagePart[];
}

const personNamed = (workspaceId: string, name: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ id: user.id, name: user.name, email: user.email, image: user.image })
				.from(user)
				.innerJoin(workspaceMember, eq(workspaceMember.userId, user.id))
				.where(and(eq(workspaceMember.workspaceId, workspaceId), eq(user.name, name))),
		),
		([row]) => (row ? Effect.succeed(row) : Effect.die(new Error(`Nobody named ${name}`))),
	);

type Person = Effect.Success<ReturnType<typeof personNamed>>;

/** Shows `person` typing in the conversation, as their composer would. */
const showTyping = (inConversation: PlacedConversationRow, person: Person) =>
	Effect.gen(function* () {
		const bus = yield* EventBus.Service;
		yield* Effect.promise(() =>
			bus.publish(
				conversationChannel(inConversation.id),
				streamEvent("person.typing", {
					conversationId: inConversation.id,
					person: toPerson(person),
				}),
			),
		);
	});

/** `person` posts `text` in the conversation, announced as a sent message is. */
const postAs = (
	person: Person,
	inConversation: PlacedConversationRow,
	text: string,
	id: string = crypto.randomUUID(),
) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		return yield* transaction(
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db
						.insert(message)
						.values({
							id,
							conversationId: inConversation.id,
							authorUserId: person.id,
							kind: "text",
							status: "complete",
							parts: [{ type: "text", text }],
							content: text,
						})
						.returning(),
				);
				if (!row) return yield* Effect.die(new Error("The message wasn't written"));
				yield* query((db) =>
					db
						.insert(conversationParticipant)
						.values({ conversationId: inConversation.id, userId: person.id })
						.onConflictDoNothing(),
				);
				const posted: Message = toMessage(row, personAuthor(person));
				yield* emit([
					ConversationEvent.MessagePosted({
						conversationId: inConversation.id,
						workspaceId: inConversation.workspaceId,
						message: posted,
					}),
				]);
				return posted;
			}),
		);
	});

/** `person` types for a moment, then posts `text`. */
const typeAndPost = (person: Person, inConversation: PlacedConversationRow, text: string) =>
	Effect.gen(function* () {
		yield* showTyping(inConversation, person);
		yield* wait(TYPING);
		yield* postAs(person, inConversation, text);
	});

/** `person` reacts to the message, and the conversation hears its reactions as they now are. */
const react = (
	person: Person,
	inConversation: PlacedConversationRow,
	messageId: string,
	emoji: string,
) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		yield* transaction(
			Effect.gen(function* () {
				yield* query((db) =>
					db
						.insert(messageReaction)
						.values({ messageId, userId: person.id, emoji })
						.onConflictDoNothing(),
				);
				const rows = yield* query((db) =>
					db
						.select({
							emoji: messageReaction.emoji,
							createdAt: messageReaction.createdAt,
							user: { id: user.id, name: user.name },
						})
						.from(messageReaction)
						.innerJoin(user, eq(user.id, messageReaction.userId))
						.where(eq(messageReaction.messageId, messageId))
						.orderBy(messageReaction.createdAt),
				);
				yield* emit([
					ConversationEvent.ReactionsChanged({
						conversationId: inConversation.id,
						messageId,
						reactions: toReactions(rows),
					}),
				]);
			}),
		);
	});

/** The bot starts its turn on `triggerMessageId`: a reply with nothing in it yet. */
const startReply = (bot: BotRow, inConversation: PlacedConversationRow, triggerMessageId: string) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		return yield* transaction(
			Effect.gen(function* () {
				const [started] = yield* query((db) =>
					db
						.insert(turn)
						.values({
							conversationId: inConversation.id,
							botId: bot.id,
							triggerMessageId,
							status: "running",
							owner: STAGED_TURN_OWNER,
							model: bot.model ?? "",
							reason: "default",
							startedAt: new Date(),
						})
						.returning(),
				);
				if (!started) return yield* Effect.die(new Error("The turn wasn't written"));
				const [replyRow] = yield* query((db) =>
					db
						.insert(message)
						.values({
							conversationId: inConversation.id,
							authorBotId: bot.id,
							kind: "text",
							status: "streaming",
							parts: [],
							content: "",
							turnId: started.id,
						})
						.returning(),
				);
				if (!replyRow) return yield* Effect.die(new Error("The reply wasn't written"));
				yield* query((db) =>
					db
						.insert(conversationParticipant)
						.values({ conversationId: inConversation.id, botId: bot.id })
						.onConflictDoNothing(),
				);
				yield* emit([
					ConversationEvent.TurnStarted({
						conversationId: inConversation.id,
						turnId: started.id,
						botId: bot.id,
						reply: toMessage(replyRow, botAuthor(bot)),
					}),
				]);
				const reply: Reply = {
					bot,
					conversation: inConversation,
					turnId: started.id,
					messageId: replyRow.id,
					parts: [],
				};
				return reply;
			}),
		);
	});

/** Writes a tool call's change and announces it, as the turn's own steps would. */
const changeCall = (
	callId: string,
	changes: Partial<typeof toolCall.$inferInsert>,
	announce: (change: ToolCallChange) => ConversationEvent,
	decidedByName: string | null = null,
) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		yield* transaction(
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db.update(toolCall).set(changes).where(eq(toolCall.id, callId)).returning(),
				);
				if (!row) return yield* Effect.die(new Error("A staged tool call went missing"));
				yield* emit([
					announce({
						conversationId: row.conversationId,
						messageId: row.messageId,
						toolCall: toToolCallPart(row, decidedByName),
					}),
				]);
			}),
		);
	});

/** The reply's parts as they are now, saved so a reload shows them. */
const saveParts = (reply: Reply) =>
	query((db) =>
		db.update(message).set({ parts: reply.parts }).where(eq(message.id, reply.messageId)),
	);

/**
 * The reply calls a tool: running at once, or waiting for approval when
 * `awaitsApproval`. Placed in the reply after what it holds so far.
 */
const callTool = (
	reply: Reply,
	call: {
		tool: string;
		input: JsonValue;
		connectionId?: string;
		remoteToolName?: string;
		mutating: boolean;
		awaitsApproval?: boolean;
	},
) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		return yield* transaction(
			Effect.gen(function* () {
				const [written] = yield* query((db) =>
					db
						.insert(toolCall)
						.values({
							conversationId: reply.conversation.id,
							messageId: reply.messageId,
							turnId: reply.turnId,
							tool: call.tool,
							sdkToolCallId: crypto.randomUUID(),
							connectionId: call.connectionId ?? null,
							connectionRevision: call.connectionId ? 1 : null,
							remoteToolName: call.remoteToolName ?? null,
							executionInput: call.input,
							input: call.input,
							mutating: call.mutating,
							atOffset: textOf(reply.parts).length,
							...(call.awaitsApproval
								? {
										status: "awaiting_approval" as const,
										approvalId: crypto.randomUUID(),
										approvalStatus: "pending" as const,
									}
								: { status: "running" as const }),
						})
						.returning(),
				);
				if (!written) return yield* Effect.die(new Error("The tool call wasn't written"));
				reply.parts.push({ type: "tool_call", toolCallId: written.id });
				yield* saveParts(reply);
				yield* emit([
					ConversationEvent.ToolCallStarted({
						conversationId: written.conversationId,
						messageId: written.messageId,
						toolCall: toToolCallPart(written),
					}),
				]);
				return written.id;
			}),
		);
	});

const finishCall = (callId: string, output: JsonValue, decidedByName: string | null = null) =>
	changeCall(
		callId,
		{ status: "completed", output, finishedAt: new Date() },
		ConversationEvent.ToolCallFinished,
		decidedByName,
	);

/** The text of a reply's parts, run together, as its content is. */
function textOf(parts: readonly StoredMessagePart[]): string {
	return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The reply writes `text` after what it holds so far, typed in a few words at a time. */
const say = (reply: Reply, text: string) =>
	Effect.gen(function* () {
		const bus = yield* EventBus.Service;
		const words = text.split(/(?<= )/);
		let offset = textOf(reply.parts).length;
		for (let start = 0; start < words.length; start += WORDS_PER_DELTA) {
			const delta = words.slice(start, start + WORDS_PER_DELTA).join("");
			yield* Effect.promise(() =>
				bus.publish(
					conversationChannel(reply.conversation.id),
					streamEvent("message.delta", {
						conversationId: reply.conversation.id,
						messageId: reply.messageId,
						offset,
						text: delta,
					}),
				),
			);
			offset += delta.length;
			yield* wait(DELTA_MILLISECONDS);
		}
		reply.parts.push({ type: "text", text });
		yield* query((db) =>
			db
				.update(message)
				.set({ parts: reply.parts, content: textOf(reply.parts) })
				.where(eq(message.id, reply.messageId)),
		);
	});

/** The reply's last words, then the turn completed. Returns all the reply says. */
const finishReply = (reply: Reply, text: string) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		yield* say(reply, text);
		const content = textOf(reply.parts);
		yield* transaction(
			Effect.gen(function* () {
				yield* query((db) =>
					db.update(message).set({ status: "complete" }).where(eq(message.id, reply.messageId)),
				);
				yield* query((db) =>
					db
						.update(turn)
						.set({ status: "done", finishedAt: new Date(), contextCapacity: CONTEXT_CAPACITY })
						.where(eq(turn.id, reply.turnId)),
				);
				yield* emit([
					ConversationEvent.TurnCompleted({
						conversationId: reply.conversation.id,
						workspaceId: reply.conversation.workspaceId,
						turnId: reply.turnId,
						botId: reply.bot.id,
						messageId: reply.messageId,
						content,
						contextTokens: undefined,
						contextCapacity: CONTEXT_CAPACITY,
						readKeptFrom: null,
					}),
				]);
			}),
		);
		return content;
	});

/**
 * The reply asks `collaborator` for help: the collaboration's own conversation, the
 * brief, the collaborator's turn there played by `answer`, and what it said
 * recorded as the answer.
 */
const collaborate = <E, R>(
	reply: Reply,
	collaborator: BotRow,
	ask: { title: string; brief: string },
	answer: (answering: Reply) => Effect.Effect<string, E, R>,
) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		const opened = yield* transaction(
			Effect.gen(function* () {
				// Its `collaboration` row, written below in this transaction, is what makes it one.
				const [child] = yield* query((db) =>
					db
						.insert(conversation)
						.values({
							workspaceId: reply.conversation.workspaceId,
							kind: "collaboration",
							title: ask.title,
						})
						.returning(),
				);
				if (!child) return yield* Effect.die(new Error("The collaboration wasn't opened"));
				yield* query((db) =>
					db.insert(conversationParticipant).values([
						{ conversationId: child.id, botId: reply.bot.id },
						{ conversationId: child.id, botId: collaborator.id },
					]),
				);
				const [briefRow] = yield* query((db) =>
					db
						.insert(message)
						.values({
							conversationId: child.id,
							authorBotId: reply.bot.id,
							kind: "text",
							status: "complete",
							parts: [{ type: "text", text: ask.brief }],
							content: ask.brief,
						})
						.returning(),
				);
				if (!briefRow) return yield* Effect.die(new Error("The brief wasn't written"));
				const [row] = yield* query((db) =>
					db
						.insert(collaboration)
						.values({
							parentConversationId: reply.conversation.id,
							rootConversationId: reply.conversation.rootConversationId ?? reply.conversation.id,
							parentMessageId: reply.messageId,
							turnId: reply.turnId,
							conversationId: child.id,
							collaboratorBotId: collaborator.id,
							brief: ask.brief,
							status: "waiting",
							atOffset: textOf(reply.parts).length,
						})
						.returning(),
				);
				if (!row) return yield* Effect.die(new Error("The collaboration wasn't written"));
				reply.parts.push({ type: "collaboration", collaborationId: row.id });
				yield* saveParts(reply);
				yield* emit([
					ConversationEvent.CollaborationOpened({
						parentConversationId: reply.conversation.id,
						parentMessageId: reply.messageId,
						collaboration: toCollaborationPart(row, collaborator.name),
						workspaceId: reply.conversation.workspaceId,
						collaboratorBotId: collaborator.id,
						briefMessageId: briefRow.id,
					}),
				]);
				const [placed] = yield* query((db) =>
					db.select().from(placedConversation).where(eq(placedConversation.id, child.id)).limit(1),
				);
				if (!placed) return yield* Effect.die(new Error("The collaboration wasn't placed"));
				return { child: placed, briefId: briefRow.id, collaborationId: row.id };
			}),
		);
		yield* wait(BETWEEN_STEPS);
		const answering = yield* startReply(collaborator, opened.child, opened.briefId);
		const answered = yield* answer(answering);
		yield* transaction(
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db
						.update(collaboration)
						.set({ status: "answered", answer: answered })
						.where(eq(collaboration.id, opened.collaborationId))
						.returning(),
				);
				if (!row) return yield* Effect.die(new Error("The collaboration went missing"));
				yield* emit([
					ConversationEvent.CollaborationAnswered({
						parentConversationId: reply.conversation.id,
						parentMessageId: reply.messageId,
						collaboration: toCollaborationPart(row, collaborator.name),
						askerToResume: null,
					}),
				]);
			}),
		);
	});

/** Ticket Desk answers Anita's ask with a question, before it does anything. */
const playTicketDesk = (bot: BotRow, inConversation: PlacedConversationRow, triggerId: string) =>
	Effect.gen(function* () {
		yield* wait(BEFORE_REPLY_STARTS);
		const reply = yield* startReply(bot, inConversation, triggerId);
		yield* finishReply(reply, TICKET_DESK.question);
	});

/**
 * Told to go ahead, Ticket Desk looks the charges up in Stripe, says what it
 * found, asks Billing Engineer why there were two, then asks to refund the
 * second. What it says stands apart from its calls, so the app shows it rather
 * than folding it into a call's line as narration.
 */
const playTicketDeskWork = (
	bot: BotRow,
	inConversation: PlacedConversationRow,
	triggerId: string,
) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		const [stripe] = yield* query((db) =>
			db
				.select({ id: connection.id })
				.from(connection)
				.where(and(eq(connection.botId, bot.id), eq(connection.handle, STRIPE))),
		);
		if (!stripe) return yield* Effect.die(new Error(`${bot.name} has no Stripe connection`));
		const stripeCall = (name: string) => ({
			tool: `${STRIPE}${CONNECTION_TOOL_SEPARATOR}${name}`,
			connectionId: stripe.id,
			remoteToolName: name,
		});

		yield* wait(BEFORE_REPLY_STARTS);
		const reply = yield* startReply(bot, inConversation, triggerId);
		yield* wait(BETWEEN_STEPS);
		const lookup = yield* callTool(reply, {
			...stripeCall(TICKET_DESK.lookup.tool),
			input: TICKET_DESK.lookup.input,
			mutating: false,
		});
		yield* wait(STRIPE_LOOKUP);
		yield* finishCall(lookup, TICKET_DESK.lookup.output);
		yield* say(reply, TICKET_DESK.found);
		yield* wait(BETWEEN_STEPS);
		const billingEngineer = yield* botNamed(inConversation.workspaceId, BILLING_ENGINEER.bot);
		yield* collaborate(
			reply,
			billingEngineer,
			{ title: BILLING_ENGINEER.title, brief: BILLING_ENGINEER.brief },
			playBillingEngineer,
		);
		yield* wait(BETWEEN_STEPS);
		yield* callTool(reply, {
			...stripeCall(TICKET_DESK.refund.tool),
			input: TICKET_DESK.refund.input,
			mutating: true,
			awaitsApproval: true,
		});
		yield* transaction(
			Effect.gen(function* () {
				yield* query((db) =>
					db.update(turn).set({ status: "waiting" }).where(eq(turn.id, reply.turnId)),
				);
				yield* emit([
					ConversationEvent.TurnSuspended({
						conversationId: inConversation.id,
						workspaceId: inConversation.workspaceId,
						turnId: reply.turnId,
					}),
				]);
			}),
		);
	});

/** Billing Engineer runs the billing tests on its computer, writes the incident up, and answers. */
const playBillingEngineer = (reply: Reply) =>
	Effect.gen(function* () {
		yield* say(reply, BILLING_ENGINEER.opening);
		const tests = yield* callTool(reply, {
			tool: "run_command",
			input: BILLING_ENGINEER.tests.input,
			mutating: true,
		});
		yield* wait(TEST_RUN);
		yield* finishCall(tests, BILLING_ENGINEER.tests.output);
		yield* wait(BETWEEN_STEPS);
		yield* writeIncident(reply);
		yield* wait(BETWEEN_STEPS);
		return yield* finishReply(reply, BILLING_ENGINEER.answer);
	});

/** Doreen mentions Anita in Support's chat, which brings it to Anita's Inbox wherever she is. */
const cueMention = Effect.gen(function* () {
	const { workspace: showcaseWorkspace, owner } = yield* showcase;
	const support = yield* mainChatOf(showcaseWorkspace.id, SUPPORT_CHANNEL);
	const asking = yield* personNamed(showcaseWorkspace.id, PEOPLE.mention.person);
	yield* typeAndPost(asking, support, `@${handleFromName(owner.name)} ${PEOPLE.mention.text}`);
});

/**
 * Billing Engineer writes the incident up: the file, made as its file
 * tool makes one, and the `file_write` call that shows it under the reply.
 */
const writeIncident = (reply: Reply) =>
	Effect.gen(function* () {
		const authoring = yield* Files.Authoring;
		const { title, content } = BILLING_ENGINEER.incident;
		const input = { kind: "document", title, content };
		const call = yield* callTool(reply, { tool: FILE_WRITE_TOOL, input, mutating: true });
		const written = yield* authoring
			.create(
				{
					workspaceId: reply.conversation.workspaceId,
					botId: reply.bot.id,
					conversationId: reply.conversation.id,
				},
				{ kind: "document", title, content },
			)
			.pipe(Effect.orDie);
		yield* wait(BETWEEN_STEPS);
		yield* finishCall(call, {
			status: "written",
			fileId: written.id,
			kind: written.kind,
			title: written.title,
			version: written.version,
		});
	});

/** What each bot in the story does when Anita starts a task with it. */
const PARTS = new Map([[TICKET_DESK.bot as string, playTicketDesk]]);

/** What each bot in the story does when Anita answers it in its task. */
const BOT_WORK = new Map([[TICKET_DESK.bot as string, playTicketDeskWork]]);

/** Who answers Anita when she writes in a channel's conversation, by the channel's slug. */
const PEOPLE_PARTS = new Map([
	[
		SUPPORT_CHANNEL,
		(inConversation: PlacedConversationRow) =>
			Effect.gen(function* () {
				const answering = yield* personNamed(inConversation.workspaceId, PEOPLE.closing.person);
				yield* typeAndPost(answering, inConversation, PEOPLE.closing.text);
			}),
	],
]);

/**
 * The conversation `conversationId`, a channel's conversation or a task, with its
 * channel's slug if it is in one, and its bot if it has one.
 */
const conversationById = (conversationId: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({
					conversation: getColumns(placedConversation),
					channelSlug: channel.slug,
					bot: botTable,
				})
				.from(placedConversation)
				.leftJoin(channel, eq(channel.id, placedConversation.channelId))
				.leftJoin(botTable, eq(botTable.id, placedConversation.botId))
				.where(eq(placedConversation.id, conversationId)),
		),
		([row]) =>
			row ? Effect.succeed(row) : Effect.die(new Error(`No conversation ${conversationId}`)),
	);

/**
 * Starts a task with `botId` and posts the owner's message in it, as the API
 * does, prints them as it answers, then plays the bot's part in the task,
 * answering the message.
 */
const start = (botId: string, messageId: string, text: string) =>
	Effect.gen(function* () {
		const { owner } = yield* showcase;
		const { emit } = yield* ConversationEvents.Service;
		const [bot] = yield* query((db) => db.select().from(botTable).where(eq(botTable.id, botId)));
		if (!bot) return yield* Effect.die(new Error(`No bot ${botId}`));
		const started = yield* transaction(
			Effect.gen(function* () {
				const { id } = yield* query((db) =>
					seedConversation(db, {
						workspaceId: bot.workspaceId,
						kind: "task",
						botId: bot.id,
						startedById: owner.id,
						title: taskTitleFrom(text),
					}),
				);
				const [row] = yield* query((db) =>
					db.select().from(placedConversation).where(eq(placedConversation.id, id)).limit(1),
				);
				if (!row) return yield* Effect.die(new Error("The task wasn't started"));
				yield* query((db) =>
					db.insert(conversationParticipant).values([
						{ conversationId: id, userId: owner.id },
						{ conversationId: id, botId: bot.id },
					]),
				);
				yield* emit([
					ConversationEvent.TaskStarted({ workspaceId: row.workspaceId, conversationId: row.id }),
				]);
				return row;
			}),
		);
		const posted = yield* postAs(owner, started, text, messageId);
		// The first line out is the start's answer, which the autopilot hands the page.
		console.log(JSON.stringify({ conversation: toTask(started), message: posted }));
		const part = PARTS.get(bot.name);
		if (part) yield* part(bot, started, messageId);
	});

/**
 * Posts the owner's message in the conversation, prints it as the API answers
 * a send, then plays who answers her: in a channel's conversation its people, and in
 * a task its bot.
 */
const send = (conversationId: string, messageId: string, text: string) =>
	Effect.gen(function* () {
		const { owner } = yield* showcase;
		const found = yield* conversationById(conversationId);
		const posted = yield* postAs(owner, found.conversation, text, messageId);
		console.log(JSON.stringify(posted));
		if (found.bot) {
			const part = BOT_WORK.get(found.bot.name);
			if (part) yield* part(found.bot, found.conversation, messageId);
			return;
		}
		const answer = found.channelSlug ? PEOPLE_PARTS.get(found.channelSlug) : undefined;
		if (answer) yield* answer(found.conversation);
	});

/** The refund goes ahead: the decision, the call running and returning, and Ticket Desk's reply. */
const allow = (toolCallId: string) =>
	Effect.gen(function* () {
		const { owner } = yield* showcase;
		const [found] = yield* query((db) =>
			db
				.select({
					call: toolCall,
					conversation: getColumns(placedConversation),
					turn,
					bot: botTable,
					reply: message,
				})
				.from(toolCall)
				.innerJoin(placedConversation, eq(placedConversation.id, toolCall.conversationId))
				.innerJoin(turn, eq(turn.id, toolCall.turnId))
				.innerJoin(botTable, eq(botTable.id, turn.botId))
				.innerJoin(message, eq(message.id, toolCall.messageId))
				.where(eq(toolCall.id, toolCallId)),
		);
		if (found?.call.status !== "awaiting_approval") {
			return yield* Effect.die(new Error("That call isn't waiting for approval"));
		}
		const reply: Reply = {
			bot: found.bot,
			conversation: found.conversation,
			turnId: found.turn.id,
			messageId: found.reply.id,
			parts: [...found.reply.parts],
		};
		yield* changeCall(
			toolCallId,
			{ approvalStatus: "allowed", decidedById: owner.id, decidedAt: new Date() },
			(change) =>
				ConversationEvent.ToolCallDecided({
					...change,
					workspaceId: found.conversation.workspaceId,
				}),
			owner.name,
		);
		yield* wait(BETWEEN_STEPS);
		yield* query((db) =>
			db.update(turn).set({ status: "running" }).where(eq(turn.id, reply.turnId)),
		);
		yield* changeCall(
			toolCallId,
			{ status: "running", startedAt: new Date() },
			ConversationEvent.ToolCallExecuting,
			owner.name,
		);
		yield* wait(STRIPE_REFUND);
		yield* finishCall(toolCallId, TICKET_DESK.refund.output, owner.name);
		yield* wait(BETWEEN_STEPS);
		yield* finishReply(reply, TICKET_DESK.reply);

		const lorraine = yield* personNamed(found.conversation.workspaceId, PEOPLE.thanks.person);
		yield* showTyping(found.conversation, lorraine);
		yield* wait(BETWEEN_STEPS);
		yield* react(lorraine, found.conversation, reply.messageId, PEOPLE.thanks.emoji);
		yield* wait(TYPING);
		yield* postAs(lorraine, found.conversation, PEOPLE.thanks.text);
	});

/**
 * Takes the story back to where it starts: what the seed wrote. The tasks
 * started with the story's bots since go, the collaborations and files made
 * in them included, and so does what was said in Support's chat since; and
 * Support's people have read what's left there.
 */
const reset = Effect.gen(function* () {
	const { workspace: showcaseWorkspace } = yield* showcase;
	const seeded = showcaseWorkspace.setupCompletedAt;
	if (!seeded)
		return yield* Effect.die(new Error("The showcase isn't seeded as the story expects"));
	const support = yield* mainChatOf(showcaseWorkspace.id, SUPPORT_CHANNEL);
	const storyBots = yield* Effect.forEach([...PARTS.keys()], (name) =>
		Effect.map(botNamed(showcaseWorkspace.id, name), (bot) => bot.id),
	);
	const removed = yield* transaction(
		Effect.gen(function* () {
			const started = yield* query((db) =>
				db
					.select({ id: conversation.id })
					.from(task)
					.innerJoin(conversation, eq(conversation.id, task.conversationId))
					.where(and(inArray(task.botId, storyBots), gt(conversation.createdAt, seeded))),
			);
			const startedIds = started.map(({ id }) => id);
			if (startedIds.length > 0) {
				yield* query((db) =>
					db
						.delete(file)
						.where(
							and(
								inArray(file.kind, [...WRITTEN_FILE_KINDS]),
								inArray(
									file.conversationId,
									db
										.select({ id: conversation.id })
										.from(conversation)
										.where(eq(conversation.workspaceId, showcaseWorkspace.id)),
								),
								gt(file.createdAt, seeded),
							),
						),
				);
				// A task's messages, turns, calls and collaborations go with it.
				yield* query((db) => db.delete(conversation).where(inArray(conversation.id, startedIds)));
			}
			const gone = yield* query((db) =>
				db
					.delete(message)
					.where(and(eq(message.conversationId, support.id), gt(message.createdAt, seeded)))
					.returning({ id: message.id }),
			);
			const readers = yield* query((db) =>
				db
					.select({ userId: channelMember.userId })
					.from(channelMember)
					.where(eq(channelMember.channelId, support.channelId ?? "")),
			);
			const now = new Date();
			if (readers.length > 0) {
				yield* query((db) =>
					db
						.insert(conversationRead)
						.values(
							readers.map((reader) => ({
								...reader,
								conversationId: support.id,
								readThrough: now,
							})),
						)
						.onConflictDoUpdate({
							target: [conversationRead.userId, conversationRead.conversationId],
							set: { readThrough: now },
						}),
				);
			}
			return { tasks: startedIds.length, messages: gone.length };
		}),
	);
	console.log(
		`The story is back at its start (${removed.tasks} tasks and ${removed.messages} messages removed).`,
	);
});

/**
 * Gives every showcase connection placeholder tokens, so the connections page
 * shows them signed in. Only for a throwaway capture database: the tokens
 * open nothing, and a turn that used them would fail.
 */
const signInConnections = Effect.gen(function* () {
	const credentials = yield* Credentials.Service;
	const { workspace: showcaseWorkspace } = yield* showcase;
	const record = { tokens: { access_token: "showcase-placeholder", token_type: "Bearer" } };
	const signedIn = yield* query((db) =>
		db
			.update(connection)
			.set({ oauthEncrypted: credentials.encrypt(JSON.stringify(record)) })
			.where(
				and(eq(connection.workspaceId, showcaseWorkspace.id), eq(connection.authKind, "oauth")),
			)
			.returning({ id: connection.id }),
	);
	console.log(`Signed in ${signedIn.length} connections with placeholder tokens.`);
});

/** Only the conversation feed hears what the stage emits: it is what tells the open page. */
const conversationEvents = Layer.effect(
	ConversationEvents.Service,
	Effect.map(EventOutbox.Service, (outbox) =>
		ConversationEvents.Service.of({
			emit: DomainEvents.emitTo<ConversationEvent>([ConversationFeed.handler(outbox)]),
		}),
	),
);

const USAGE =
	"Usage: stage.ts reset | start <botId> <messageId> <text> | send <conversationId> <messageId> <text> | allow <toolCallId> | cue mention | sign-in-connections";
const [command, ...args] = process.argv.slice(2);

const program = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	if (installation.isProduction) {
		return yield* Effect.die(new Error("The showcase stage cannot run in production."));
	}
	const [first = "", second = "", ...rest] = args;
	if (command === "reset") return yield* reset;
	if (command === "start" && first && second && rest.length > 0) {
		return yield* start(first, second, rest.join(" "));
	}
	if (command === "send" && first && second && rest.length > 0) {
		return yield* send(first, second, rest.join(" "));
	}
	if (command === "allow" && first) return yield* allow(first);
	if (command === "cue" && first === "mention") return yield* cueMention;
	if (command === "sign-in-connections") return yield* signInConnections;
	return yield* Effect.die(new Error(USAGE));
});

program.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(
			conversationEvents,
			Files.authoringLayer.pipe(Layer.provide(BlobStore.layer)),
		).pipe(
			Layer.provideMerge(EventOutbox.layer),
			Layer.provideMerge(EventBus.layer),
			Layer.provideMerge(EventStore.layer),
			Layer.provideMerge(Ids.layer),
			Layer.provideMerge(Credentials.layer),
			Layer.provideMerge(Installation.layer),
			Layer.provideMerge(databaseLayer),
		),
	),
	NodeRuntime.runMain,
);

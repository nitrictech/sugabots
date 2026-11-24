import { NodeRuntime } from "@effect/platform-node";
import type { JsonValue, Message } from "@sugabots/contracts";
import {
	CONNECTOR_TOOL_SEPARATOR,
	chatStream,
	handleFromName,
	streamEvent,
} from "@sugabots/contracts";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { ChatEventStream } from "@sugabots/core/chats/chat-event-stream";
import { ChatEvents } from "@sugabots/core/chats/chat-events";
import { toProjectChat } from "@sugabots/core/chats/chats/chat";
import { chatTitleFrom } from "@sugabots/core/chats/chats/chat-title";
import { ChatEvent, type ToolCallChange } from "@sugabots/core/chats/events";
import { seedChat } from "@sugabots/core/chats/seed.test-support";
import {
	authorRow,
	memberAuthor,
	toMember,
	toMessage,
	toReactions,
} from "@sugabots/core/chats/store/participants";
import { toToolCallPart } from "@sugabots/core/chats/store/tool-calls";
import { FILE_WRITE_TOOL } from "@sugabots/core/chats/tools/files/tool";
import { layer as databaseLayer, query, transaction } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import { DomainEvents } from "@sugabots/core/database/events/domain-events";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import { EventStore } from "@sugabots/core/database/events/store";
import {
	type BotRow,
	bot as botTable,
	chat,
	chatParticipant,
	connector,
	file,
	member,
	membership,
	message,
	messageReaction,
	type PlacedChatRow,
	placedChat,
	project,
	projectMember,
	readCursor,
	type StoredMessagePart,
	type TurnReason,
	toolCall,
	turn,
	WRITTEN_FILE_KINDS,
	workspace,
} from "@sugabots/core/database/schema";
import { Files } from "@sugabots/core/files/files";
import { Ids } from "@sugabots/core/ids/ids";
import { Secrets } from "@sugabots/core/secrets/secrets";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { defaultProjectIdOf } from "@sugabots/core/workspaces/bots/bot";
import { and, eq, getColumns, gt, inArray, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { placedById, STAGED_EXECUTION_ID, SUPPORT_HANDOVER_CHAT, textOf } from "./chats.ts";

/**
 * Plays the demo video's story in the showcase seed (see `seed.ts`),
 * where no model runs: the bots' replies are staged, written as the app
 * writes them and announced on its event stream, so a running server shows
 * them on the open page as it would real ones.
 *
 *   node --env-file=.env packages/demo/src/showcase/stage.ts reset
 *   node --env-file=.env packages/demo/src/showcase/stage.ts start <botId> <messageId> <text>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts send <chatId> <messageId> <text>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts allow <toolCallId>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts cue mention
 *   node --env-file=.env packages/demo/src/showcase/stage.ts sign-in-connectors
 *
 * `reset` takes the story back to where it starts. `start` starts a chat with
 * the bot, with the owner's message in it, prints them as the API would
 * answer, then plays the bot's part in the chat. `send` posts the owner's
 * message in a project's chat or a bot's chat, and plays whoever answers her
 * there. `allow` plays what follows an allowed approval, and `cue mention`
 * has Doreen ask Anita something when the demo is looking.
 * `sign-in-connectors` gives the showcase's connectors placeholder credentials.
 *
 * The story: in Support's handover chat, Lorraine says Kestrel Freight was charged
 * twice. Anita starts a chat asking Ticket Desk to refund it, and Ticket Desk
 * offers to find out why too. Told to go ahead, it checks Stripe and asks
 * Billing Engineer why by mentioning it; Billing Engineer runs the billing
 * tests on its computer, writes the incident up and answers in the chat; then
 * Ticket Desk, handed back the floor, asks to refund. Support's members answer
 * as she goes.
 */

const WORKSPACE_SLUG = "fieldnote";
/** The project whose members the story is told with, by slug. */
const SUPPORT_PROJECT = "support";

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
	found: "There are two charges of $1,280 on 3 Oct, a minute apart.\n\n",
	/** Asking Billing Engineer, which the mention gives a turn of its own. */
	ask: `@${handleFromName("Billing Engineer")}, can you find out why in the billing code? They're pi_3QhF7uLz2mN4 and pi_3QhF8kLz2mN4. I'll refund the second once Anita allows it.`,
	/** Its hand-back, once Billing Engineer has answered. */
	handBack: "Billing Engineer found the cause. Refunding the second charge once you allow it.\n\n",
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

/** What Support's members do while Anita works through the story. */
const MEMBERS = {
	/** Lorraine, in the chat, once the refund is through. */
	thanks: { member: "Lorraine Delgado", emoji: "🙏", text: "Thanks! I'll let Kestrel know." },
	/** Doreen, in Support's handover chat, asking Anita what to tell Kestrel: written after Anita's handle. */
	mention: {
		member: "Doreen Nakamura",
		text: "Kestrel are asking whether this could happen again. Anything I can tell them?",
	},
	/** Doreen again, answering Anita. */
	closing: { member: "Doreen Nakamura", text: "Great, I've closed the ticket with Kestrel." },
} as const;

/** How long someone shows as typing before their message arrives. */
const TYPING = 1_800;

const wait = (milliseconds: number) => Effect.sleep(milliseconds);

/** The showcase workspace and its owner, who plays Anita's part. */
const showcase = Effect.gen(function* () {
	const [found] = yield* query((db) =>
		db
			.select({ workspace, owner: member })
			.from(workspace)
			.innerJoin(membership, eq(membership.workspaceId, workspace.id))
			.innerJoin(member, eq(member.id, membership.memberId))
			.where(and(eq(workspace.slug, WORKSPACE_SLUG), eq(membership.role, "owner"))),
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

/** Support's handover chat, which the seed writes in and the story starts from. */
const handoverChatOf = (workspaceId: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ chat: getColumns(placedChat) })
				.from(placedChat)
				.innerJoin(project, eq(project.id, placedChat.projectId))
				.where(
					and(
						eq(project.workspaceId, workspaceId),
						eq(project.slug, SUPPORT_PROJECT),
						eq(placedChat.title, SUPPORT_HANDOVER_CHAT),
					),
				),
		),
		([row]) =>
			row
				? Effect.succeed(row.chat)
				: Effect.die(new Error(`${SUPPORT_PROJECT} has no ${SUPPORT_HANDOVER_CHAT} chat`)),
	);

/** Where a reply is being written: its chat, turn and message, and its parts so far. */
interface Reply {
	readonly bot: BotRow;
	readonly chat: PlacedChatRow;
	readonly turnId: string;
	readonly messageId: string;
	readonly parts: StoredMessagePart[];
}

const memberNamed = (workspaceId: string, name: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ id: member.id, name: member.name, email: member.email, image: member.image })
				.from(member)
				.innerJoin(membership, eq(membership.memberId, member.id))
				.where(and(eq(membership.workspaceId, workspaceId), eq(member.name, name))),
		),
		([row]) => (row ? Effect.succeed(row) : Effect.die(new Error(`Nobody named ${name}`))),
	);

type Member = Effect.Success<ReturnType<typeof memberNamed>>;

/** Shows `member` typing in the chat, as their composer would. */
const showTyping = (inChat: PlacedChatRow, member: Member) =>
	Effect.gen(function* () {
		const bus = yield* EventBus.Service;
		yield* Effect.promise(() =>
			bus.publish(
				chatStream(inChat.id),
				streamEvent("member.typing", {
					chatId: inChat.id,
					member: toMember(member),
				}),
			),
		);
	});

/** `member` posts `text` in the chat, announced as a sent message is. */
const postAs = (
	member: Member,
	inChat: PlacedChatRow,
	text: string,
	id: string = crypto.randomUUID(),
) =>
	Effect.gen(function* () {
		const { emit } = yield* ChatEvents.Service;
		return yield* transaction(
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db
						.insert(message)
						.values({
							id,
							chatId: inChat.id,
							authorMemberId: member.id,
							status: "complete",
							parts: [{ type: "text", text }],
							content: text,
						})
						.returning(),
				);
				if (!row) return yield* Effect.die(new Error("The message wasn't written"));
				yield* query((db) =>
					db
						.insert(chatParticipant)
						.values({ chatId: inChat.id, memberId: member.id })
						.onConflictDoNothing(),
				);
				const posted: Message = toMessage(row, memberAuthor(member));
				yield* emit([
					ChatEvent.MessagePosted({
						chatId: inChat.id,
						workspaceId: inChat.workspaceId,
						message: posted,
					}),
				]);
				return posted;
			}),
		);
	});

/** `member` types for a moment, then posts `text`. */
const typeAndPost = (member: Member, inChat: PlacedChatRow, text: string) =>
	Effect.gen(function* () {
		yield* showTyping(inChat, member);
		yield* wait(TYPING);
		yield* postAs(member, inChat, text);
	});

/** `reactor` reacts to the message, and the chat hears its reactions as they now are. */
const react = (reactor: Member, inChat: PlacedChatRow, messageId: string, emoji: string) =>
	Effect.gen(function* () {
		const { emit } = yield* ChatEvents.Service;
		yield* transaction(
			Effect.gen(function* () {
				yield* query((db) =>
					db
						.insert(messageReaction)
						.values({ messageId, memberId: reactor.id, emoji })
						.onConflictDoNothing(),
				);
				const rows = yield* query((db) =>
					db
						.select({
							emoji: messageReaction.emoji,
							createdAt: messageReaction.createdAt,
							member: { id: member.id, name: member.name },
							bot: sql<null>`null`,
						})
						.from(messageReaction)
						.innerJoin(member, eq(member.id, messageReaction.memberId))
						.where(eq(messageReaction.messageId, messageId))
						.orderBy(messageReaction.createdAt),
				);
				yield* emit([
					ChatEvent.ReactionsChanged({
						chatId: inChat.id,
						messageId,
						reactions: toReactions(rows),
					}),
				]);
			}),
		);
	});

/** The bot starts its turn on `triggerMessageId`, for `reason`: a reply with nothing in it yet. */
const startReply = (
	bot: BotRow,
	inChat: PlacedChatRow,
	triggerMessageId: string,
	reason: TurnReason = "default",
) =>
	Effect.gen(function* () {
		const { emit } = yield* ChatEvents.Service;
		return yield* transaction(
			Effect.gen(function* () {
				const [started] = yield* query((db) =>
					db
						.insert(turn)
						.values({
							chatId: inChat.id,
							botId: bot.id,
							triggerMessageId,
							status: "running",
							executionId: STAGED_EXECUTION_ID,
							model: bot.model ?? "",
							reason,
							startedAt: new Date(),
						})
						.returning(),
				);
				if (!started) return yield* Effect.die(new Error("The turn wasn't written"));
				const [replyRow] = yield* query((db) =>
					db
						.insert(message)
						.values({
							chatId: inChat.id,
							authorBotId: bot.id,
							status: "writing",
							parts: [],
							content: "",
							turnId: started.id,
						})
						.returning(),
				);
				if (!replyRow) return yield* Effect.die(new Error("The reply wasn't written"));
				yield* query((db) =>
					db
						.insert(chatParticipant)
						.values({ chatId: inChat.id, botId: bot.id })
						.onConflictDoNothing(),
				);
				yield* emit([
					ChatEvent.TurnStarted({
						chatId: inChat.id,
						workspaceId: inChat.workspaceId,
						turnId: started.id,
						botId: bot.id,
						reply: toMessage(replyRow, authorRow(null, bot)),
					}),
				]);
				const reply: Reply = {
					bot,
					chat: inChat,
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
	announce: (change: ToolCallChange) => ChatEvent,
	decidedByName: string | null = null,
) =>
	Effect.gen(function* () {
		const { emit } = yield* ChatEvents.Service;
		yield* transaction(
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db.update(toolCall).set(changes).where(eq(toolCall.id, callId)).returning(),
				);
				if (!row) return yield* Effect.die(new Error("A staged tool call went missing"));
				yield* emit([
					announce({
						chatId: row.chatId,
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
		connectorId?: string;
		remoteToolName?: string;
		writeOrDelete: boolean;
		awaitsApproval?: boolean;
	},
) =>
	Effect.gen(function* () {
		const { emit } = yield* ChatEvents.Service;
		return yield* transaction(
			Effect.gen(function* () {
				const [written] = yield* query((db) =>
					db
						.insert(toolCall)
						.values({
							chatId: reply.chat.id,
							messageId: reply.messageId,
							turnId: reply.turnId,
							tool: call.tool,
							sdkToolCallId: crypto.randomUUID(),
							connectorId: call.connectorId ?? null,
							connectorRevision: call.connectorId ? 1 : null,
							remoteToolName: call.remoteToolName ?? null,
							executionInput: call.input,
							input: call.input,
							writeOrDelete: call.writeOrDelete,
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
					ChatEvent.ToolCallStarted({
						chatId: written.chatId,
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
		ChatEvent.ToolCallFinished,
		decidedByName,
	);

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
					chatStream(reply.chat.id),
					streamEvent("message.delta", {
						chatId: reply.chat.id,
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
		const { emit } = yield* ChatEvents.Service;
		yield* say(reply, text);
		const content = textOf(reply.parts);
		yield* transaction(
			Effect.gen(function* () {
				yield* query((db) =>
					db.update(message).set({ status: "complete" }).where(eq(message.id, reply.messageId)),
				);
				const finishedAt = new Date();
				yield* query((db) =>
					db
						.update(turn)
						.set({ status: "done", finishedAt, contextCapacity: CONTEXT_CAPACITY })
						.where(eq(turn.id, reply.turnId)),
				);
				yield* emit([
					ChatEvent.TurnCompleted({
						chatId: reply.chat.id,
						workspaceId: reply.chat.workspaceId,
						turnId: reply.turnId,
						botId: reply.bot.id,
						messageId: reply.messageId,
						content,
						finishedAt,
						contextTokens: undefined,
						contextCapacity: CONTEXT_CAPACITY,
						readKeptFrom: null,
					}),
				]);
			}),
		);
		return content;
	});

/** Ticket Desk answers Anita's ask with a question, before it does anything. */
const playTicketDesk = (bot: BotRow, inChat: PlacedChatRow, triggerId: string) =>
	Effect.gen(function* () {
		yield* wait(BEFORE_REPLY_STARTS);
		const reply = yield* startReply(bot, inChat, triggerId);
		yield* finishReply(reply, TICKET_DESK.question);
	});

/**
 * Told to go ahead, Ticket Desk looks the charges up in Stripe, says what it
 * found, asks Billing Engineer why there were two, then asks to refund the
 * second. What it says stands apart from its calls, so the app shows it rather
 * than folding it into a call's line as narration.
 */
const playTicketDeskWork = (bot: BotRow, inChat: PlacedChatRow, triggerId: string) =>
	Effect.gen(function* () {
		const { emit } = yield* ChatEvents.Service;
		const [stripe] = yield* query((db) =>
			db
				.select({ id: connector.id })
				.from(connector)
				.where(
					and(
						eq(connector.projectId, defaultProjectIdOf(sql`${bot.id}::uuid`)),
						eq(connector.handle, STRIPE),
					),
				),
		);
		if (!stripe) return yield* Effect.die(new Error(`${bot.name} has no Stripe connector`));
		const stripeCall = (name: string) => ({
			tool: `${STRIPE}${CONNECTOR_TOOL_SEPARATOR}${name}`,
			connectorId: stripe.id,
			remoteToolName: name,
		});

		yield* wait(BEFORE_REPLY_STARTS);
		const reply = yield* startReply(bot, inChat, triggerId);
		yield* wait(BETWEEN_STEPS);
		const lookup = yield* callTool(reply, {
			...stripeCall(TICKET_DESK.lookup.tool),
			input: TICKET_DESK.lookup.input,
			writeOrDelete: false,
		});
		yield* wait(STRIPE_LOOKUP);
		yield* finishCall(lookup, TICKET_DESK.lookup.output);
		yield* say(reply, TICKET_DESK.found);
		yield* finishReply(reply, TICKET_DESK.ask);
		yield* wait(BEFORE_REPLY_STARTS);
		const billingEngineer = yield* botNamed(inChat.workspaceId, BILLING_ENGINEER.bot);
		const answering = yield* startReply(billingEngineer, inChat, reply.messageId, "collaboration");
		yield* playBillingEngineer(answering);
		yield* wait(BEFORE_REPLY_STARTS);
		const handBack = yield* startReply(bot, inChat, reply.messageId, "hand_back");
		yield* say(handBack, TICKET_DESK.handBack);
		yield* callTool(handBack, {
			...stripeCall(TICKET_DESK.refund.tool),
			input: TICKET_DESK.refund.input,
			writeOrDelete: true,
			awaitsApproval: true,
		});
		yield* transaction(
			Effect.gen(function* () {
				yield* query((db) =>
					db.update(turn).set({ status: "waiting" }).where(eq(turn.id, handBack.turnId)),
				);
				yield* emit([
					ChatEvent.TurnSuspended({
						chatId: inChat.id,
						workspaceId: inChat.workspaceId,
						turnId: handBack.turnId,
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
			writeOrDelete: true,
		});
		yield* wait(TEST_RUN);
		yield* finishCall(tests, BILLING_ENGINEER.tests.output);
		yield* wait(BETWEEN_STEPS);
		yield* writeIncident(reply);
		yield* wait(BETWEEN_STEPS);
		return yield* finishReply(reply, BILLING_ENGINEER.answer);
	});

/** Doreen mentions Anita in Support's handover chat, which marks Support in Anita's sidebar wherever she is. */
const cueMention = Effect.gen(function* () {
	const { workspace: showcaseWorkspace, owner } = yield* showcase;
	const support = yield* handoverChatOf(showcaseWorkspace.id);
	const asking = yield* memberNamed(showcaseWorkspace.id, MEMBERS.mention.member);
	yield* typeAndPost(asking, support, `@${handleFromName(owner.name)} ${MEMBERS.mention.text}`);
});

/**
 * Billing Engineer writes the incident up: the file, made as its file
 * tool makes one, and the `file_write` call that shows it under the reply.
 */
const writeIncident = (reply: Reply) =>
	Effect.gen(function* () {
		const authoring = yield* Files.Authoring;
		const { title, content } = BILLING_ENGINEER.incident;
		const input = { kind: "markdown", title, content };
		const call = yield* callTool(reply, { tool: FILE_WRITE_TOOL, input, writeOrDelete: true });
		const written = yield* authoring
			.create(
				{
					botId: reply.bot.id,
					chatId: reply.chat.id,
				},
				{ kind: "markdown", title, content },
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

/** What each bot in the story does when Anita starts a chat with it. */
const PARTS = new Map([[TICKET_DESK.bot as string, playTicketDesk]]);

/** What each bot in the story does when Anita answers it in its chat. */
const BOT_WORK = new Map([[TICKET_DESK.bot as string, playTicketDeskWork]]);

/** Who answers Anita when she writes in a project's chat, by the project's slug. */
const MEMBERS_PARTS = new Map([
	[
		SUPPORT_PROJECT,
		(inChat: PlacedChatRow) =>
			Effect.gen(function* () {
				const answering = yield* memberNamed(inChat.workspaceId, MEMBERS.closing.member);
				yield* typeAndPost(answering, inChat, MEMBERS.closing.text);
			}),
	],
]);

/**
 * The chat `chatId`, a project's chat or a bot's chat, with its
 * project's slug if it is in one, and its bot if it has one.
 */
const chatById = (chatId: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({
					chat: getColumns(placedChat),
					projectSlug: project.slug,
					bot: botTable,
				})
				.from(placedChat)
				.leftJoin(project, eq(project.id, placedChat.projectId))
				.leftJoin(botTable, eq(botTable.id, placedChat.botId))
				.where(eq(placedChat.id, chatId)),
		),
		([row]) => (row ? Effect.succeed(row) : Effect.die(new Error(`No chat ${chatId}`))),
	);

/**
 * Starts a chat with `botId` and posts the owner's message in it, as the API
 * does, prints them as it answers, then plays the bot's part in the chat,
 * answering the message.
 */
const start = (botId: string, messageId: string, text: string) =>
	Effect.gen(function* () {
		const { owner } = yield* showcase;
		const { emit } = yield* ChatEvents.Service;
		const [bot] = yield* query((db) => db.select().from(botTable).where(eq(botTable.id, botId)));
		if (!bot) return yield* Effect.die(new Error(`No bot ${botId}`));
		const started = yield* transaction(
			Effect.gen(function* () {
				const { id } = yield* query((db) =>
					seedChat(db, {
						workspaceId: bot.workspaceId,
						kind: "project_chat",
						botId: bot.id,
						startedById: owner.id,
						title: chatTitleFrom(text),
					}),
				);
				const row = yield* placedById(id);
				yield* query((db) =>
					db.insert(chatParticipant).values([
						{ chatId: id, memberId: owner.id },
						{ chatId: id, botId: bot.id },
					]),
				);
				yield* emit([ChatEvent.ChatStarted({ workspaceId: row.workspaceId, chatId: row.id })]);
				return row;
			}),
		);
		const posted = yield* postAs(owner, started, text, messageId);
		// The first line out is the start's answer, which the autopilot hands the page.
		console.log(JSON.stringify({ chat: toProjectChat(started), message: posted }));
		const part = PARTS.get(bot.name);
		if (part) yield* part(bot, started, messageId);
	});

/**
 * Posts the owner's message in the chat, prints it as the API answers
 * a send, then plays who answers her: in a project's chat its members, and in
 * a bot's chat that bot.
 */
const send = (chatId: string, messageId: string, text: string) =>
	Effect.gen(function* () {
		const { owner } = yield* showcase;
		const found = yield* chatById(chatId);
		const posted = yield* postAs(owner, found.chat, text, messageId);
		console.log(JSON.stringify(posted));
		if (found.bot) {
			const part = BOT_WORK.get(found.bot.name);
			if (part) yield* part(found.bot, found.chat, messageId);
			return;
		}
		const answer = found.projectSlug ? MEMBERS_PARTS.get(found.projectSlug) : undefined;
		if (answer) yield* answer(found.chat);
	});

/** The refund goes ahead: the decision, the call running and returning, and Ticket Desk's reply. */
const allow = (toolCallId: string) =>
	Effect.gen(function* () {
		const { owner } = yield* showcase;
		const [found] = yield* query((db) =>
			db
				.select({
					call: toolCall,
					chat: getColumns(placedChat),
					turn,
					bot: botTable,
					reply: message,
				})
				.from(toolCall)
				.innerJoin(placedChat, eq(placedChat.id, toolCall.chatId))
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
			chat: found.chat,
			turnId: found.turn.id,
			messageId: found.reply.id,
			parts: [...found.reply.parts],
		};
		yield* changeCall(
			toolCallId,
			{ approvalStatus: "allowed", decidedById: owner.id, decidedAt: new Date() },
			(change) =>
				ChatEvent.ToolCallDecided({
					...change,
					workspaceId: found.chat.workspaceId,
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
			ChatEvent.ToolCallExecuting,
			owner.name,
		);
		yield* wait(STRIPE_REFUND);
		yield* finishCall(toolCallId, TICKET_DESK.refund.output, owner.name);
		yield* wait(BETWEEN_STEPS);
		yield* finishReply(reply, TICKET_DESK.reply);

		const lorraine = yield* memberNamed(found.chat.workspaceId, MEMBERS.thanks.member);
		yield* showTyping(found.chat, lorraine);
		yield* wait(BETWEEN_STEPS);
		yield* react(lorraine, found.chat, reply.messageId, MEMBERS.thanks.emoji);
		yield* wait(TYPING);
		yield* postAs(lorraine, found.chat, MEMBERS.thanks.text);
	});

/**
 * Takes the story back to where it starts: what the seed wrote. The chats
 * started with the story's bots since go, the files made in them included, and so does what was said in Support's handover chat since; and
 * Support's members have read what's left there.
 */
const reset = Effect.gen(function* () {
	const { workspace: showcaseWorkspace } = yield* showcase;
	const seeded = showcaseWorkspace.setUpAt;
	if (!seeded)
		return yield* Effect.die(new Error("The showcase isn't seeded as the story expects"));
	const support = yield* handoverChatOf(showcaseWorkspace.id);
	const storyBots = yield* Effect.forEach([...PARTS.keys()], (name) =>
		Effect.map(botNamed(showcaseWorkspace.id, name), (bot) => bot.id),
	);
	const removed = yield* transaction(
		Effect.gen(function* () {
			const started = yield* query((db) =>
				db
					.select({ id: placedChat.id })
					.from(placedChat)
					.where(
						and(
							eq(placedChat.kind, "project_chat"),
							inArray(placedChat.botId, storyBots),
							gt(placedChat.createdAt, seeded),
						),
					),
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
									file.chatId,
									db
										.select({ id: chat.id })
										.from(chat)
										.where(eq(chat.workspaceId, showcaseWorkspace.id)),
								),
								gt(file.createdAt, seeded),
							),
						),
				);
				// A chat's messages, turns and calls go with it.
				yield* query((db) => db.delete(chat).where(inArray(chat.id, startedIds)));
			}
			const gone = yield* query((db) =>
				db
					.delete(message)
					.where(and(eq(message.chatId, support.id), gt(message.createdAt, seeded)))
					.returning({ id: message.id }),
			);
			const readers = yield* query((db) =>
				db
					.select({ memberId: projectMember.memberId })
					.from(projectMember)
					.where(eq(projectMember.projectId, support.projectId ?? "")),
			);
			const now = new Date();
			if (readers.length > 0) {
				yield* query((db) =>
					db
						.insert(readCursor)
						.values(
							readers.map((reader) => ({
								...reader,
								chatId: support.id,
								readThrough: now,
							})),
						)
						.onConflictDoUpdate({
							target: [readCursor.memberId, readCursor.chatId],
							set: { readThrough: now },
						}),
				);
			}
			return { chats: startedIds.length, messages: gone.length };
		}),
	);
	console.log(
		`The story is back at its start (${removed.chats} chats and ${removed.messages} messages removed).`,
	);
});

/**
 * Gives every showcase connector a placeholder credential, so the connectors
 * page shows them signed in. Only for a throwaway capture database: the
 * credentials open nothing, and a turn that used them would fail.
 */
const signInConnectors = Effect.gen(function* () {
	const secrets = yield* Secrets.Service;
	const { workspace: showcaseWorkspace } = yield* showcase;
	const record = { tokens: { access_token: "showcase-placeholder", token_type: "Bearer" } };
	const signedIn = yield* query((db) =>
		db
			.update(connector)
			.set({ oauthEncrypted: secrets.encrypt(JSON.stringify(record)) })
			.where(and(eq(connector.workspaceId, showcaseWorkspace.id), eq(connector.authKind, "oauth")))
			.returning({ id: connector.id }),
	);
	console.log(`Signed in ${signedIn.length} connectors with placeholder credentials.`);
});

/** Only the chat event stream hears what the stage emits: it is what tells the open page. */
const chatEvents = Layer.effect(
	ChatEvents.Service,
	Effect.map(EventOutbox.Service, (outbox) =>
		ChatEvents.Service.of({
			emit: DomainEvents.emitTo<ChatEvent>([ChatEventStream.handler(outbox)]),
		}),
	),
);

const USAGE =
	"Usage: stage.ts reset | start <botId> <messageId> <text> | send <chatId> <messageId> <text> | allow <toolCallId> | cue mention | sign-in-connectors";
const [command, ...args] = process.argv.slice(2);

const program = Effect.gen(function* () {
	const serverSettings = yield* ServerSettings.Service;
	if (serverSettings.isProduction) {
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
	if (command === "sign-in-connectors") return yield* signInConnectors;
	return yield* Effect.die(new Error(USAGE));
});

program.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(chatEvents, Files.authoringLayer.pipe(Layer.provide(BlobStore.layer))).pipe(
			Layer.provideMerge(EventOutbox.layer),
			Layer.provideMerge(EventBus.layer),
			Layer.provideMerge(EventStore.layer),
			Layer.provideMerge(Ids.layer),
			Layer.provideMerge(Secrets.layer),
			Layer.provideMerge(ServerSettings.layer),
			Layer.provideMerge(databaseLayer),
		),
	),
	NodeRuntime.runMain,
);

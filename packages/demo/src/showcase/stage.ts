import { NodeRuntime } from "@effect/platform-node";
import type { JsonValue, Message } from "@sugabots/contracts";
import {
	CONNECTION_TOOL_SEPARATOR,
	handleFromName,
	streamEvent,
	threadChannel,
} from "@sugabots/contracts";
import { Artifacts } from "@sugabots/core/artifacts/artifacts";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { ConversationEvents } from "@sugabots/core/conversations/conversation-events";
import { ConversationEvent, type ToolCallChange } from "@sugabots/core/conversations/events";
import { ThreadFeed } from "@sugabots/core/conversations/thread-feed";
import { toCollaborationPart } from "@sugabots/core/conversations/threads/collaboration-parts";
import {
	type ParticipantRow,
	personAuthor,
	toMessage,
	toPerson,
	toReactions,
} from "@sugabots/core/conversations/threads/participants";
import { toToolCallPart } from "@sugabots/core/conversations/threads/tool-calls";
import { ARTIFACT_WRITE_TOOL } from "@sugabots/core/conversations/tools/artifacts/tool";
import { Credentials } from "@sugabots/core/credentials/credentials";
import { layer as databaseLayer, query, transaction } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import { DomainEvents } from "@sugabots/core/database/events/domain-events";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import { EventStore } from "@sugabots/core/database/events/store";
import {
	type AgentRow,
	agent,
	artifact,
	chat,
	collaboration,
	connection,
	message,
	messageReaction,
	pod,
	podMember,
	type StoredMessagePart,
	type ThreadRow,
	thread,
	threadParticipant,
	threadRead,
	toolCall,
	turn,
	user,
	workspace,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { Ids } from "@sugabots/core/ids/ids";
import { Installation } from "@sugabots/core/installation/installation";
import { and, desc, eq, gt, inArray, isNotNull, max } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { STAGED_TURN_OWNER } from "./conversations.ts";

/**
 * Plays the demo video's story in the showcase seed (see `seed.ts`),
 * where no model runs: the bots' replies are staged, written as the app
 * writes them and announced on its event stream, so a running server shows
 * them on the open page as it would real ones.
 *
 *   node --env-file=.env packages/demo/src/showcase/stage.ts reset
 *   node --env-file=.env packages/demo/src/showcase/stage.ts send <chatId> <messageId> bot|people <text>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts allow <toolCallId>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts cue review
 *
 * `reset` takes the story's chats back to where it starts. `send` posts the
 * owner's message to a chat, prints it as the API would answer, then plays
 * what follows: the bot's part, or the people's when it was to them only.
 * `allow` plays what follows an allowed approval, and `cue review` has the
 * engineers answer Code Reviewer when the demo is looking.
 *
 * The story: Ticket Desk's morning queue flagged Kestrel Freight's double charge.
 * Anita asks Ticket Desk to refund it, and Code Reviewer why it happened.
 * Ticket Desk checks Stripe and asks to refund; Code Reviewer runs the tests
 * in its sandbox, asks Researcher about Stripe's retries and writes the
 * incident up. Each finishes while Anita is in the other chat, and the pods'
 * people answer as she goes.
 */

const WORKSPACE_SLUG = "fieldnote";

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
		"Found two charges of $1,280 on 3 Oct, a minute apart, so I refunded the second. It should reach their card in 5 to 10 days, and I've replied on the ticket to let them know.",
} as const;

const CODE_REVIEWER = {
	bot: "Code Reviewer",
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
	collaborator: "Researcher",
	collaborationTitle: "Stripe retries and idempotency keys",
	brief:
		"Our billing job retries a charge when Stripe times out. Does Stripe treat the retry as a new charge if the request has no idempotency key?",
	answer:
		"Yes. Without an Idempotency-Key header, Stripe treats every request as new, even an identical retry. Send the same key and a retry within 24 hours returns the original charge instead of making another.",
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
	reply:
		"Found it. When a charge to Stripe times out, the billing job retries it without an idempotency key, so Stripe takes the retry as a second charge. That's what happened to Kestrel on 3 Oct. The fix is to pass the invoice id as the idempotency key in `chargeInvoice`: I've opened #491 with it, and written the incident up.",
} as const;

/** What the pods' people do while Anita works through the story. */
const PEOPLE = {
	/** Lorraine, in Support, once the refund is through. */
	thanks: { person: "Lorraine Delgado", emoji: "🙏", text: "Thanks! I'll let Kestrel know." },
	/** Gary and Rob, in Engineering, once Code Reviewer has explained. */
	review: {
		person: "Gary Lum",
		text: "Nice catch. I'll review #491 this afternoon.",
		reactor: "Rob Mendoza",
		emoji: "👀",
	},
	/** Lorraine, in Support, asking Anita what to tell Kestrel: written after Anita's handle. */
	mention: {
		person: "Lorraine Delgado",
		text: "Kestrel are asking whether this could happen again. Anything I can tell them?",
	},
	/** Lorraine again, answering Anita's wrap-up. */
	closing: { person: "Lorraine Delgado", text: "Great, I've closed the ticket with Kestrel." },
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
				.from(agent)
				.where(and(eq(agent.workspaceId, workspaceId), eq(agent.name, name))),
		),
		([row]) => (row ? Effect.succeed(row) : Effect.die(new Error(`No bot named ${name}`))),
	);

/** The bot's chat in its pod, with its main thread. */
const chatOf = (bot: AgentRow) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ chat, thread })
				.from(chat)
				.innerJoin(thread, eq(thread.id, chat.mainThreadId))
				.where(eq(chat.hostAgentId, bot.id)),
		),
		([row]) => (row ? Effect.succeed(row) : Effect.die(new Error(`${bot.name} has no chat`))),
	);

function agentAuthor(bot: AgentRow): ParticipantRow {
	return {
		userId: null,
		userName: null,
		userEmail: null,
		userImage: null,
		agentId: bot.id,
		agentName: bot.name,
		agentHandle: bot.handle,
		agentColor: bot.color,
		agentFace: bot.face,
		agentShape: bot.shape,
	};
}

/** Where a reply is being written: its thread, turn and message, and its parts so far. */
interface Reply {
	readonly bot: AgentRow;
	readonly thread: ThreadRow;
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

/** Shows `person` typing in the thread, as their composer would. */
const showTyping = (inThread: ThreadRow, person: Person) =>
	Effect.gen(function* () {
		const bus = yield* EventBus.Service;
		yield* Effect.promise(() =>
			bus.publish(
				threadChannel(inThread.id),
				streamEvent("person.typing", { threadId: inThread.id, person: toPerson(person) }),
			),
		);
	});

/** `person` posts `text` in the thread, announced as a sent message is. */
const postAs = (
	person: Person,
	inThread: ThreadRow,
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
							threadId: inThread.id,
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
						.insert(threadParticipant)
						.values({ threadId: inThread.id, userId: person.id })
						.onConflictDoNothing(),
				);
				const posted: Message = toMessage(row, personAuthor(person));
				yield* emit([
					ConversationEvent.MessagePosted({
						threadId: inThread.id,
						workspaceId: inThread.workspaceId,
						podId: inThread.podId,
						message: posted,
					}),
				]);
				return posted;
			}),
		);
	});

/** `person` types for a moment, then posts `text`. */
const typeAndPost = (person: Person, inThread: ThreadRow, text: string) =>
	Effect.gen(function* () {
		yield* showTyping(inThread, person);
		yield* wait(TYPING);
		yield* postAs(person, inThread, text);
	});

/** `person` reacts to the message, and the thread hears its reactions as they now are. */
const react = (person: Person, inThread: ThreadRow, messageId: string, emoji: string) =>
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
						threadId: inThread.id,
						messageId,
						reactions: toReactions(rows),
					}),
				]);
			}),
		);
	});

/** The bot starts its turn on `triggerMessageId`: a reply with nothing in it yet. */
const startReply = (bot: AgentRow, inThread: ThreadRow, triggerMessageId: string) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		return yield* transaction(
			Effect.gen(function* () {
				const [started] = yield* query((db) =>
					db
						.insert(turn)
						.values({
							threadId: inThread.id,
							agentId: bot.id,
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
							threadId: inThread.id,
							authorAgentId: bot.id,
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
						.insert(threadParticipant)
						.values({ threadId: inThread.id, agentId: bot.id })
						.onConflictDoNothing(),
				);
				yield* emit([
					ConversationEvent.TurnStarted({
						threadId: inThread.id,
						turnId: started.id,
						agentId: bot.id,
						reply: toMessage(replyRow, agentAuthor(bot)),
					}),
				]);
				const reply: Reply = {
					bot,
					thread: inThread,
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
						threadId: row.threadId,
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
							threadId: reply.thread.id,
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
							atOffset: 0,
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
						threadId: written.threadId,
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

/** The reply's text, typed in a few words at a time, then the turn completed. */
const finishReply = (reply: Reply, text: string) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		const bus = yield* EventBus.Service;
		const words = text.split(/(?<= )/);
		let written = "";
		for (let start = 0; start < words.length; start += WORDS_PER_DELTA) {
			const delta = words.slice(start, start + WORDS_PER_DELTA).join("");
			yield* Effect.promise(() =>
				bus.publish(
					threadChannel(reply.thread.id),
					streamEvent("message.delta", {
						threadId: reply.thread.id,
						messageId: reply.messageId,
						offset: written.length,
						text: delta,
					}),
				),
			);
			written += delta;
			yield* wait(DELTA_MILLISECONDS);
		}
		yield* transaction(
			Effect.gen(function* () {
				yield* query((db) =>
					db
						.update(message)
						.set({
							parts: [...reply.parts, { type: "text", text }],
							content: text,
							status: "complete",
						})
						.where(eq(message.id, reply.messageId)),
				);
				yield* query((db) =>
					db
						.update(turn)
						.set({ status: "done", finishedAt: new Date(), contextCapacity: CONTEXT_CAPACITY })
						.where(eq(turn.id, reply.turnId)),
				);
				yield* emit([
					ConversationEvent.TurnCompleted({
						threadId: reply.thread.id,
						workspaceId: reply.thread.workspaceId,
						podId: reply.thread.podId,
						turnId: reply.turnId,
						agentId: reply.bot.id,
						reason: "default",
						messageId: reply.messageId,
						content: text,
						contextTokens: undefined,
						contextCapacity: CONTEXT_CAPACITY,
						readKeptFrom: null,
						answeredCollaboration: false,
					}),
				]);
			}),
		);
	});

/**
 * The reply asks `collaborator` for help: the bots' own thread under it, the
 * brief, the collaborator's answer typed in there, and the answer recorded.
 */
const collaborate = (
	reply: Reply,
	collaborator: AgentRow,
	ask: { title: string; brief: string; answer: string },
) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		const [recipient] = yield* query((db) =>
			db.select({ id: chat.id }).from(chat).where(eq(chat.hostAgentId, collaborator.id)),
		);
		const opened = yield* transaction(
			Effect.gen(function* () {
				const [child] = yield* query((db) =>
					db
						.insert(thread)
						.values({
							workspaceId: reply.thread.workspaceId,
							podId: reply.thread.podId,
							hostAgentId: collaborator.id,
							chatId: reply.thread.chatId,
							type: "collaboration",
							title: ask.title,
							parentThreadId: reply.thread.id,
							initiatorUserId: reply.thread.initiatorUserId,
						})
						.returning(),
				);
				if (!child) return yield* Effect.die(new Error("The collaboration wasn't opened"));
				yield* query((db) =>
					db.insert(threadParticipant).values([
						{ threadId: child.id, agentId: reply.bot.id },
						{ threadId: child.id, agentId: collaborator.id },
					]),
				);
				const [briefRow] = yield* query((db) =>
					db
						.insert(message)
						.values({
							threadId: child.id,
							authorAgentId: reply.bot.id,
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
							parentThreadId: reply.thread.id,
							parentMessageId: reply.messageId,
							turnId: reply.turnId,
							childThreadId: child.id,
							collaboratorAgentId: collaborator.id,
							brief: ask.brief,
							status: "waiting",
							atOffset: 0,
						})
						.returning(),
				);
				if (!row) return yield* Effect.die(new Error("The collaboration wasn't written"));
				reply.parts.push({ type: "collaboration", collaborationId: row.id });
				yield* saveParts(reply);
				yield* emit([
					ConversationEvent.CollaborationOpened({
						parentThreadId: reply.thread.id,
						parentMessageId: reply.messageId,
						collaboration: toCollaborationPart(row, collaborator.name),
						workspaceId: reply.thread.workspaceId,
						podId: reply.thread.podId,
						recipientChatId: recipient?.id ?? null,
						collaboratorAgentId: collaborator.id,
						briefMessageId: briefRow.id,
					}),
				]);
				return { child, briefId: briefRow.id, collaborationId: row.id };
			}),
		);
		yield* wait(BETWEEN_STEPS);
		const answering = yield* startReply(collaborator, opened.child, opened.briefId);
		yield* finishReply(answering, ask.answer);
		yield* transaction(
			Effect.gen(function* () {
				const [answered] = yield* query((db) =>
					db
						.update(collaboration)
						.set({ status: "answered", answer: ask.answer })
						.where(eq(collaboration.id, opened.collaborationId))
						.returning(),
				);
				if (!answered) return yield* Effect.die(new Error("The collaboration went missing"));
				yield* emit([
					ConversationEvent.CollaborationAnswered({
						parentThreadId: reply.thread.id,
						parentMessageId: reply.messageId,
						collaboration: toCollaborationPart(answered, collaborator.name),
						askingAgentId: reply.bot.id,
						askerMovedOn: false,
					}),
				]);
			}),
		);
	});

/** Ticket Desk looks the charges up in Stripe, then asks to refund the second. */
const playTicketDesk = (bot: AgentRow, inThread: ThreadRow, triggerId: string) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		const [stripe] = yield* query((db) =>
			db
				.select({ id: connection.id })
				.from(connection)
				.where(and(eq(connection.podId, inThread.podId), eq(connection.handle, STRIPE))),
		);
		if (!stripe) return yield* Effect.die(new Error("Support has no Stripe connection"));
		const stripeCall = (name: string) => ({
			tool: `${STRIPE}${CONNECTION_TOOL_SEPARATOR}${name}`,
			connectionId: stripe.id,
			remoteToolName: name,
		});

		yield* wait(BEFORE_REPLY_STARTS);
		const reply = yield* startReply(bot, inThread, triggerId);
		yield* wait(BETWEEN_STEPS);
		const lookup = yield* callTool(reply, {
			...stripeCall(TICKET_DESK.lookup.tool),
			input: TICKET_DESK.lookup.input,
			mutating: false,
		});
		yield* wait(STRIPE_LOOKUP);
		yield* finishCall(lookup, TICKET_DESK.lookup.output);
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
						threadId: inThread.id,
						workspaceId: inThread.workspaceId,
						podId: inThread.podId,
						turnId: reply.turnId,
					}),
				]);
			}),
		);
	});

/** Code Reviewer runs the billing tests in its sandbox, asks Researcher about Stripe, and explains. */
const playCodeReviewer = (bot: AgentRow, inThread: ThreadRow, triggerId: string) =>
	Effect.gen(function* () {
		yield* wait(BEFORE_REPLY_STARTS);
		const reply = yield* startReply(bot, inThread, triggerId);
		yield* wait(BETWEEN_STEPS);
		const tests = yield* callTool(reply, {
			tool: "run_command",
			input: CODE_REVIEWER.tests.input,
			mutating: true,
		});
		yield* wait(TEST_RUN);
		yield* finishCall(tests, CODE_REVIEWER.tests.output);
		yield* wait(BETWEEN_STEPS);
		const researcher = yield* botNamed(inThread.workspaceId, CODE_REVIEWER.collaborator);
		yield* collaborate(reply, researcher, {
			title: CODE_REVIEWER.collaborationTitle,
			brief: CODE_REVIEWER.brief,
			answer: CODE_REVIEWER.answer,
		});
		yield* wait(BETWEEN_STEPS);
		yield* writeIncident(reply);
		yield* wait(BETWEEN_STEPS);
		yield* finishReply(reply, CODE_REVIEWER.reply);
	});

/**
 * Gary answers Code Reviewer, and Rob reacts to it. Cued by the demo rather
 * than timed, so it happens while Anita is looking at the chat.
 */
const cueReview = Effect.gen(function* () {
	const { workspace: showcaseWorkspace } = yield* showcase;
	const codeReviewer = yield* chatOf(yield* botNamed(showcaseWorkspace.id, CODE_REVIEWER.bot));
	const [latest] = yield* query((db) =>
		db
			.select({ id: message.id })
			.from(message)
			.innerJoin(agent, eq(agent.id, message.authorAgentId))
			.where(and(eq(message.threadId, codeReviewer.thread.id), eq(agent.name, CODE_REVIEWER.bot)))
			.orderBy(desc(message.createdAt))
			.limit(1),
	);
	if (!latest) return yield* Effect.die(new Error("Code Reviewer hasn't replied yet"));
	const reviewer = yield* personNamed(showcaseWorkspace.id, PEOPLE.review.person);
	yield* typeAndPost(reviewer, codeReviewer.thread, PEOPLE.review.text);
	const reactor = yield* personNamed(showcaseWorkspace.id, PEOPLE.review.reactor);
	yield* react(reactor, codeReviewer.thread, latest.id, PEOPLE.review.emoji);
});

/** Lorraine mentions Anita in Support, which brings it to Anita's Activity wherever she is. */
const cueMention = Effect.gen(function* () {
	const { workspace: showcaseWorkspace, owner } = yield* showcase;
	const support = yield* chatOf(yield* botNamed(showcaseWorkspace.id, TICKET_DESK.bot));
	const asking = yield* personNamed(showcaseWorkspace.id, PEOPLE.mention.person);
	yield* typeAndPost(
		asking,
		support.thread,
		`@${handleFromName(owner.name)} ${PEOPLE.mention.text}`,
	);
});

/**
 * Code Reviewer writes the incident up: the artifact, made as its artifact
 * tool makes one, and the `artifact_write` call that shows it under the reply.
 */
const writeIncident = (reply: Reply) =>
	Effect.gen(function* () {
		const authoring = yield* Artifacts.Authoring;
		const { title, content } = CODE_REVIEWER.incident;
		const input = { kind: "document", title, content };
		const call = yield* callTool(reply, { tool: ARTIFACT_WRITE_TOOL, input, mutating: true });
		const written = yield* authoring
			.create(
				{
					workspaceId: reply.thread.workspaceId,
					podId: reply.thread.podId,
					agentId: reply.bot.id,
					threadId: reply.thread.id,
				},
				{ kind: "document", title, content },
			)
			.pipe(Effect.orDie);
		yield* wait(BETWEEN_STEPS);
		yield* finishCall(call, {
			status: "written",
			artifactId: written.id,
			kind: written.kind,
			title: written.title,
			version: written.version,
		});
	});

/** What each bot in the story does when Anita writes to it. */
const PARTS = new Map([
	[TICKET_DESK.bot as string, playTicketDesk],
	[CODE_REVIEWER.bot as string, playCodeReviewer],
]);

/** What happens when Anita writes to a chat's people only: who answers her. */
const PEOPLE_PARTS = new Map([
	[
		TICKET_DESK.bot as string,
		(inThread: ThreadRow) =>
			Effect.gen(function* () {
				const answering = yield* personNamed(inThread.workspaceId, PEOPLE.closing.person);
				yield* typeAndPost(answering, inThread, PEOPLE.closing.text);
			}),
	],
]);

/**
 * Posts the owner's message to the chat, prints it as the API answers a send,
 * then plays what follows: the bot's part, or with `toPeople`, the people's.
 */
const send = (chatId: string, messageId: string, text: string, toPeople: boolean) =>
	Effect.gen(function* () {
		const { owner } = yield* showcase;
		const [found] = yield* query((db) =>
			db
				.select({ thread, bot: agent })
				.from(chat)
				.innerJoin(thread, eq(thread.id, chat.mainThreadId))
				.innerJoin(agent, eq(agent.id, chat.hostAgentId))
				.where(eq(chat.id, chatId)),
		);
		if (!found) return yield* Effect.die(new Error(`No chat ${chatId}`));
		const posted = yield* postAs(owner, found.thread, text, messageId);
		// The first line out is the send's answer, which the autopilot hands the page.
		console.log(JSON.stringify(posted));
		if (toPeople) {
			const answer = PEOPLE_PARTS.get(found.bot.name);
			if (answer) yield* answer(found.thread);
			return;
		}
		const part = PARTS.get(found.bot.name);
		if (part) yield* part(found.bot, found.thread, messageId);
	});

/** The refund goes ahead: the decision, the call running and returning, and Ticket Desk's reply. */
const allow = (toolCallId: string) =>
	Effect.gen(function* () {
		const { owner } = yield* showcase;
		const [found] = yield* query((db) =>
			db
				.select({ call: toolCall, thread, turn, bot: agent, reply: message })
				.from(toolCall)
				.innerJoin(thread, eq(thread.id, toolCall.threadId))
				.innerJoin(turn, eq(turn.id, toolCall.turnId))
				.innerJoin(agent, eq(agent.id, turn.agentId))
				.innerJoin(message, eq(message.id, toolCall.messageId))
				.where(eq(toolCall.id, toolCallId)),
		);
		if (found?.call.status !== "awaiting_approval") {
			return yield* Effect.die(new Error("That call isn't waiting for approval"));
		}
		const reply: Reply = {
			bot: found.bot,
			thread: found.thread,
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
					workspaceId: found.thread.workspaceId,
					podId: found.thread.podId,
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

		const lorraine = yield* personNamed(found.thread.workspaceId, PEOPLE.thanks.person);
		yield* showTyping(found.thread, lorraine);
		yield* wait(BETWEEN_STEPS);
		yield* react(lorraine, found.thread, reply.messageId, PEOPLE.thanks.emoji);
		yield* wait(TYPING);
		yield* postAs(lorraine, found.thread, PEOPLE.thanks.text);
	});

/**
 * Takes the story's chats back to where it starts: Ticket Desk's ends with
 * the morning queue's result, and Code Reviewer's with what the seed wrote.
 * Everything after goes, the collaborations and artifacts it made included,
 * and the pods' people have read what's left.
 */
const reset = Effect.gen(function* () {
	const { workspace: showcaseWorkspace } = yield* showcase;
	const ticketDesk = yield* chatOf(yield* botNamed(showcaseWorkspace.id, TICKET_DESK.bot));
	const codeReviewer = yield* chatOf(yield* botNamed(showcaseWorkspace.id, CODE_REVIEWER.bot));
	const [morningQueue] = yield* query((db) =>
		db
			.select({ at: max(message.createdAt) })
			.from(message)
			.where(
				and(eq(message.threadId, ticketDesk.thread.id), isNotNull(message.routineExecutionId)),
			),
	);
	const seeded = showcaseWorkspace.setupCompletedAt;
	if (!morningQueue?.at || !seeded) {
		return yield* Effect.die(new Error("The showcase isn't seeded as the story expects"));
	}
	const starts = [
		{ threadId: ticketDesk.thread.id, after: morningQueue.at },
		{ threadId: codeReviewer.thread.id, after: seeded },
	];
	const removed = yield* transaction(
		Effect.gen(function* () {
			let count = 0;
			for (const { threadId, after } of starts) {
				yield* query((db) =>
					db
						.delete(artifact)
						.where(and(eq(artifact.createdInThreadId, threadId), gt(artifact.createdAt, after))),
				);
				yield* query((db) =>
					db
						.delete(thread)
						.where(and(eq(thread.parentThreadId, threadId), gt(thread.createdAt, after))),
				);
				const gone = yield* query((db) =>
					db
						.delete(message)
						.where(and(eq(message.threadId, threadId), gt(message.createdAt, after)))
						.returning({ id: message.id }),
				);
				count += gone.length;
			}
			const readers = yield* query((db) =>
				db
					.select({ threadId: thread.id, userId: podMember.userId })
					.from(thread)
					.innerJoin(pod, eq(pod.id, thread.podId))
					.innerJoin(podMember, eq(podMember.podId, pod.id))
					.where(
						inArray(
							thread.id,
							starts.map(({ threadId }) => threadId),
						),
					),
			);
			const now = new Date();
			if (readers.length > 0) {
				yield* query((db) =>
					db
						.insert(threadRead)
						.values(readers.map((reader) => ({ ...reader, readThrough: now })))
						.onConflictDoUpdate({
							target: [threadRead.userId, threadRead.threadId],
							set: { readThrough: now },
						}),
				);
			}
			return count;
		}),
	);
	console.log(`The story is back at its start (${removed} later messages removed).`);
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

/** Only the thread feed hears what the stage emits: it is what tells the open page. */
const conversationEvents = Layer.effect(
	ConversationEvents.Service,
	Effect.map(EventOutbox.Service, (outbox) =>
		ConversationEvents.Service.of({
			emit: DomainEvents.emitTo<ConversationEvent>([ThreadFeed.handler(outbox)]),
		}),
	),
);

const USAGE =
	"Usage: stage.ts reset | send <chatId> <messageId> bot|people <text> | allow <toolCallId> | cue review|mention | sign-in-connections";
const [command, ...args] = process.argv.slice(2);

const program = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	if (installation.isProduction) {
		return yield* Effect.die(new Error("The showcase stage cannot run in production."));
	}
	const [first = "", second = "", audience = "", ...words] = args;
	if (command === "reset") return yield* reset;
	if (command === "send" && first && second && words.length > 0) {
		return yield* send(first, second, words.join(" "), audience === "people");
	}
	if (command === "allow" && first) return yield* allow(first);
	if (command === "cue" && first === "review") return yield* cueReview;
	if (command === "cue" && first === "mention") return yield* cueMention;
	if (command === "sign-in-connections") return yield* signInConnections;
	return yield* Effect.die(new Error(USAGE));
});

program.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(
			conversationEvents,
			Artifacts.authoringLayer.pipe(Layer.provide(BlobStore.layer)),
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

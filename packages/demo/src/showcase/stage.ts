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
import { toConversationThread } from "@sugabots/core/conversations/chats/conversation";
import { threadTitleFrom } from "@sugabots/core/conversations/chats/thread-title";
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
import { and, eq, gt, inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { STAGED_TURN_OWNER } from "./conversations.ts";

/**
 * Plays the demo video's story in the showcase seed (see `seed.ts`),
 * where no model runs: the bots' replies are staged, written as the app
 * writes them and announced on its event stream, so a running server shows
 * them on the open page as it would real ones.
 *
 *   node --env-file=.env packages/demo/src/showcase/stage.ts reset
 *   node --env-file=.env packages/demo/src/showcase/stage.ts start <podChatId> <messageId> <botId> <text>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts send <conversationId> <messageId> <text>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts allow <toolCallId>
 *   node --env-file=.env packages/demo/src/showcase/stage.ts cue mention
 *
 * `reset` takes Support's chat back to where the story starts. `start` posts
 * the owner's message in a pod's chat and starts a thread from it with the
 * bot it mentions, prints them as the API would answer, then plays the
 * bot's part in the thread. `send` posts the owner's message in a pod's chat
 * or a thread, and plays whoever answers her there. `allow` plays what follows an allowed
 * approval, and `cue mention` has Doreen ask Anita something when the demo
 * is looking.
 *
 * The story: Ticket Desk's morning queue, in Support's chat, flagged Kestrel
 * Freight's double charge. Anita starts a thread from it asking Ticket Desk
 * to refund it, and Ticket Desk offers to find out why too. Told to go ahead,
 * it checks Stripe and hands the why to Billing Engineer, which runs the
 * billing tests in its sandbox and writes the incident up; then it asks to
 * refund. Support's people answer as she goes.
 */

const WORKSPACE_SLUG = "fieldnote";
/** The pod whose chat the story is told in, by slug. */
const SUPPORT_POD = "support";

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
	/** Lorraine, in the thread, once the refund is through. */
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
				.from(agent)
				.where(and(eq(agent.workspaceId, workspaceId), eq(agent.name, name))),
		),
		([row]) => (row ? Effect.succeed(row) : Effect.die(new Error(`No bot named ${name}`))),
	);

/** The chat of the showcase pod whose slug is `podSlug`, which every shared pod has. */
const podChatOf = (workspaceId: string, podSlug: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ thread })
				.from(thread)
				.innerJoin(pod, eq(pod.id, thread.podId))
				.where(and(eq(pod.workspaceId, workspaceId), eq(pod.slug, podSlug), eq(thread.main, true))),
		),
		([row]) => (row ? Effect.succeed(row.thread) : Effect.die(new Error(`${podSlug} has no chat`))),
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
					threadChannel(reply.thread.id),
					streamEvent("message.delta", {
						threadId: reply.thread.id,
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
						threadId: reply.thread.id,
						workspaceId: reply.thread.workspaceId,
						podId: reply.thread.podId,
						turnId: reply.turnId,
						agentId: reply.bot.id,
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
 * The reply asks `collaborator` for help: the bots' own thread under it, the
 * brief, the collaborator's turn there played by `answer`, and what it said
 * recorded as the answer.
 */
const collaborate = <E, R>(
	reply: Reply,
	collaborator: AgentRow,
	ask: { title: string; brief: string },
	answer: (answering: Reply) => Effect.Effect<string, E, R>,
) =>
	Effect.gen(function* () {
		const { emit } = yield* ConversationEvents.Service;
		const opened = yield* transaction(
			Effect.gen(function* () {
				const [child] = yield* query((db) =>
					db
						.insert(thread)
						.values({
							workspaceId: reply.thread.workspaceId,
							podId: reply.thread.podId,
							hostAgentId: collaborator.id,
							conversationId: reply.thread.conversationId,
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
							atOffset: textOf(reply.parts).length,
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
						collaboratorAgentId: collaborator.id,
						briefMessageId: briefRow.id,
					}),
				]);
				return { child, briefId: briefRow.id, collaborationId: row.id };
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
						parentThreadId: reply.thread.id,
						parentMessageId: reply.messageId,
						collaboration: toCollaborationPart(row, collaborator.name),
						askingAgentId: reply.bot.id,
						askerMovedOn: false,
					}),
				]);
			}),
		);
	});

/** Ticket Desk answers Anita's ask with a question, before it does anything. */
const playTicketDesk = (bot: AgentRow, inThread: ThreadRow, triggerId: string) =>
	Effect.gen(function* () {
		yield* wait(BEFORE_REPLY_STARTS);
		const reply = yield* startReply(bot, inThread, triggerId);
		yield* finishReply(reply, TICKET_DESK.question);
	});

/**
 * Told to go ahead, Ticket Desk looks the charges up in Stripe, says what it
 * found, asks Billing Engineer why there were two, then asks to refund the
 * second. What it says stands apart from its calls, so the app shows it rather
 * than folding it into a call's line as narration.
 */
const playTicketDeskWork = (bot: AgentRow, inThread: ThreadRow, triggerId: string) =>
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
		yield* say(reply, TICKET_DESK.found);
		yield* wait(BETWEEN_STEPS);
		const billingEngineer = yield* botNamed(inThread.workspaceId, BILLING_ENGINEER.bot);
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
						threadId: inThread.id,
						workspaceId: inThread.workspaceId,
						podId: inThread.podId,
						turnId: reply.turnId,
					}),
				]);
			}),
		);
	});

/** Billing Engineer runs the billing tests in its sandbox, writes the incident up, and answers. */
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

/** Doreen mentions Anita in Support's chat, which brings it to Anita's Activity wherever she is. */
const cueMention = Effect.gen(function* () {
	const { workspace: showcaseWorkspace, owner } = yield* showcase;
	const support = yield* podChatOf(showcaseWorkspace.id, SUPPORT_POD);
	const asking = yield* personNamed(showcaseWorkspace.id, PEOPLE.mention.person);
	yield* typeAndPost(asking, support, `@${handleFromName(owner.name)} ${PEOPLE.mention.text}`);
});

/**
 * Billing Engineer writes the incident up: the artifact, made as its artifact
 * tool makes one, and the `artifact_write` call that shows it under the reply.
 */
const writeIncident = (reply: Reply) =>
	Effect.gen(function* () {
		const authoring = yield* Artifacts.Authoring;
		const { title, content } = BILLING_ENGINEER.incident;
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

/** What each bot in the story does when Anita starts a thread with it. */
const PARTS = new Map([[TICKET_DESK.bot as string, playTicketDesk]]);

/** What each bot in the story does when Anita answers it in its thread. */
const THREAD_PARTS = new Map([[TICKET_DESK.bot as string, playTicketDeskWork]]);

/** Who answers Anita when she writes in a pod's chat without mentioning a bot, by the pod's slug. */
const PEOPLE_PARTS = new Map([
	[
		SUPPORT_POD,
		(inThread: ThreadRow) =>
			Effect.gen(function* () {
				const answering = yield* personNamed(inThread.workspaceId, PEOPLE.closing.person);
				yield* typeAndPost(answering, inThread, PEOPLE.closing.text);
			}),
	],
]);

/** The conversation `conversationId`, a pod's chat or a thread, with its pod's slug and its bot, if it has one. */
const conversationById = (conversationId: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ thread, podSlug: pod.slug, bot: agent })
				.from(thread)
				.innerJoin(pod, eq(pod.id, thread.podId))
				.leftJoin(agent, eq(agent.id, thread.hostAgentId))
				.where(eq(thread.id, conversationId)),
		),
		([row]) =>
			row ? Effect.succeed(row) : Effect.die(new Error(`No conversation ${conversationId}`)),
	);

/**
 * Posts the owner's message in the pod's chat and starts a thread from it with
 * `botId`, as the API does, prints them as it answers, then plays the bot's
 * part in the thread, answering the message.
 */
const start = (podChatId: string, messageId: string, botId: string, text: string) =>
	Effect.gen(function* () {
		const { owner } = yield* showcase;
		const { emit } = yield* ConversationEvents.Service;
		const { thread: podChat } = yield* conversationById(podChatId);
		const [bot] = yield* query((db) => db.select().from(agent).where(eq(agent.id, botId)));
		if (!bot) return yield* Effect.die(new Error(`No bot ${botId}`));
		const posted = yield* postAs(owner, podChat, text, messageId);
		const started = yield* transaction(
			Effect.gen(function* () {
				const id = crypto.randomUUID();
				const [row] = yield* query((db) =>
					db
						.insert(thread)
						.values({
							id,
							workspaceId: podChat.workspaceId,
							podId: podChat.podId,
							hostAgentId: bot.id,
							conversationId: id,
							parentThreadId: podChat.id,
							type: "conversation",
							title: threadTitleFrom(text),
							initiatorUserId: owner.id,
							originMessageId: messageId,
						})
						.returning(),
				);
				if (!row) return yield* Effect.die(new Error("The thread wasn't opened"));
				yield* query((db) =>
					db.insert(threadParticipant).values([
						{ threadId: id, userId: owner.id },
						{ threadId: id, agentId: bot.id },
					]),
				);
				yield* emit([
					ConversationEvent.ThreadOpened({
						workspaceId: row.workspaceId,
						podId: row.podId,
						parentThreadId: podChat.id,
						threadId: row.id,
					}),
				]);
				return row;
			}),
		);
		// The first line out is the start's answer, which the autopilot hands the page.
		console.log(JSON.stringify({ conversation: toConversationThread(started), message: posted }));
		const part = PARTS.get(bot.name);
		if (part) yield* part(bot, started, messageId);
	});

/**
 * Posts the owner's message in the conversation, prints it as the API answers
 * a send, then plays who answers her: in a pod's chat its people, and in a
 * thread its bot.
 */
const send = (conversationId: string, messageId: string, text: string) =>
	Effect.gen(function* () {
		const { owner } = yield* showcase;
		const found = yield* conversationById(conversationId);
		const posted = yield* postAs(owner, found.thread, text, messageId);
		console.log(JSON.stringify(posted));
		if (found.bot) {
			const part = THREAD_PARTS.get(found.bot.name);
			if (part) yield* part(found.bot, found.thread, messageId);
			return;
		}
		const answer = PEOPLE_PARTS.get(found.podSlug);
		if (answer) yield* answer(found.thread);
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
 * Takes the story's pod chats back to where it starts: what the seed wrote.
 * Everything after goes, the threads started from them and the
 * collaborations and artifacts made in those included, and the pods' people
 * have read what's left.
 */
const reset = Effect.gen(function* () {
	const { workspace: showcaseWorkspace } = yield* showcase;
	const seeded = showcaseWorkspace.setupCompletedAt;
	if (!seeded)
		return yield* Effect.die(new Error("The showcase isn't seeded as the story expects"));
	const podChats = [yield* podChatOf(showcaseWorkspace.id, SUPPORT_POD)];
	const podChatIds = podChats.map((podChat) => podChat.id);
	const removed = yield* transaction(
		Effect.gen(function* () {
			const started = yield* query((db) =>
				db
					.select({ id: thread.id })
					.from(thread)
					.where(and(inArray(thread.parentThreadId, podChatIds), gt(thread.createdAt, seeded))),
			);
			const startedIds = started.map(({ id }) => id);
			if (startedIds.length > 0) {
				yield* query((db) =>
					db
						.delete(artifact)
						.where(
							and(eq(artifact.workspaceId, showcaseWorkspace.id), gt(artifact.createdAt, seeded)),
						),
				);
				// A thread's messages, turns, calls and collaborations' threads go with it.
				yield* query((db) => db.delete(thread).where(inArray(thread.id, startedIds)));
			}
			const gone = yield* query((db) =>
				db
					.delete(message)
					.where(and(inArray(message.threadId, podChatIds), gt(message.createdAt, seeded)))
					.returning({ id: message.id }),
			);
			const readers = yield* query((db) =>
				db
					.select({ threadId: thread.id, userId: podMember.userId })
					.from(thread)
					.innerJoin(podMember, eq(podMember.podId, thread.podId))
					.where(inArray(thread.id, podChatIds)),
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
			return { threads: startedIds.length, messages: gone.length };
		}),
	);
	console.log(
		`The story is back at its start (${removed.threads} threads and ${removed.messages} messages removed).`,
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
	"Usage: stage.ts reset | start <podChatId> <messageId> <botId> <text> | send <conversationId> <messageId> <text> | allow <toolCallId> | cue mention | sign-in-connections";
const [command, ...args] = process.argv.slice(2);

const program = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	if (installation.isProduction) {
		return yield* Effect.die(new Error("The showcase stage cannot run in production."));
	}
	const [first = "", second = "", ...rest] = args;
	if (command === "reset") return yield* reset;
	const [botId = "", ...words] = rest;
	if (command === "start" && first && second && botId && words.length > 0) {
		return yield* start(first, second, botId, words.join(" "));
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

import {
	defaultNotificationDelivery,
	memberChannel,
	type NotificationKind,
	type UpdateNotificationDelivery,
} from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CurrentActor } from "../authorization/current-actor.ts";
import { Chats } from "../conversations/chats/chats.ts";
import { ConversationEvents } from "../conversations/conversation-events.ts";
import { ConversationEvent } from "../conversations/events.ts";
import { conversationsForTests } from "../conversations/testing.ts";
import {
	aChatAwaitingReply,
	type PreparedTurn,
	prepareRunnable,
	replyTurnOf,
	runningTurns,
	type ToolCallRepository,
	TurnExecution,
	TurnRepository,
} from "../conversations/turns/testing.ts";
import { transaction } from "../database/database.ts";
import type { CommittedEvent } from "../database/events/outbox.ts";
import {
	agent,
	collaboration,
	message,
	notification,
	podMember,
	routine,
	routineExecution,
	thread,
	user,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../database/testing.ts";
import { onPostgresAs } from "../workspaces/testing.ts";
import { Notifications } from "./notifications.ts";

/**
 * Notifications against Postgres, through the conversation services as the
 * server composes them, so a turn stopping for approvals reaches the real
 * handler inside the transaction that stopped it.
 */
describe.skipIf(!process.env.DATABASE_URL)("notifications, against Postgres", async () => {
	let delivered: CommittedEvent[] = [];
	const conversations = await conversationsForTests({
		publishCommitted: async (events) => {
			delivered.push(...events);
		},
	});
	const turns = onPostgres(Context.get(conversations, TurnRepository.Service));
	const chatsAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, Chats.Service));
	const execution = onPostgres({
		prepare: Context.get(conversations, TurnExecution.Service).prepare,
	});
	const notifications = Context.get(conversations, Notifications.Service);
	const { emit } = Context.get(conversations, ConversationEvents.Service);
	const announce = (...events: ConversationEvent[]) => runOnPostgres(transaction(emit(events)));
	const as = (userId: string) =>
		CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId));
	const preferencesOf = (userId: string) =>
		runOnPostgres(notifications.preferences.pipe(as(userId)));
	const setPreference = (userId: string, kind: NotificationKind, enabled: boolean) =>
		runOnPostgres(notifications.setPreference({ kind, enabled }).pipe(as(userId)));
	const setDelivery = (userId: string, change: UpdateNotificationDelivery) =>
		runOnPostgres(notifications.setDelivery(change).pipe(as(userId)));

	let workspaceId: string;
	let podId: string;
	let threadId: string;
	let connectionId: string;
	let hostId: string;
	let people: Record<"owner" | "admin" | "member" | "viewer" | "bystander" | "outsider", string>;
	let prepared: PreparedTurn;

	afterAll(async () => {
		await closeDatabase();
	});

	/** A person, in the workspace as `role` unless left out of it. */
	async function aPerson(name: string, role?: "owner" | "member" | "viewer") {
		const [row] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name, email: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com` })
				.returning({ id: user.id }),
		);
		if (!row) throw new Error("fixture");
		if (role) {
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: row.id, role }),
			);
		}
		return row.id;
	}

	// The fixture's admin asked the pod's host. The database puts them and the
	// owner in the pod; a member and a viewer join it; a bystander is in the
	// workspace only.
	beforeEach(async () => {
		const chat = await aChatAwaitingReply(chatsAs);
		({ workspaceId, podId, threadId, connectionId, hostId } = chat);
		people = {
			owner: await aPerson("Owner", "owner"),
			admin: chat.memberId,
			member: await aPerson("Member", "member"),
			viewer: await aPerson("Viewer", "viewer"),
			bystander: await aPerson("Bystander", "member"),
			outsider: await aPerson("Outsider"),
		};
		await onDatabase((db) =>
			db.insert(podMember).values([
				{ workspaceId, podId, userId: people.member },
				{ workspaceId, podId, userId: people.viewer },
			]),
		);
		const [run] = await runOnPostgres(runningTurns(threadId));
		if (!run) throw new Error("no turn running");
		prepared = await prepareRunnable(execution, run);
		delivered = [];
	});

	const pendingCall = (tool: string, atOffset: number): ToolCallRepository.PendingToolApproval => ({
		id: crypto.randomUUID(),
		approvalId: `approval-${crypto.randomUUID()}`,
		sdkToolCallId: `sdk-${tool}`,
		tool,
		input: { title: "Fix mobile navigation" },
		connectionId,
		connectionRevision: 1,
		remoteToolName: tool,
		mutating: true,
		atOffset,
	});

	/** Stops the host's turn to wait for `approvals`. */
	const suspendFor = (approvals: readonly ToolCallRepository.PendingToolApproval[]) =>
		turns.suspend(
			replyTurnOf(prepared),
			{
				messages: [],
				approvals: approvals.map((pending) => ({
					approvalId: pending.approvalId,
					tool: pending.tool,
					connectionId,
					connectionRevision: 1,
					remoteToolName: pending.remoteToolName,
				})),
				modelInput: { model: "test", system: "test", messages: [] },
				reply: {
					content: "",
					collaborations: [],
					toolCalls: approvals.map(({ id, atOffset }) => ({ id, atOffset })),
				},
				modelCalls: 1,
			},
			approvals,
		);

	/** Who has been told anything in the workspace, or about `kind` alone. */
	const toldUsers = async (kind?: NotificationKind) =>
		(
			await onDatabase((db) =>
				db
					.select({ userId: notification.userId, kind: notification.kind })
					.from(notification)
					.where(eq(notification.workspaceId, workspaceId)),
			)
		)
			.filter((row) => kind === undefined || row.kind === kind)
			.map(({ userId }) => userId)
			.sort();

	const subjectsOf = async (userId: string, kind: NotificationKind) =>
		(
			await onDatabase((db) =>
				db.select().from(notification).where(eq(notification.userId, userId)),
			)
		)
			.filter((row) => row.kind === kind)
			.map((row) => row.subject);

	/** Finishes the host's reply with `content`. */
	const reply = (content: string) =>
		turns.complete(
			replyTurnOf(prepared),
			{ content, collaborations: [], toolCalls: [] },
			{ contextCapacity: 128_000, readKeptFrom: null, answeredCollaboration: false },
		);

	/** `userId` posts `content` in the host's chat. */
	const post = async (userId: string, content: string) => {
		const [chat] = await onDatabase((db) =>
			db.select({ chatId: thread.chatId }).from(thread).where(eq(thread.id, threadId)),
		);
		if (!chat?.chatId) throw new Error("fixture");
		await chatsAs(userId).post({ chatId: chat.chatId, messageId: crypto.randomUUID(), content });
	};

	const noticesDelivered = () =>
		delivered.filter(({ event }) => event.type === "notification.created");

	it("tells the pod's people who may decide the approvals, on their own channels", async () => {
		expect(
			await suspendFor([pendingCall("linear__create_issue", 0), pendingCall("linear__close", 4)]),
		).toBe(true);

		expect(await toldUsers()).toEqual([people.owner, people.admin, people.member].sort());
		const [host] = await onDatabase((db) =>
			db.select({ name: agent.name }).from(agent).where(eq(agent.id, hostId)),
		);
		const [membersNotice] = await onDatabase((db) =>
			db.select().from(notification).where(eq(notification.userId, people.member)),
		);
		expect(membersNotice?.subject).toMatchObject({
			kind: "approve",
			podId,
			threadId,
			agentId: hostId,
			agentName: host?.name,
			tools: ["linear__create_issue", "linear__close"],
		});
		expect(membersNotice?.subject.chatId).toEqual(expect.any(String));
		expect(
			noticesDelivered()
				.map(({ channel }) => channel)
				.sort(),
		).toEqual(
			[people.owner, people.admin, people.member]
				.map((userId) => memberChannel(workspaceId, userId))
				.sort(),
		);
		expect(noticesDelivered()[0]?.event).toMatchObject({
			audiencePodId: podId,
			notification: { workspaceId, subject: { kind: "approve" } },
		});
	});

	it("leaves out somebody who turned approvals off", async () => {
		await setPreference(people.member, "approve", false);

		await suspendFor([pendingCall("linear__create_issue", 0)]);

		expect(await toldUsers()).toEqual([people.owner, people.admin].sort());
	});

	it("tells somebody who turned approvals back on", async () => {
		await setPreference(people.member, "approve", false);
		await setPreference(people.member, "approve", true);

		await suspendFor([pendingCall("linear__create_issue", 0)]);

		expect(await toldUsers()).toEqual([people.owner, people.admin, people.member].sort());
	});

	it("tells nobody when the turn stops with nothing to decide", async () => {
		expect(await suspendFor([])).toBe(true);

		expect(await toldUsers()).toEqual([]);
		expect(noticesDelivered()).toEqual([]);
	});

	it("tells only the people who may decide a routine's approvals while it runs", async () => {
		const [scheduled] = await onDatabase((db) =>
			db
				.insert(routine)
				.values({
					workspaceId,
					agentId: hostId,
					name: "Triage",
					instructions: "Triage the inbox",
					triggerKind: "webhook",
					webhookSecretDigest: "digest",
				})
				.returning({ id: routine.id }),
		);
		if (!scheduled) throw new Error("fixture");
		const now = new Date();
		await onDatabase((db) =>
			db.insert(routineExecution).values({
				routineId: scheduled.id,
				workspaceId,
				agentId: hostId,
				threadId,
				triggerKind: "webhook",
				trigger: {
					kind: "webhook",
					receivedAt: now.toISOString(),
					idempotencyKey: null,
					payload: {},
				},
				routineName: "Triage",
				instructions: "Triage the inbox",
				state: "running",
				startedAt: now,
			}),
		);

		await suspendFor([pendingCall("linear__create_issue", 0)]);

		expect(await toldUsers()).toEqual([people.owner, people.admin].sort());
	});

	it("hears about each kind as its default says, and remembers a change", async () => {
		const defaults = { approve: true, dm: true, mention: true, routine: false, collab: false };
		expect((await preferencesOf(people.member)).kinds).toEqual(defaults);

		expect((await setPreference(people.member, "approve", false)).kinds).toEqual({
			...defaults,
			approve: false,
		});
		expect((await preferencesOf(people.member)).kinds).toEqual({ ...defaults, approve: false });
		expect((await preferencesOf(people.admin)).kinds).toEqual(defaults);
	});

	it("is told the default way, and keeps each delivery setting changed", async () => {
		expect((await preferencesOf(people.member)).delivery).toEqual(defaultNotificationDelivery);

		await setDelivery(people.member, { desktop: false });
		expect((await setDelivery(people.member, { quietOnWeekends: true })).delivery).toEqual({
			desktop: false,
			quietOnWeekends: true,
		});
		expect((await preferencesOf(people.member)).delivery).toEqual({
			desktop: false,
			quietOnWeekends: true,
		});
		expect((await preferencesOf(people.admin)).delivery).toEqual(defaultNotificationDelivery);
	});
	describe("a bot messaging somebody directly", () => {
		it("tells the person the reply answers, and the pod's people it mentions", async () => {
			await reply("Done. @member, @bystander: have a look.");

			expect(await toldUsers("dm")).toEqual([people.admin, people.member].sort());
			const [told] = await subjectsOf(people.member, "dm");
			expect(told).toMatchObject({
				kind: "dm",
				podId,
				threadId,
				threadType: "chat",
				agentId: hostId,
				messageId: replyTurnOf(prepared).messageId,
				preview: "Done. @member, @bystander: have a look.",
			});
		});

		it("previews the reply as the chat shows it, without the words before a tool call", async () => {
			const { messageId } = replyTurnOf(prepared);
			await reply("Let me check:It is paid.");
			await onDatabase((db) =>
				db
					.update(message)
					.set({
						parts: [
							{ type: "text", text: "Let me check:" },
							{ type: "tool_call", toolCallId: crypto.randomUUID() },
							{ type: "text", text: "It is paid." },
						],
					})
					.where(eq(message.id, messageId)),
			);
			await onDatabase((db) =>
				db.delete(notification).where(eq(notification.workspaceId, workspaceId)),
			);
			await announce(
				ConversationEvent.TurnCompleted({
					threadId,
					workspaceId,
					podId,
					turnId: prepared.turnId,
					agentId: hostId,
					reason: undefined,
					messageId,
					content: "Let me check:It is paid.",
					contextTokens: undefined,
					contextCapacity: 128_000,
					readKeptFrom: null,
					answeredCollaboration: false,
				}),
			);

			expect(await subjectsOf(people.admin, "dm")).toMatchObject([{ preview: "It is paid." }]);
		});

		it("tells a person once when the reply both answers and mentions them", async () => {
			await reply("@sam here it is.");

			expect(await toldUsers("dm")).toEqual([people.admin]);
		});

		it("cuts a long reply to a preview", async () => {
			await reply(`Here is the summary. ${"word ".repeat(60)}`);

			const [told] = await subjectsOf(people.admin, "dm");
			expect(told?.kind === "dm" && told.preview.length).toBeLessThanOrEqual(140);
			expect(told?.kind === "dm" && told.preview.endsWith("…")).toBe(true);
		});

		it("leaves out somebody who turned it off", async () => {
			await setPreference(people.admin, "dm", false);

			await reply("@member here it is.");

			expect(await toldUsers("dm")).toEqual([people.member]);
		});
	});

	describe("somebody mentioning a person", () => {
		it("tells the pod's people it mentions, but not the person who wrote it", async () => {
			await post(people.member, "@sam @viewer @member @bystander can you look at this?");

			expect(await toldUsers("mention")).toEqual([people.admin, people.viewer].sort());
			const [told] = await subjectsOf(people.viewer, "mention");
			expect(told).toMatchObject({
				kind: "mention",
				podId,
				threadId,
				threadType: "chat",
				agentId: hostId,
				authorName: "Member",
				preview: "@sam @viewer @member @bystander can you look at this?",
			});
		});

		it("tells nobody about a message that mentions no one", async () => {
			await post(people.member, "Can somebody look at this?");

			expect(await toldUsers("mention")).toEqual([]);
		});
	});

	/** A routine `createdById` made, with a run in the fixture's thread that ended as `state`. */
	async function aRunThatEnded(createdById: string, state: "completed" | "failed" | "running") {
		const [made] = await onDatabase((db) =>
			db
				.insert(routine)
				.values({
					workspaceId,
					agentId: hostId,
					name: "Morning brief",
					instructions: "Brief the team",
					triggerKind: "webhook",
					webhookSecretDigest: "digest",
					createdById,
				})
				.returning({ id: routine.id }),
		);
		if (!made) throw new Error("fixture");
		const now = new Date();
		await onDatabase((db) =>
			db.insert(routineExecution).values({
				routineId: made.id,
				workspaceId,
				agentId: hostId,
				threadId,
				triggerKind: "webhook",
				trigger: {
					kind: "webhook",
					receivedAt: now.toISOString(),
					idempotencyKey: null,
					payload: {},
				},
				routineName: "Morning brief",
				instructions: "Brief the team",
				state,
				startedAt: now,
			}),
		);
		await announce(
			ConversationEvent.RoutineExecutionSettled({ workspaceId, podId, chatId: podId, threadId }),
		);
	}

	describe("a routine finishing", () => {
		it("tells the person who made the routine how its run ended", async () => {
			await setPreference(people.member, "routine", true);

			await aRunThatEnded(people.member, "failed");

			expect(await toldUsers("routine")).toEqual([people.member]);
			expect(await subjectsOf(people.member, "routine")).toMatchObject([
				{ kind: "routine", routineName: "Morning brief", outcome: "failed", agentId: hostId },
			]);
		});

		it("tells nobody who has not turned it on", async () => {
			await aRunThatEnded(people.member, "completed");

			expect(await toldUsers("routine")).toEqual([]);
		});

		it("tells nobody of a run still going", async () => {
			await setPreference(people.member, "routine", true);

			await aRunThatEnded(people.member, "running");

			expect(await toldUsers("routine")).toEqual([]);
		});
	});

	describe("a collaboration finishing", () => {
		/** The host asked a helper for help in its reply, and that ended as `outcome`. */
		async function aCollaborationThat(outcome: "answered" | "failed") {
			const [helper] = await onDatabase((db) =>
				db
					.insert(agent)
					.values({
						workspaceId,
						podId,
						name: "Helper",
						handle: `helper-${crypto.randomUUID().slice(0, 8)}`,
						color: "sky",
						face: "dot",
						model: "m",
					})
					.returning({ id: agent.id }),
			);
			if (!helper) throw new Error("fixture");
			const [child] = await onDatabase((db) =>
				db
					.insert(thread)
					.values({
						workspaceId,
						podId,
						hostAgentId: helper.id,
						type: "collaboration",
						title: "Help",
						parentThreadId: threadId,
					})
					.returning({ id: thread.id }),
			);
			if (!child) throw new Error("fixture");
			const parentMessageId = replyTurnOf(prepared).messageId;
			const [asked] = await onDatabase((db) =>
				db
					.insert(collaboration)
					.values({
						parentThreadId: threadId,
						parentMessageId,
						turnId: prepared.turnId,
						childThreadId: child.id,
						collaboratorAgentId: helper.id,
						brief: "Check the invoice",
						status: outcome,
						answer: outcome === "answered" ? "It is paid" : null,
						atOffset: 0,
					})
					.returning({ id: collaboration.id }),
			);
			if (!asked) throw new Error("fixture");
			const change = {
				parentThreadId: threadId,
				parentMessageId,
				collaboration: {
					type: "collaboration" as const,
					id: asked.id,
					agentId: helper.id,
					agentName: "Helper",
					threadId: child.id,
					brief: "Check the invoice",
					status: outcome,
					answer: outcome === "answered" ? "It is paid" : null,
					atOffset: 0,
				},
			};
			await announce(
				outcome === "answered"
					? ConversationEvent.CollaborationAnswered(change)
					: ConversationEvent.CollaborationFailed(change),
			);
		}

		it("tells the person whose message the asking bot was answering", async () => {
			await setPreference(people.admin, "collab", true);

			await aCollaborationThat("answered");

			expect(await toldUsers("collab")).toEqual([people.admin]);
			expect(await subjectsOf(people.admin, "collab")).toMatchObject([
				{
					kind: "collab",
					agentId: hostId,
					collaboratorName: "Helper",
					outcome: "answered",
					threadId,
				},
			]);
		});

		it("says when the helper could not answer", async () => {
			await setPreference(people.admin, "collab", true);

			await aCollaborationThat("failed");

			expect(await subjectsOf(people.admin, "collab")).toMatchObject([{ outcome: "failed" }]);
		});

		it("tells nobody who has not turned it on", async () => {
			await aCollaborationThat("answered");

			expect(await toldUsers("collab")).toEqual([]);
		});
	});
});

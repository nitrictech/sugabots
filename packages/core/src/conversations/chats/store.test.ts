import { type ChatMessageItem, handleFromName } from "@sugabots/contracts";
import { eq, like } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../database/events/bus.ts";
import { eventPublisher } from "../../database/events/publish.ts";
import { postgresEventStore } from "../../database/events/store.ts";
import {
	agent,
	chat,
	collaboration,
	laneRequest,
	message,
	pod,
	podMember,
	routineExecution,
	thread,
	threadParticipant,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { routineStore } from "../routines/store.ts";
import { routineRunsForTests } from "../routines/testing.ts";
import {
	queueFacilitationForTests,
	queueTurnForTests,
	runningTurns,
	turnSignalsForTests,
} from "../turns/testing.ts";
import { chatStore } from "./store.ts";

const eventStore = await runOnPostgres(postgresEventStore);

describe.skipIf(!process.env.DATABASE_URL)("chats, against Postgres", () => {
	const publishEvents = eventPublisher(createEventBus({ store: eventStore }));
	const store = onPostgres(chatStore(publishEvents, queueTurnForTests, queueFacilitationForTests));
	let workspaceId: string;
	let podId: string;
	let agentId: string;
	let recipientAgentId: string;
	let userId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = crypto.randomUUID();
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Chat member", email: `chat-${suffix}@example.com` })
				.returning(),
		);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Chat workspace", slug: `chat-${suffix}` })
				.returning(),
		);
		if (!person || !space) throw new Error("Could not create chat test identity");
		userId = person.id;
		workspaceId = space.id;
		await onDatabase((db) => db.insert(workspaceMember).values({ workspaceId, userId }));
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: userId,
					kind: "shared",
					name: "Chat pod",
					slug: `chat-${suffix}`,
					createdById: userId,
				})
				.returning(),
		);
		if (!room) throw new Error("Could not create chat test pod");
		podId = room.id;
		await onDatabase((db) => db.insert(podMember).values({ workspaceId, podId, userId }));
		const [host, recipient] = await onDatabase((db) =>
			db
				.insert(agent)
				.values([
					{
						workspaceId,
						podId,
						name: "Personal Agent",
						handle: handleFromName(`Personal Agent ${suffix}`),
						color: "green",
						face: "pill",
						model: "test/model",
						createdById: userId,
					},
					{
						workspaceId,
						podId,
						name: "Impersonal Agent",
						handle: handleFromName(`Impersonal Agent ${suffix}`),
						color: "sky",
						face: "square",
						model: "test/model",
						createdById: userId,
					},
				])
				.returning(),
		);
		if (!host || !recipient) throw new Error("Could not create chat test agents");
		agentId = host.id;
		recipientAgentId = recipient.id;
	});

	it("lists a pod's bots newest message first, with bots nobody has messaged last", async () => {
		const current = await store.getOrCreate({ workspaceId, podId, hostAgentId: agentId, userId });
		await store.sendMain({
			chatId: current.id,
			author: { id: userId, name: "Chat member", image: null },
			messageId: crypto.randomUUID(),
			content: "\n  Budget   review is Friday\nand bring the numbers",
		});

		const list = await store.list({ workspaceId, userId, pod: podId });

		expect(list?.items).toEqual([
			{
				agent: expect.objectContaining({ id: agentId }),
				chatId: current.id,
				lastMessage: {
					preview: "Budget review is Friday",
					authorUserId: userId,
					at: expect.any(String),
				},
			},
			{ agent: expect.objectContaining({ id: recipientAgentId }), chatId: null, lastMessage: null },
		]);
	});

	it("covers every shared pod the person reaches in All, and no pod they cannot", async () => {
		const suffix = crypto.randomUUID();
		const [personal, unjoined] = await onDatabase((db) =>
			db
				.insert(pod)
				.values([
					{
						workspaceId,
						ownerId: userId,
						kind: "personal",
						name: "Personal",
						slug: "personal",
						createdById: userId,
					},
					{
						workspaceId,
						ownerId: userId,
						kind: "shared",
						name: "Elsewhere",
						slug: `elsewhere-${suffix}`,
						createdById: userId,
					},
				])
				.returning(),
		);
		if (!personal || !unjoined) throw new Error("Could not create list test pods");
		await onDatabase((db) =>
			db.insert(agent).values(
				[personal, unjoined].map((room) => ({
					workspaceId,
					podId: room.id,
					name: `Bot in ${room.name}`,
					handle: handleFromName(`Bot in ${room.name} ${suffix}`),
					color: "rose" as const,
					face: "dot" as const,
					model: "test/model",
					createdById: userId,
				})),
			),
		);

		const all = await store.list({ workspaceId, userId, pod: "all" });

		expect(all?.items.map((item) => item.agent.id).sort()).toEqual(
			[agentId, recipientAgentId].sort(),
		);
		expect(await store.list({ workspaceId, userId, pod: unjoined.id })).toBeUndefined();
		expect((await store.list({ workspaceId, userId, pod: personal.id }))?.items).toHaveLength(1);
	});

	it("keeps one chat per pod and host and queues top-level messages in the main Chat", async () => {
		const input = { workspaceId, podId, hostAgentId: agentId, userId };
		const [first, retried] = await Promise.all([
			store.getOrCreate(input),
			store.getOrCreate(input),
		]);
		expect(retried.id).toBe(first.id);
		expect(
			await onDatabase((db) => db.select().from(chat).where(eq(chat.id, first.id))),
		).toHaveLength(1);

		const sent = await store.sendMain({
			chatId: first.id,
			author: { id: userId, name: "Chat member", image: null },
			messageId: crypto.randomUUID(),
			content: "Investigate this over several steps",
		});
		expect(sent?.threadId).toBe(first.mainThreadId);
		expect(await runOnPostgres(runningTurns(first.mainThreadId))).toHaveLength(1);
		expect((await store.history(first.id, userId))?.items).toHaveLength(0);
		expect((await store.messages(first.id, userId))?.items.map((item) => item.kind)).toEqual([
			"message",
		]);
	});

	it("refuses a message to an agent with no model, and saves nothing", async () => {
		await onDatabase((db) => db.update(agent).set({ model: null }).where(eq(agent.id, agentId)));
		const current = await store.getOrCreate({ workspaceId, podId, hostAgentId: agentId, userId });
		const messageId = crypto.randomUUID();

		await expect(
			store.sendMain({
				chatId: current.id,
				author: { id: userId, name: "Chat member", image: null },
				messageId,
				content: "Anyone there?",
			}),
		).rejects.toThrow("has no model chosen");
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.id, messageId))),
		).toHaveLength(0);
		expect(await runOnPostgres(runningTurns(current.mainThreadId))).toHaveLength(0);
	});

	it("retries the same message without creating another message or turn", async () => {
		const current = await store.getOrCreate({ workspaceId, podId, hostAgentId: agentId, userId });
		const messageId = crypto.randomUUID();
		const first = await store.sendMain({
			chatId: current.id,
			author: { id: userId, name: "Chat member", image: null },
			messageId,
			content: "A simple question",
		});
		const retried = await store.sendMain({
			chatId: current.id,
			author: { id: userId, name: "Chat member", image: null },
			messageId,
			content: "A simple question",
		});
		expect(retried).toEqual(first);
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.id, messageId))),
		).toHaveLength(1);
		expect(await runOnPostgres(runningTurns(current.mainThreadId))).toHaveLength(1);
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(laneRequest)
					.where(like(laneRequest.laneKey, `turn:${current.mainThreadId}:%`)),
			),
		).toHaveLength(0);
	});

	it("includes Routine runs in the main Chat timeline", async () => {
		const current = await store.getOrCreate({ workspaceId, podId, hostAgentId: agentId, userId });
		const routines = onPostgres(
			routineStore(() => Effect.void, queueTurnForTests, turnSignalsForTests, routineRunsForTests),
		);
		const created = await routines.create(workspaceId, agentId, userId, {
			name: "Overnight review",
			instructions: "Review overnight changes.",
			trigger: { kind: "webhook" },
		});
		const requestId = crypto.randomUUID();
		const accepted = await routines.acceptTrigger({
			workspaceId,
			agentId,
			routineId: created.routine.id,
			triggerIdentity: requestId,
			trigger: {
				kind: "manual",
				requestId,
				requestedAt: new Date().toISOString(),
				requestedByUserId: userId,
			},
		});

		expect((await store.messages(current.id, userId))?.items).toEqual([
			expect.objectContaining({
				kind: "routine",
				id: accepted.executionId,
				threadId: accepted.threadId,
				routineName: "Overnight review",
				triggerKind: "manual",
			}),
		]);
	});

	it("paginates interleaved messages and Routine runs without gaps", async () => {
		const current = await store.getOrCreate({ workspaceId, podId, hostAgentId: agentId, userId });
		const routines = onPostgres(
			routineStore(() => Effect.void, queueTurnForTests, turnSignalsForTests, routineRunsForTests),
		);
		const created = await routines.create(workspaceId, agentId, userId, {
			name: "Overnight review",
			instructions: "Review overnight changes.",
			trigger: { kind: "webhook" },
		});
		const requestId = crypto.randomUUID();
		const accepted = await routines.acceptTrigger({
			workspaceId,
			agentId,
			routineId: created.routine.id,
			triggerIdentity: requestId,
			trigger: {
				kind: "manual",
				requestId,
				requestedAt: "2026-09-18T10:00:00.000Z",
				requestedByUserId: userId,
			},
		});
		const olderMessageId = crypto.randomUUID();
		const newerMessageId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values([
				{
					id: olderMessageId,
					threadId: current.mainThreadId,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Older message" }],
					content: "Older message",
					createdAt: new Date("2026-09-18T09:00:00.000Z"),
				},
				{
					id: newerMessageId,
					threadId: current.mainThreadId,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Newer message" }],
					content: "Newer message",
					createdAt: new Date("2026-09-18T11:00:00.000Z"),
				},
			]),
		);
		await onDatabase((db) =>
			db
				.update(routineExecution)
				.set({ acceptedAt: new Date("2026-09-18T10:00:00.000Z") })
				.where(eq(routineExecution.id, accepted.executionId)),
		);

		const firstPage = await store.messages(current.id, userId, { limit: 2 });
		expect(firstPage?.items.map(timelineItemId)).toEqual([accepted.executionId, newerMessageId]);
		expect(firstPage?.nextCursor).toBeTypeOf("string");
		if (!firstPage?.nextCursor) throw new Error("Expected another Chat timeline page");

		const secondPage = await store.messages(current.id, userId, {
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		expect(secondPage?.items.map(timelineItemId)).toEqual([olderMessageId]);
		expect(secondPage?.nextCursor).toBeNull();
	});

	it("shows an agent collaboration in both agents' Chats", async () => {
		const initiatorChat = await store.getOrCreate({
			workspaceId,
			podId,
			hostAgentId: agentId,
			userId,
		});
		const recipientChat = await store.getOrCreate({
			workspaceId,
			podId,
			hostAgentId: recipientAgentId,
			userId,
		});
		const trigger = await store.sendMain({
			chatId: initiatorChat.id,
			author: { id: userId, name: "Chat member", image: null },
			messageId: crypto.randomUUID(),
			content: "Ask Impersonal Agent",
		});
		if (!trigger) throw new Error("Could not create collaboration trigger");
		const collaborationId = crypto.randomUUID();
		const [askingTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					threadId: initiatorChat.mainThreadId,
					agentId,
					triggerMessageId: trigger.id,
					status: "done",
					model: "test/model",
					startedAt: new Date(),
					finishedAt: new Date(),
					reason: "default",
				})
				.returning(),
		);
		if (!askingTurn) throw new Error("Could not create asking turn");
		const [parentMessage] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: initiatorChat.mainThreadId,
					authorAgentId: agentId,
					kind: "text",
					status: "complete",
					parts: [{ type: "collaboration", collaborationId }],
					content: "",
					turnId: askingTurn.id,
				})
				.returning(),
		);
		const [child] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId,
					hostAgentId: recipientAgentId,
					chatId: initiatorChat.id,
					type: "collaboration",
					title: "Compare the launch plans",
					parentThreadId: initiatorChat.mainThreadId,
					initiatorUserId: userId,
				})
				.returning(),
		);
		if (!parentMessage || !child) throw new Error("Could not create collaboration threads");
		await onDatabase((db) =>
			db.insert(threadParticipant).values([
				{ threadId: child.id, agentId },
				{ threadId: child.id, agentId: recipientAgentId },
			]),
		);
		await onDatabase((db) =>
			db.insert(collaboration).values({
				id: collaborationId,
				parentThreadId: initiatorChat.mainThreadId,
				parentMessageId: parentMessage.id,
				turnId: askingTurn.id,
				childThreadId: child.id,
				collaboratorAgentId: recipientAgentId,
				brief: "Compare the launch plans",
				status: "waiting",
				atOffset: 0,
			}),
		);

		const outbound = await store.messages(initiatorChat.id, userId);
		const inbound = await store.messages(recipientChat.id, userId);
		expect(outbound?.items.at(-1)).toMatchObject({
			kind: "message",
			message: { parts: [{ type: "collaboration", threadId: child.id }] },
		});
		expect(inbound?.items).toEqual([
			expect.objectContaining({
				kind: "collaboration",
				id: collaborationId,
				threadId: child.id,
				initiator: expect.objectContaining({ id: agentId, name: "Personal Agent" }),
			}),
		]);
		expect((await store.history(recipientChat.id, userId))?.items).toEqual([
			expect.objectContaining({ threadId: child.id, type: "collaboration" }),
		]);
	});

	it("reports each history thread's own status, participants, and Routine run", async () => {
		const current = await store.getOrCreate({ workspaceId, podId, hostAgentId: agentId, userId });
		const routines = onPostgres(
			routineStore(() => Effect.void, queueTurnForTests, turnSignalsForTests, routineRunsForTests),
		);
		const created = await routines.create(workspaceId, agentId, userId, {
			name: "Overnight review",
			instructions: "Review overnight changes.",
			trigger: { kind: "webhook" },
		});
		const requestId = crypto.randomUUID();
		const requestedAt = new Date().toISOString();
		const accepted = await routines.acceptTrigger({
			workspaceId,
			agentId,
			routineId: created.routine.id,
			triggerIdentity: requestId,
			trigger: { kind: "manual", requestId, requestedAt, requestedByUserId: userId },
		});
		const [failed, running] = await onDatabase((db) =>
			db
				.insert(thread)
				.values(
					["Failed collaboration", "Running collaboration"].map((title) => ({
						workspaceId,
						podId,
						hostAgentId: agentId,
						chatId: current.id,
						type: "collaboration" as const,
						title,
						parentThreadId: current.mainThreadId,
						initiatorUserId: userId,
					})),
				)
				.returning(),
		);
		if (!failed || !running) throw new Error("Could not create collaboration threads");
		await onDatabase((db) =>
			db.insert(threadParticipant).values([
				{ threadId: failed.id, agentId },
				{ threadId: running.id, userId },
				{ threadId: running.id, agentId: recipientAgentId },
			]),
		);
		const [failedTrigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: failed.id,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Try this" }],
					content: "Try this",
				})
				.returning(),
		);
		if (!failedTrigger) throw new Error("Could not create failed turn trigger");
		await onDatabase((db) =>
			db.insert(turn).values({
				threadId: failed.id,
				agentId,
				triggerMessageId: failedTrigger.id,
				status: "failed",
				model: "test/model",
				startedAt: new Date(),
				finishedAt: new Date(),
				reason: "default",
			}),
		);
		await runOnPostgres(
			queueFacilitationForTests({ threadId: running.id, triggerMessageId: crypto.randomUUID() }),
		);

		const items = (await store.history(current.id, userId))?.items ?? [];
		const entry = (threadId: string) => items.find((item) => item.threadId === threadId);
		expect(items).toHaveLength(3);
		expect(entry(failed.id)).toMatchObject({
			status: "failed",
			participants: [expect.objectContaining({ id: agentId })],
			routineExecution: null,
		});
		expect(entry(running.id)).toMatchObject({
			status: "running",
			participants: [
				expect.objectContaining({ id: userId }),
				expect.objectContaining({ id: recipientAgentId }),
			],
			routineExecution: null,
		});
		expect(entry(accepted.threadId)).toMatchObject({
			type: "routine",
			status: "queued",
			routineExecution: {
				executionId: accepted.executionId,
				routineId: created.routine.id,
				routineName: "Overnight review",
				triggerKind: "manual",
				triggeredAt: requestedAt,
			},
		});
	});
});

function timelineItemId(item: ChatMessageItem) {
	return item.kind === "message" ? item.message.id : item.id;
}

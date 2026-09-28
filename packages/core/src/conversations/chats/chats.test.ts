import { type ChatMessageItem, handleFromName, threadChannel } from "@sugabots/contracts";
import { and, eq, like } from "drizzle-orm";
import { Context, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Visibility } from "../../authorization/visibility.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	agent,
	chat,
	collaboration,
	event,
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
import { closeDatabase, onDatabase, type Promised, runOnPostgres } from "../../database/testing.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { Routines } from "../routines/routines.ts";
import { conversationsForTests } from "../testing.ts";
import { queueFacilitationForTests, runningTurns } from "../turns/testing.ts";
import { ChatView } from "./chat-view.ts";
import { Chats } from "./chats.ts";

const eventStore = await runOnPostgres(EventStore.make);

describe.skipIf(!process.env.DATABASE_URL)("chats, against Postgres", async () => {
	const conversations = await conversationsForTests(EventBus.inProcess({ store: eventStore }));
	/** As the member the chats are with. */
	let chats: Promised<Chats.Interface>;
	let view: Promised<ChatView.Interface>;
	/** As an administrator, who may define and run the agents' routines. */
	let routines: Promised<Routines.Interface>;
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
		const [person, administrator] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Chat member", email: `chat-${suffix}@example.com` },
					{ name: "Chat admin", email: `chat-admin-${suffix}@example.com` },
				])
				.returning(),
		);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Chat workspace", slug: `chat-${suffix}` })
				.returning(),
		);
		if (!person || !administrator || !space) throw new Error("Could not create chat test identity");
		userId = person.id;
		workspaceId = space.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId },
				{ workspaceId, userId: administrator.id, role: "admin" },
			]),
		);
		chats = onPostgresAs(userId)(Context.get(conversations, Chats.Service));
		view = onPostgresAs(userId)(Context.get(conversations, ChatView.Service));
		routines = onPostgresAs(administrator.id)(Context.get(conversations, Routines.Service));
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

	it("shows a chat to whoever reaches its pod, and to nobody else", async () => {
		const opened = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const [outsider, stranger] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Outside the pod", email: `outsider-${crypto.randomUUID()}@example.com` },
					{ name: "Outside the workspace", email: `stranger-${crypto.randomUUID()}@example.com` },
				])
				.returning(),
		);
		if (!outsider || !stranger) throw new Error("Could not create the people");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: outsider.id, role: "member" }),
		);
		const visibility = await runOnPostgres(Effect.provide(Visibility.Service, Visibility.layer));
		const visibilityAs = (personId: string) => onPostgresAs(personId)({ chat: visibility.chat });

		expect(await visibilityAs(userId).chat(opened.id)).toMatchObject({ id: opened.id });
		for (const personId of [outsider.id, stranger.id]) {
			await expect(visibilityAs(personId).chat(opened.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "chat",
			});
		}
		await expect(visibilityAs(userId).chat("not-a-uuid")).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
	});

	it("lists a pod's bots newest message first, with bots nobody has messaged last", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "\n  Budget   review is Friday\nand bring the numbers",
		});

		const list = await view.list({ workspace: workspaceId, pod: podId });

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

		const all = await view.list({ workspace: workspaceId, pod: "all" });

		expect(all?.items.map((item) => item.agent.id).sort()).toEqual(
			[agentId, recipientAgentId].sort(),
		);
		await expect(view.list({ workspace: workspaceId, pod: unjoined.id })).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
		expect((await view.list({ workspace: workspaceId, pod: personal.id }))?.items).toHaveLength(1);
	});

	it("keeps one chat per pod and host and queues top-level messages in the main Chat", async () => {
		const input = { workspace: workspaceId, podId, hostAgentId: agentId };
		const [first, retried] = await Promise.all([chats.open(input), chats.open(input)]);
		expect(retried.id).toBe(first.id);
		expect(
			await onDatabase((db) => db.select().from(chat).where(eq(chat.id, first.id))),
		).toHaveLength(1);

		const sent = await chats.post({
			chatId: first.id,
			messageId: crypto.randomUUID(),
			content: "Investigate this over several steps",
		});
		expect(sent?.threadId).toBe(first.mainThreadId);
		expect(await runOnPostgres(runningTurns(first.mainThreadId))).toHaveLength(1);
		expect((await view.history(first.id))?.items).toHaveLength(0);
		expect((await view.messages(first.id))?.items.map((item) => item.kind)).toEqual(["message"]);
	});

	it("refuses a message to an agent with no model, and saves nothing", async () => {
		await onDatabase((db) => db.update(agent).set({ model: null }).where(eq(agent.id, agentId)));
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const messageId = crypto.randomUUID();

		await expect(
			chats.post({
				chatId: current.id,
				messageId,
				content: "Anyone there?",
			}),
		).rejects.toMatchObject({ _tag: "ChatAgentHasNoModel" });
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.id, messageId))),
		).toHaveLength(0);
		expect(await runOnPostgres(runningTurns(current.mainThreadId))).toHaveLength(0);
	});

	it("retries the same message without creating another message or turn", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const send = {
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "A simple question",
		};
		const messageId = send.messageId;
		const [first, retried] = await Promise.all([chats.post(send), chats.post(send)]);
		expect(retried).toEqual(first);
		await expect(chats.post({ ...send, content: "Another question" })).rejects.toMatchObject({
			_tag: "MessageIdConflict",
		});
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

	it("announces a person's message before the agent it brings into the thread", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		// The chat's agent has not joined its thread yet, so the message brings it in.
		await onDatabase((db) =>
			db
				.delete(threadParticipant)
				.where(
					and(
						eq(threadParticipant.threadId, current.mainThreadId),
						eq(threadParticipant.agentId, agentId),
					),
				),
		);

		await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "Are you there?",
		});

		const announced = await onDatabase((db) =>
			db
				.select({ type: event.type })
				.from(event)
				.where(eq(event.channel, threadChannel(current.mainThreadId)))
				.orderBy(event.seq),
		);
		expect(announced.slice(0, 2).map(({ type }) => type)).toEqual([
			"message.created",
			"thread.changed",
		]);
	});

	it("includes Routine runs in the main Chat timeline", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const created = await routines.create(
			{ agentId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				trigger: { kind: "webhook" },
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });

		expect((await view.messages(current.id))?.items).toEqual([
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
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const created = await routines.create(
			{ agentId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				trigger: { kind: "webhook" },
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });
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

		const firstPage = await view.messages(current.id, { limit: 2 });
		expect(firstPage?.items.map(timelineItemId)).toEqual([accepted.executionId, newerMessageId]);
		expect(firstPage?.nextCursor).toBeTypeOf("string");
		if (!firstPage?.nextCursor) throw new Error("Expected another Chat timeline page");

		const secondPage = await view.messages(current.id, {
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		expect(secondPage?.items.map(timelineItemId)).toEqual([olderMessageId]);
		expect(secondPage?.nextCursor).toBeNull();
	});

	it("shows an agent collaboration in both agents' Chats", async () => {
		const initiatorChat = await chats.open({
			workspace: workspaceId,
			podId,
			hostAgentId: agentId,
		});
		const recipientChat = await chats.open({
			workspace: workspaceId,
			podId,
			hostAgentId: recipientAgentId,
		});
		const trigger = await chats.post({
			chatId: initiatorChat.id,
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

		const outbound = await view.messages(initiatorChat.id);
		const inbound = await view.messages(recipientChat.id);
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
		expect((await view.history(recipientChat.id))?.items).toEqual([
			expect.objectContaining({ threadId: child.id, type: "collaboration" }),
		]);
	});

	it("reports each history thread's own status, participants, and Routine run", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const created = await routines.create(
			{ agentId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				trigger: { kind: "webhook" },
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });
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

		const items = (await view.history(current.id))?.items ?? [];
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
				triggeredAt: expect.any(String),
			},
		});
	});
});

function timelineItemId(item: ChatMessageItem) {
	return item.kind === "message" ? item.message.id : item.id;
}

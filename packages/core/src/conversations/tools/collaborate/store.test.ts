import { handleFromName, workspaceChannel } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../database/events/bus.ts";
import { eventPublisher } from "../../../database/events/publish.ts";
import { memoryEventStore } from "../../../database/events/store.ts";
import {
	agent,
	event,
	job,
	message,
	pod,
	podMember,
	thread,
	threadSummary,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, type Promised } from "../../../database/testing.ts";
import { chatStore } from "../../chats/store.ts";
import { threadStore } from "../../threads/store.ts";
import { modelPrompt } from "../../turns/context.ts";
import { turnStore } from "../../turns/store.ts";
import { CollaborationRefused, type CollaborationStore, collaborationStore } from "./store.ts";

/**
 * Collaboration against Postgres: what `open` writes, what policy refuses, and
 * how a collaboration moves between the asking agent and the answering one.
 */
describe.skipIf(!process.env.DATABASE_URL)("collaboration, against Postgres", () => {
	const publishEvents = eventPublisher(createEventBus({ store: memoryEventStore() }));
	const collaborations: Promised<CollaborationStore> = onPostgres(
		collaborationStore(publishEvents),
	);
	const threads = onPostgres(threadStore());
	const chats = onPostgres(chatStore(publishEvents));
	const turns = onPostgres(turnStore(publishEvents));
	let workspaceId: string;
	let podId: string;
	let memberId: string;
	let host: { id: string; name: string };
	let helper: { id: string; name: string };
	let rootThreadId: string;
	let hostChatId: string;
	let helperChatId: string;
	let helperMainThreadId: string;
	/** The host's reply in the root thread, which its collaborations hang off. */
	let reply: { turnId: string; messageId: string };

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Collaboration ${suffix}`, slug: `collaboration-${suffix}` })
				.returning(),
		);
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `collaboration-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !member) throw new Error("fixture");
		workspaceId = space.id;
		memberId = member.id;
		await onDatabase((db) => db.insert(workspaceMember).values({ workspaceId, userId: memberId }));
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: memberId,
					kind: "shared",
					name: "Room",
					slug: `room-${suffix}`,
					createdById: memberId,
				})
				.returning(),
		);
		if (!room) throw new Error("fixture");
		podId = room.id;
		await onDatabase((db) => db.insert(podMember).values({ workspaceId, podId, userId: memberId }));
		const crew = await onDatabase((db) =>
			db
				.insert(agent)
				.values([
					{
						workspaceId,
						podId,
						name: `Host ${suffix}`,
						handle: handleFromName(`Host ${suffix}`),
						color: "rose",
						face: "pill",
						model: "m",
						createdById: memberId,
					},
					{
						workspaceId,
						podId,
						name: `Helper ${suffix}`,
						handle: handleFromName(`Helper ${suffix}`),
						description: "Knows things.",
						color: "rose",
						face: "dot",
						model: "m",
						createdById: memberId,
					},
				])
				.returning({ id: agent.id, name: agent.name }),
		);
		const [hostRow, helperRow] = crew;
		if (!hostRow || !helperRow) throw new Error("fixture");
		host = hostRow;
		helper = helperRow;
		const opened = await chats.getOrCreate({
			workspaceId,
			podId,
			hostAgentId: host.id,
			userId: memberId,
		});
		hostChatId = opened.id;
		await chats.sendMain({
			chatId: opened.id,
			author: { id: memberId, name: "Sam", image: null },
			messageId: crypto.randomUUID(),
			content: "Please look into the release",
		});
		rootThreadId = opened.mainThreadId;
		const helperChat = await chats.getOrCreate({
			workspaceId,
			podId,
			hostAgentId: helper.id,
			userId: memberId,
		});
		helperChatId = helperChat.id;
		helperMainThreadId = helperChat.mainThreadId;
		reply = await openReply(rootThreadId, host.id);
	});

	/** Claims the queued turn for a thread's host and prepares it, so a reply message exists. */
	async function openReply(threadId: string, agentId: string) {
		const [queued] = await onDatabase((db) =>
			db
				.select()
				.from(job)
				.where(and(eq(job.threadId, threadId), eq(job.status, "queued"))),
		);
		if (!queued || !("agentId" in queued.payload && "triggerMessageId" in queued.payload))
			throw new Error("no turn queued");
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, queued.id)),
		);
		const prepared = await turns.prepare({
			id: queued.id,
			threadId,
			payload: queued.payload,
			dedupeKey: queued.dedupeKey,
			attempts: 1,
		});
		return {
			turnId: prepared.turnId,
			messageId: prepared.responseMessage.id,
			agentId,
			context: prepared.context,
		};
	}

	const from = (atOffset = 0) => ({
		threadId: rootThreadId,
		agentId: host.id,
		turnId: reply.turnId,
		messageId: reply.messageId,
		atOffset,
	});

	it("opens the collaborator's thread with the brief, and records the collaboration on the reply", async () => {
		const opened = await collaborations.open({
			from: from(7),
			to: helper.name.toUpperCase(),
			brief: "Check the changelog\nfor anything alarming",
		});

		expect(opened.collaborator).toEqual(helper);
		expect(opened.collaboration).toMatchObject({
			type: "collaboration",
			agentId: helper.id,
			agentName: helper.name,
			status: "waiting",
			answer: null,
			atOffset: 7,
		});
		const child = await threads.getVisible(opened.collaboration.threadId, memberId);
		expect(child?.thread).toMatchObject({
			parentThreadId: rootThreadId,
			hostAgentId: helper.id,
			title: "Check the changelog",
			status: "running",
		});
		expect(child?.messages).toMatchObject([
			{
				author: { kind: "agent", id: host.id },
				content: "Check the changelog\nfor anything alarming",
			},
		]);
		expect(child?.participants.map(({ id }) => id)).toEqual([host.id, helper.id]);
		// Child threads hang off their parent rather than appearing beside either Chat.
		const visibleThreadIds = (await threads.listVisible(workspaceId, memberId)).map(({ id }) => id);
		expect(visibleThreadIds).toEqual(expect.arrayContaining([rootThreadId, helperMainThreadId]));
		expect(visibleThreadIds).toHaveLength(2);
		const queued = await onDatabase((db) =>
			db.select().from(job).where(eq(job.threadId, opened.collaboration.threadId)),
		);
		expect(queued).toMatchObject([
			{ kind: "turn", status: "queued", payload: { agentId: helper.id } },
		]);
		expect((await chats.messages(helperChatId, memberId))?.items).toEqual([
			expect.objectContaining({
				kind: "collaboration",
				threadId: opened.collaboration.threadId,
				initiator: expect.objectContaining({ id: host.id }),
			}),
		]);
		expect((await chats.history(helperChatId, memberId))?.items).toEqual([
			expect.objectContaining({ threadId: opened.collaboration.threadId }),
		]);
		const recipientEvents = await onDatabase((db) =>
			db
				.select({ payload: event.payload })
				.from(event)
				.where(eq(event.channel, workspaceChannel(workspaceId))),
		);
		expect(recipientEvents.map(({ payload }) => payload)).toContainEqual(
			expect.objectContaining({
				type: "chat.thread_changed",
				chatId: helperChatId,
				threadId: opened.collaboration.threadId,
			}),
		);
	});

	it("composes the collaboration into the reply's parts where it was made", async () => {
		const opened = await collaborations.open({ from: from(6), to: helper.name, brief: "Look" });
		await turns.saveStreamingMessage({ responseMessage: { id: reply.messageId } } as never, {
			content: "Hello. Asking now.",
			collaborations: [{ id: opened.collaboration.id, atOffset: 6 }],
			toolCalls: [],
		});

		const parent = await threads.getVisible(rootThreadId, memberId);
		const replyMessage = parent?.messages.find(({ id }) => id === reply.messageId);
		expect(replyMessage?.parts).toEqual([
			{ type: "text", text: "Hello." },
			expect.objectContaining({
				type: "collaboration",
				id: opened.collaboration.id,
				status: "waiting",
			}),
			{ type: "text", text: " Asking now." },
		]);
	});

	it("refuses what policy forbids, writing nothing", async () => {
		await expect(collaborations.open({ from: from(), to: "Nobody", brief: "?" })).rejects.toThrow(
			CollaborationRefused,
		);
		await expect(collaborations.open({ from: from(), to: host.name, brief: "?" })).rejects.toThrow(
			/cannot collaborate with itself/,
		);
		const rows = await onDatabase((db) =>
			db.select().from(thread).where(eq(thread.parentThreadId, rootThreadId)),
		);
		expect(rows).toHaveLength(0);
	});

	it("allows one collaboration per turn, and never back up the chain", async () => {
		const first = await collaborations.open({ from: from(), to: helper.name, brief: "One" });
		await expect(
			collaborations.open({ from: from(), to: helper.name, brief: "Two" }),
		).rejects.toThrow(/one collaboration per turn/i);

		// The helper, in its child thread, may not ask the host back: the host is
		// the one waiting on it.
		const helperReply = await openReply(first.collaboration.threadId, helper.id);
		await expect(
			collaborations.open({
				from: {
					threadId: first.collaboration.threadId,
					agentId: helper.id,
					turnId: helperReply.turnId,
					messageId: helperReply.messageId,
					atOffset: 0,
				},
				to: host.name,
				brief: "Back",
			}),
		).rejects.toThrow(/already waiting on this thread/);
	});

	it("records the answer without a resume turn while the asker is still waiting", async () => {
		const opened = await collaborations.open({ from: from(), to: helper.name, brief: "Look" });
		expect(await collaborations.readAnswer(opened.collaboration.id)).toBeUndefined();

		await collaborations.deliverAnswer({
			threadId: opened.collaboration.threadId,
			answer: "Nothing alarming.",
		});

		expect(await collaborations.readAnswer(opened.collaboration.id)).toBe("Nothing alarming.");
		expect(await collaborations.stopWaiting(opened.collaboration.id)).toBe(false);
		const resumes = await onDatabase((db) =>
			db
				.select()
				.from(job)
				.where(and(eq(job.threadId, rootThreadId), eq(job.status, "queued"))),
		);
		expect(resumes).toHaveLength(0);
	});

	it("keeps a collaboration in model history when the thread has a summary", async () => {
		const opened = await collaborations.open({ from: from(6), to: helper.name, brief: "Look" });
		await collaborations.deliverAnswer({
			threadId: opened.collaboration.threadId,
			answer: "Nothing alarming.",
		});
		await onDatabase((db) =>
			db
				.update(message)
				.set({
					status: "complete",
					content: "I checked.",
					parts: [
						{ type: "text", text: "I asked for help." },
						{ type: "collaboration", collaborationId: opened.collaboration.id },
						{ type: "text", text: " Everything is fine." },
					],
				})
				.where(eq(message.id, reply.messageId)),
		);
		await onDatabase((db) =>
			db
				.update(turn)
				.set({ status: "done", finishedAt: new Date() })
				.where(eq(turn.id, reply.turnId)),
		);
		await onDatabase((db) =>
			db
				.update(job)
				.set({ status: "done" })
				.where(and(eq(job.threadId, rootThreadId), eq(job.status, "running"))),
		);
		await onDatabase((db) =>
			db.insert(threadSummary).values({
				threadId: rootThreadId,
				sourceMessageId: reply.messageId,
				content: "The release was checked.",
			}),
		);
		await chats.sendMain({
			chatId: hostChatId,
			author: { id: memberId, name: "Sam", image: null },
			messageId: crypto.randomUUID(),
			content: "Who did you ask?",
		});

		const next = await openReply(rootThreadId, host.id);
		const covered = next.context.messages.find(({ id }) => id === reply.messageId);

		expect(next.context).not.toHaveProperty("summary");
		expect(covered?.parts).toEqual([
			{ type: "text", text: "I asked for help." },
			expect.objectContaining({
				type: "collaboration",
				agentId: helper.id,
				brief: "Look",
				status: "answered",
				answer: "Nothing alarming.",
			}),
			{ type: "text", text: " Everything is fine." },
		]);
		const promptMessages = modelPrompt(next.context, {
			now: new Date(),
			builtInTools: [],
			connectionTools: [],
		}).messages;
		expect(promptMessages).toContainEqual(
			expect.objectContaining({
				role: "user",
				content: expect.stringContaining(
					`[Platform collaboration record: ${helper.name} answered: Nothing alarming.]`,
				),
			}),
		);
		expect(
			promptMessages
				.filter(({ role }) => role === "assistant")
				.every(({ content }) => !content.includes("Platform collaboration record")),
		).toBe(true);
	});

	it("queues a turn for the asker when the answer arrives after it stopped waiting", async () => {
		const opened = await collaborations.open({ from: from(), to: helper.name, brief: "Look" });
		expect(await collaborations.stopWaiting(opened.collaboration.id)).toBe(true);

		await collaborations.deliverAnswer({
			threadId: opened.collaboration.threadId,
			answer: "Late, but fine.",
		});

		const resumes = await onDatabase((db) =>
			db
				.select()
				.from(job)
				.where(and(eq(job.threadId, rootThreadId), eq(job.status, "queued"))),
		);
		expect(resumes).toMatchObject([
			{ kind: "turn", payload: { agentId: host.id, triggerMessageId: reply.messageId } },
		]);
		const [row] = await onDatabase((db) => db.select().from(turn).where(eq(turn.id, reply.turnId)));
		expect(row?.status).toBe("running");
	});
});

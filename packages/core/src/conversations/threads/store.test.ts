import { handleFromName, threadChannel } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "../../database/database.ts";
import { createEventBus } from "../../database/events/bus.ts";
import { eventPublisher } from "../../database/events/publish.ts";
import { postgresEventStore } from "../../database/events/store.ts";
import {
	agent,
	event,
	job,
	message,
	pod,
	podMember,
	thread,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { agentStore } from "../../workspaces/agents/store.ts";
import { SYSTEM_AGENTS } from "../../workspaces/agents/system-agents.ts";
import { podStore } from "../../workspaces/pods/store.ts";
import { chatStore } from "../chats/store.ts";
import { renewJobLeases } from "../jobs/queue.ts";
import { queueSummary, summaryStore } from "../summaries/store.ts";
import { loadFacilitatorScope } from "../turns/facilitator.ts";
import { queueTurn, turnStore } from "../turns/store.ts";
import { threadStore } from "./store.ts";

/** What these tests set the workspace's system agents up with. */
const SYSTEM_AGENT_MODEL = "test-model";

const eventStore = await runOnPostgres(postgresEventStore);

describe.skipIf(!process.env.DATABASE_URL)("threads, against Postgres", () => {
	const eventBus = createEventBus({ store: eventStore });
	const publishEvents = eventPublisher(eventBus);
	const store = onPostgres(threadStore());
	const chats = onPostgres(chatStore(publishEvents));
	const turns = onPostgres(turnStore(publishEvents));
	const summaries = onPostgres(summaryStore(publishEvents));
	let workspaceId: string;
	let podId: string;
	let agentId: string;
	let memberId: string;
	let authors: Map<string, { id: string; name: string; image: string | null }>;
	/** A message author, as the route would pass them. */
	const author = (id: string) => {
		const person = authors.get(id);
		if (!person) throw new Error(`No test person ${id}`);
		return person;
	};
	let outsiderId: string;

	async function createThread(input: {
		workspaceId: string;
		podId: string;
		hostAgentId: string;
		initiatorUserId: string;
		message: string;
	}) {
		const opened = await chats.getOrCreate({
			workspaceId: input.workspaceId,
			podId: input.podId,
			hostAgentId: input.hostAgentId,
			userId: input.initiatorUserId,
		});
		await chats.sendMain({
			chatId: opened.id,
			author: author(input.initiatorUserId),
			messageId: crypto.randomUUID(),
			content: input.message,
		});
		const details = await store.getVisible(opened.mainThreadId, input.initiatorUserId);
		if (!details) throw new Error("Created Chat thread is not visible");
		return details;
	}

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		// The queue is global, so `claimNext` would otherwise hand back whatever
		// an earlier run left queued. This is the only test file that queues jobs,
		// and vitest runs a file's cases one after another.
		await onDatabase((db) => db.delete(job));
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [workspaceRow] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Thread test ${suffix}`, slug: `thread-test-${suffix}` })
				.returning(),
		);
		const people = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Sam", email: `thread-sam-${suffix}@example.com` },
					{ name: "Kim", email: `thread-kim-${suffix}@example.com` },
				])
				.returning(),
		);
		const [member, outsider] = people;
		if (!workspaceRow || !member || !outsider) {
			throw new Error("Could not create thread test records");
		}
		workspaceId = workspaceRow.id;
		memberId = member.id;
		outsiderId = outsider.id;
		authors = new Map(people.map((person) => [person.id, person]));

		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: memberId },
				{ workspaceId, userId: outsiderId },
			]),
		);
		const [podRow] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: memberId,
					kind: "shared",
					name: "Suga-Team",
					slug: `suga-${suffix}`,
					createdById: memberId,
				})
				.returning(),
		);
		const [agentRow] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId: podRow?.id ?? "",
					name: `Release agent ${suffix}`,
					handle: handleFromName(`Release agent ${suffix}`),
					color: "green",
					face: "pill",
					model: "claude-opus-4-1-20250805",
					createdById: memberId,
				})
				.returning(),
		);
		if (!podRow || !agentRow) {
			throw new Error("Could not create thread scope");
		}
		podId = podRow.id;
		agentId = agentRow.id;
		await onDatabase((db) => db.insert(podMember).values({ workspaceId, podId, userId: memberId }));
		// The system agents belong to the workspace, not to the pod, and each is
		// set up by being given a model.
		const placed = await onDatabase((db) =>
			db
				.insert(agent)
				.values(
					SYSTEM_AGENTS.map((definition) => ({
						workspaceId,
						podId: null,
						createdById: memberId,
						name: definition.name,
						handle: handleFromName(definition.name),
						systemAgentKey: definition.key,
						description: definition.description,
						color: definition.color,
						face: definition.face,
						model: SYSTEM_AGENT_MODEL,
						prompt: definition.prompt,
					})),
				)
				.returning({ id: agent.id }),
		);
		if (placed.length !== SYSTEM_AGENTS.length) {
			throw new Error("Could not create the workspace's system agents");
		}
	});

	it("prepares a turn for crew who are not the thread's host", async () => {
		// A shared thread gives the floor to whichever crew agent the router or a
		// mention picks. Only the host could take a turn, so every routed turn was
		// discarded as "the thread or its host agent no longer exists" and the
		// person saw a reply that never arrived.
		const [otherRow] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId,
					name: `Second agent ${Date.now()}`,
					handle: handleFromName(`Second agent ${Date.now()}`),
					color: "teal",
					face: "dot",
					model: "claude-opus-4-1-20250805",
					createdById: memberId,
				})
				.returning({ id: agent.id }),
		);
		if (!otherRow) throw new Error("Could not create the second agent");

		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Who should answer this?",
		});
		await runOnPostgres(
			queueTurn({
				threadId: details.thread.id,
				agentId: otherRow.id,
				triggerMessageId: details.messages[0]?.id ?? "",
				reason: "mention",
			}),
		);
		const [queued] = (await onDatabase((db) => db.select().from(job))).filter(
			(row) =>
				row.kind === "turn" &&
				row.threadId === details.thread.id &&
				"agentId" in row.payload &&
				row.payload.agentId === otherRow.id,
		);
		if (!queued || !("triggerMessageId" in queued.payload) || !("reason" in queued.payload)) {
			throw new Error("The turn for the second agent was not queued");
		}
		const payload = queued.payload;

		const prepared = await turns.prepare({
			id: queued.id,
			threadId: queued.threadId,
			payload,
			dedupeKey: queued.dedupeKey,
			attempts: 1,
		});

		expect(prepared.context.agent.id).toBe(otherRow.id);
	});

	it("summarises a thread after a reply from crew who are not its host", async () => {
		// The summary is about the thread, not about whoever spoke last. Tying it
		// to the host meant a shared thread stopped being summarised as soon as
		// anyone else replied.
		const [otherRow] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId,
					name: `Third agent ${Date.now()}`,
					handle: handleFromName(`Third agent ${Date.now()}`),
					color: "orange",
					face: "dot",
					model: "claude-opus-4-1-20250805",
					createdById: memberId,
				})
				.returning({ id: agent.id }),
		);
		if (!otherRow) throw new Error("Could not create the third agent");

		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Anything to summarise?",
		});
		const sourceMessageId = details.messages[0]?.id;
		if (!sourceMessageId) throw new Error("The thread has no first message");
		await runOnPostgres(
			queueSummary({ threadId: details.thread.id, agentId: otherRow.id, sourceMessageId }),
		);
		const [queued] = (await onDatabase((db) => db.select().from(job))).filter(
			(row) => row.kind === "thread_summary" && row.threadId === details.thread.id,
		);
		if (!queued || !("sourceMessageId" in queued.payload)) {
			throw new Error("The summary was not queued");
		}

		const prepared = await summaries.prepare({
			id: queued.id,
			threadId: queued.threadId,
			payload: queued.payload,
			dedupeKey: queued.dedupeKey,
			attempts: 1,
		});

		expect(prepared.threadId).toBe(details.thread.id);
	});

	it("keeps the agent who just spoke off the router's list", async () => {
		// Two agents answering each other in turn is the loop this prevents: the
		// router picked the same agent again, and again, until the run cap.
		const [otherRow] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId,
					name: `Fourth agent ${Date.now()}`,
					handle: handleFromName(`Fourth agent ${Date.now()}`),
					color: "yellow",
					face: "dot",
					model: "claude-opus-4-1-20250805",
					createdById: memberId,
				})
				.returning({ id: agent.id }),
		);
		if (!otherRow) throw new Error("Could not create the fourth agent");

		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Who is talking?",
		});
		const [reply] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: details.thread.id,
					authorAgentId: otherRow.id,
					kind: "text",
					status: "complete",
					content: "I just said something.",
					parts: [{ type: "text", text: "I just said something." }],
				})
				.returning({ id: message.id }),
		);
		if (!reply) throw new Error("Could not record the reply");

		const scope = await runOnPostgres(
			query((executor) => loadFacilitatorScope(executor, details.thread.id, reply.id)),
		);

		expect(scope?.crew.map((member) => member.id)).not.toContain(otherRow.id);
		expect(scope?.crew.map((member) => member.id)).toContain(agentId);
	});

	it("refuses an agent's turn by name once its model has been cleared", async () => {
		// Cleared after the message is queued: a chat refuses the message itself
		// when the model is already gone, so this is the turn that slips through.
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Anyone there?",
		});
		await onDatabase((db) => db.update(agent).set({ model: null }).where(eq(agent.id, agentId)));
		const [queued] = (await onDatabase((db) => db.select().from(job))).filter(
			(row) => row.kind === "turn" && row.threadId === details.thread.id,
		);
		if (!queued || !("triggerMessageId" in queued.payload) || !("reason" in queued.payload)) {
			throw new Error("The turn was not queued");
		}

		// It stops rather than falling back to some other model, and the reason
		// names the agent so somebody can go and fix it.
		await expect(
			turns.prepare({
				id: queued.id,
				threadId: queued.threadId,
				payload: queued.payload,
				dedupeKey: queued.dedupeKey,
				attempts: 1,
			}),
		).rejects.toThrow("has no model chosen");
	});

	it("does not facilitate at all until the workspace has chosen a Facilitator model", async () => {
		// The old arrangement borrowed the host agent's model here, which put a
		// question nobody asked in front of a model nobody chose for the job.
		await onDatabase((db) =>
			db
				.update(agent)
				.set({ model: null })
				.where(and(eq(agent.workspaceId, workspaceId), eq(agent.systemAgentKey, "facilitate"))),
		);
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Who is talking?",
		});
		const first = details.messages[0];
		if (!first) throw new Error("The thread has no message to facilitate from");

		const scope = await runOnPostgres(
			query((executor) => loadFacilitatorScope(executor, details.thread.id, first.id)),
		);

		expect(scope).toBeUndefined();
	});

	it("loads a Chat thread with its participants and first message", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Check the release\nPay attention to migrations.",
		});

		expect(details.thread.title).toBe("Chat");
		expect(details.participants.map(({ kind }) => kind)).toEqual(["person", "agent"]);
		expect(details.messages).toMatchObject([
			{
				author: { kind: "person", id: memberId },
				content: "Check the release\nPay attention to migrations.",
				parts: [{ type: "text", text: "Check the release\nPay attention to migrations." }],
			},
		]);
		const queuedTurns = (await onDatabase((db) => db.select().from(job))).filter(
			(queued) => queued.threadId === details.thread.id,
		);
		expect(queuedTurns).toMatchObject([
			{
				kind: "turn",
				status: "queued",
				threadId: details.thread.id,
				payload: { agentId, triggerMessageId: details.messages[0]?.id },
			},
		]);
	});

	it("pages a large history without gaps at equal-timestamp boundaries", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Message 000",
		});
		const firstMessageId = details.messages[0]?.id;
		if (!firstMessageId) {
			throw new Error("Thread test has no first message");
		}
		const firstCreatedAt = new Date("2026-09-10T03:59:59.000Z");
		const sharedCreatedAt = new Date("2026-09-10T04:00:00.000Z");
		await onDatabase((db) =>
			db.update(message).set({ createdAt: firstCreatedAt }).where(eq(message.id, firstMessageId)),
		);
		const historyIdPrefix = crypto.randomUUID().slice(0, 24);
		const historyIds = Array.from(
			{ length: 124 },
			(_, index) => `${historyIdPrefix}${(index + 1).toString(16).padStart(12, "0")}`,
		);
		await onDatabase((db) =>
			db.insert(message).values(
				historyIds.map((id, index) => ({
					id,
					threadId: details.thread.id,
					authorUserId: memberId,
					kind: "text" as const,
					status: "complete" as const,
					parts: [{ type: "text" as const, text: `Message ${String(index + 1).padStart(3, "0")}` }],
					content: `Message ${String(index + 1).padStart(3, "0")}`,
					createdAt: sharedCreatedAt,
				})),
			),
		);
		await onDatabase((db) =>
			db.insert(turn).values(
				historyIds.map((triggerMessageId) => ({
					threadId: details.thread.id,
					agentId,
					triggerMessageId,
					status: "done" as const,
					model: "test/model",
					usage: { modelCalls: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5 },
					reportedCost: "0.01",
					startedAt: sharedCreatedAt,
					finishedAt: sharedCreatedAt,
				})),
			),
		);

		const pages = [];
		let cursor: string | undefined;
		do {
			const page = await store.getVisible(details.thread.id, memberId, { limit: 50, cursor });
			if (!page) {
				throw new Error("Thread history disappeared");
			}
			pages.push(page);
			cursor = page.olderMessagesCursor ?? undefined;
		} while (cursor);

		expect(pages.map((page) => page.messages.length)).toEqual([50, 50, 25]);
		const allMessages = [...pages].reverse().flatMap((page) => page.messages);
		expect(new Set(allMessages.map(({ id }) => id)).size).toBe(125);
		expect(allMessages.map(({ content }) => content)).toEqual([
			"Message 000",
			...historyIds.map((_, index) => `Message ${String(index + 1).padStart(3, "0")}`),
		]);
		await expect(
			store.getVisible(details.thread.id, memberId, { limit: 50, cursor: "not-a-cursor" }),
		).rejects.toThrow("cursor is invalid");
	});

	it("replays a committed message after reconnect", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "First",
		});
		const channel = threadChannel(details.thread.id);
		const [resumePoint] = await eventStore.replay(channel, 0, 10);
		if (!resumePoint) {
			throw new Error("Thread creation did not commit its durable event");
		}

		const messageId = crypto.randomUUID();
		if (!details.thread.chatId) throw new Error("Chat thread has no Chat");
		await chats.sendMain({
			chatId: details.thread.chatId,
			author: author(memberId),
			messageId,
			content: "Second",
		});

		const iterator = eventBus
			.subscribe(channel, { since: resumePoint.seq })
			[Symbol.asyncIterator]();
		const replayed = await iterator.next();
		await iterator.return?.();
		expect(replayed.value?.event).toMatchObject({
			type: "message.created",
			message: { id: messageId, content: "Second" },
		});
	});

	it("rejects thread pods and hosts from another workspace at the database boundary", async () => {
		const [otherWorkspace] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Other thread workspace", slug: `other-thread-${crypto.randomUUID()}` })
				.returning(),
		);
		if (!otherWorkspace) {
			throw new Error("Could not create other thread workspace");
		}
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: otherWorkspace.id, userId: memberId }),
		);
		const [foreignPod] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: otherWorkspace.id,
					ownerId: memberId,
					kind: "shared",
					name: "Foreign",
					slug: "foreign",
				})
				.returning(),
		);
		const [foreignAgent] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId: otherWorkspace.id,
					podId: foreignPod?.id ?? "",
					name: "Foreign agent",
					handle: "foreign-agent",
					color: "rose",
					face: "pill",
					model: "test/model",
				})
				.returning(),
		);
		if (!foreignPod || !foreignAgent) {
			throw new Error("Could not create foreign thread scope");
		}

		await expect(
			onDatabase((db) =>
				db.insert(thread).values({
					workspaceId,
					podId: foreignPod.id,
					hostAgentId: agentId,
					type: "chat",
					title: "Foreign pod",
					initiatorUserId: memberId,
				}),
			),
		).rejects.toThrow();
		await expect(
			onDatabase((db) =>
				db.insert(thread).values({
					workspaceId,
					podId,
					hostAgentId: foreignAgent.id,
					type: "chat",
					title: "Foreign host",
					initiatorUserId: memberId,
				}),
			),
		).rejects.toThrow();
	});

	it("deletes hosted thread history with its host agent", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Keep this history",
		});

		await onPostgres(agentStore).remove(workspaceId, agentId);
		expect(
			await onDatabase((db) => db.select().from(thread).where(eq(thread.id, details.thread.id))),
		).toHaveLength(0);
		await expect(onPostgres(podStore).remove(workspaceId, podId)).resolves.toBeUndefined();
	});

	it("adds each human sender to the participant stack", async () => {
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId, podId, userId: outsiderId }),
		);
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "First",
		});

		if (!details.thread.chatId) throw new Error("Chat thread has no Chat");
		await chats.sendMain({
			chatId: details.thread.chatId,
			author: author(outsiderId),
			messageId: crypto.randomUUID(),
			content: "I can help",
		});

		expect((await store.getVisible(details.thread.id, memberId))?.participants).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "person", id: outsiderId })]),
		);
	});

	it("counts a quiet thread's latest messages as recent, and a busy thread's last week", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Latest",
		});
		const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const written = (author: { authorUserId: string } | { authorAgentId: string }, at: Date) => ({
			threadId: details.thread.id,
			...author,
			kind: "text" as const,
			status: "complete" as const,
			parts: [{ type: "text" as const, text: "Earlier" }],
			content: "Earlier",
			createdAt: at,
		});
		await onDatabase((db) =>
			db
				.insert(message)
				.values([
					written({ authorUserId: outsiderId }, daysAgo(30)),
					written({ authorAgentId: agentId }, daysAgo(3)),
				]),
		);
		const recentIds = async () =>
			(await store.activity(details.thread.id, memberId))?.recentParticipants.map(({ id }) => id);

		expect(await recentIds()).toEqual([memberId, agentId, outsiderId]);

		await onDatabase((db) =>
			db
				.insert(message)
				.values(Array.from({ length: 100 }, () => written({ authorUserId: memberId }, daysAgo(1)))),
		);
		expect(await recentIds()).toEqual([memberId, agentId]);
	});

	it("queues and persists a fresh summary after a completed exchange", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Summarize this thread",
		});
		const [turnJob] = (await onDatabase((db) => db.select().from(job))).filter(
			(row) => row.kind === "turn" && row.threadId === details.thread.id,
		);
		if (!turnJob || !("agentId" in turnJob.payload && "triggerMessageId" in turnJob.payload)) {
			throw new Error("Thread test has no turn job");
		}
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, turnJob.id)),
		);
		const preparedTurn = await turns.prepare({
			id: turnJob.id,
			threadId: turnJob.threadId,
			payload: turnJob.payload,
			dedupeKey: turnJob.dedupeKey,
			attempts: 1,
		});
		if (!preparedTurn) {
			throw new Error("Thread test could not prepare its turn");
		}
		await turns.complete(
			preparedTurn,
			{ content: "The work is complete.", collaborations: [], toolCalls: [] },
			{
				usage: { modelCalls: 1, inputTokens: 30, outputTokens: 5, totalTokens: 35 },
				contextTokens: 30,
				contextCapacity: 200_000,
			},
		);
		await turns.queueSummary(preparedTurn);

		const [summaryJob] = (await onDatabase((db) => db.select().from(job))).filter(
			(row) => row.kind === "thread_summary" && row.threadId === details.thread.id,
		);
		if (!summaryJob || !("sourceMessageId" in summaryJob.payload)) {
			throw new Error("Completed turn did not queue a thread summary");
		}
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, summaryJob.id)),
		);
		const preparedSummary = await summaries.prepare({
			id: summaryJob.id,
			threadId: summaryJob.threadId,
			payload: summaryJob.payload,
			dedupeKey: summaryJob.dedupeKey,
			attempts: 1,
		});
		if (!preparedSummary) {
			throw new Error("Thread test could not prepare its summary");
		}
		expect(preparedSummary.model).toBe(SYSTEM_AGENT_MODEL);

		// The summariser works in its own thread hanging off the one it summarises,
		// so its turns never appear in the conversation people are having.
		const [summaryTurn] = await onDatabase((db) =>
			db.select({ threadId: turn.threadId }).from(turn).where(eq(turn.id, preparedSummary.turnId)),
		);
		expect(summaryTurn?.threadId).not.toBe(details.thread.id);
		const [systemAgentThread] = await onDatabase((db) =>
			db
				.select({ systemAgentKey: thread.systemAgentKey, parentThreadId: thread.parentThreadId })
				.from(thread)
				.where(eq(thread.id, summaryTurn?.threadId as string)),
		);
		expect(systemAgentThread).toMatchObject({
			systemAgentKey: "summarise",
			parentThreadId: details.thread.id,
		});

		// And it stays out of the pod's thread list.
		const listed = await store.listVisible(workspaceId, memberId);
		expect(listed.some((row) => row.id === summaryTurn?.threadId)).toBe(false);
		expect(listed.some((row) => row.id === details.thread.id)).toBe(true);
		await summaries.complete(
			preparedSummary,
			{ title: "Verify the release", content: "The release work is complete." },
			{
				usage: { modelCalls: 1, inputTokens: 40, outputTokens: 6, totalTokens: 46 },
				contextTokens: 1_000,
			},
		);

		const refreshed = await store.getVisible(details.thread.id, memberId);
		expect(refreshed?.thread.title).toBe("Verify the release");
		// The thread holding the summaries is named after its parent, and the
		// first summary is what gives the parent a real title — so without this
		// its own name kept the sentence somebody originally typed.
		const [summariesThread] = await onDatabase((db) =>
			db
				.select({ title: thread.title })
				.from(thread)
				.where(
					and(eq(thread.parentThreadId, details.thread.id), eq(thread.systemAgentKey, "summarise")),
				),
		);
		expect(summariesThread?.title).toBe("Summaries of Verify the release");
		expect((await store.activity(details.thread.id, memberId))?.summary).toMatchObject({
			content: "The release work is complete.",
			sourceMessageId: preparedTurn.responseMessage.id,
		});

		if (!details.thread.chatId) throw new Error("Chat thread has no Chat");
		await chats.sendMain({
			chatId: details.thread.chatId,
			author: author(memberId),
			messageId: crypto.randomUUID(),
			content: "What remains?",
		});
		const [nextTurnJob] = (await onDatabase((db) => db.select().from(job))).filter(
			(row) => row.kind === "turn" && row.status === "queued" && row.threadId === details.thread.id,
		);
		if (
			!nextTurnJob ||
			!("agentId" in nextTurnJob.payload && "triggerMessageId" in nextTurnJob.payload)
		) {
			throw new Error("Thread test has no follow-up turn job");
		}
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, nextTurnJob.id)),
		);
		const nextTurn = await turns.prepare({
			id: nextTurnJob.id,
			threadId: nextTurnJob.threadId,
			payload: nextTurnJob.payload,
			dedupeKey: nextTurnJob.dedupeKey,
			attempts: 1,
		});
		if (!nextTurn) {
			throw new Error("Thread test could not prepare its follow-up turn");
		}
		expect(nextTurn.context).not.toHaveProperty("summary");
		expect(nextTurn.context.messages.map(({ content }) => content)).toEqual([
			"Summarize this thread",
			"The work is complete.",
			"What remains?",
		]);
		await turns.complete(
			nextTurn,
			{ content: "Only approval remains.", collaborations: [], toolCalls: [] },
			{ usage: {} },
		);
		await turns.queueSummary(nextTurn);
		const [nextSummaryJob] = (await onDatabase((db) => db.select().from(job))).filter(
			(row) =>
				row.kind === "thread_summary" &&
				row.status === "queued" &&
				row.threadId === details.thread.id,
		);
		if (!nextSummaryJob || !("sourceMessageId" in nextSummaryJob.payload)) {
			throw new Error("Thread test has no follow-up summary job");
		}
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, nextSummaryJob.id)),
		);
		const nextSummary = await summaries.prepare({
			id: nextSummaryJob.id,
			threadId: nextSummaryJob.threadId,
			payload: nextSummaryJob.payload,
			dedupeKey: nextSummaryJob.dedupeKey,
			attempts: 1,
		});
		expect(nextSummary).toMatchObject({
			previousContent: "The release work is complete.",
			transcript: [
				{ content: "Summarize this thread" },
				{ content: "The work is complete." },
				{ content: "What remains?" },
				{ content: "Only approval remains." },
			],
		});
		if (nextSummary) {
			await summaries.complete(nextSummary, { content: "Only approval remains." }, { usage: {} });
		}
		expect((await store.getVisible(details.thread.id, memberId))?.thread.title).toBe(
			"Verify the release",
		);
	});

	it("requests cancellation only once while an authorized turn remains active", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Wait for review",
		});
		const [turnJob] = (await onDatabase((db) => db.select().from(job))).filter(
			(row) => row.kind === "turn" && row.threadId === details.thread.id,
		);
		if (!turnJob || !("agentId" in turnJob.payload && "triggerMessageId" in turnJob.payload)) {
			throw new Error("Thread test has no turn job");
		}
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, turnJob.id)),
		);
		const prepared = await turns.prepare({
			id: turnJob.id,
			threadId: turnJob.threadId,
			payload: turnJob.payload,
			dedupeKey: turnJob.dedupeKey,
			attempts: 1,
		});
		if (!prepared) {
			throw new Error("Thread test could not prepare its turn");
		}

		expect(await turns.requestCancel(prepared.turnId, memberId)).toBe(true);
		expect(await turns.requestCancel(prepared.turnId, memberId)).toBe(false);
		expect(await turns.requestCancel(prepared.turnId, outsiderId)).toBe(false);
		// Announced once, for the worker waiting on it.
		const announced = await onDatabase((db) =>
			db
				.select({ payload: event.payload })
				.from(event)
				.where(eq(event.type, "turn.cancel_requested")),
		);
		expect(announced.filter(({ payload }) => payload.turnId === prepared.turnId)).toHaveLength(1);
	});

	/** Ages a job's lease past `JOB_LEASE`, as if the process holding it had stopped. */
	const lapseLease = (jobId: string | undefined) =>
		onDatabase((db) =>
			db
				.update(job)
				.set({ lockedAt: sql`now() - interval '2 minutes'` })
				.where(eq(job.id, jobId ?? "")),
		);

	it("claims queued work once and puts back only work whose lease has lapsed", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Queued work",
		});
		const triggerMessageId = details.messages[0]?.id;
		if (!triggerMessageId) {
			throw new Error("Thread test has no trigger message");
		}
		// Asking again for a turn that is already queued keeps the one there.
		await runOnPostgres(
			queueTurn({ threadId: details.thread.id, agentId, triggerMessageId, reason: "default" }),
		);

		const claimed = await turns.claimNext();
		expect(claimed).toMatchObject({
			threadId: details.thread.id,
			payload: { agentId, triggerMessageId },
			attempts: 1,
		});
		expect(await turns.claimNext()).toBeUndefined();
		// Another process may still be running it.
		await turns.requeueInterrupted();
		expect(
			(await onDatabase((db) => db.select().from(job))).filter((row) => row.kind === "turn"),
		).toMatchObject([{ id: claimed?.id, status: "running" }]);
		await lapseLease(claimed?.id);
		await turns.requeueInterrupted();
		expect(
			(await onDatabase((db) => db.select().from(job))).filter((row) => row.kind === "turn"),
		).toMatchObject([{ id: claimed?.id, status: "queued" }]);

		await runOnPostgres(
			queueSummary({ threadId: details.thread.id, agentId, sourceMessageId: triggerMessageId }),
		);
		const claimedSummary = await summaries.claimNext();
		expect(claimedSummary).toMatchObject({
			threadId: details.thread.id,
			payload: { agentId, sourceMessageId: triggerMessageId },
		});
		await lapseLease(claimedSummary?.id);
		await summaries.requeueInterrupted();
		expect(
			(await onDatabase((db) => db.select().from(job))).filter(
				(row) => row.kind === "thread_summary",
			),
		).toMatchObject([{ id: claimedSummary?.id, status: "queued" }]);
	});

	it("keeps a job whose worker renewed its lease", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Long-running work",
		});
		const claimed = await turns.claimNext();
		expect(claimed?.threadId).toBe(details.thread.id);
		await lapseLease(claimed?.id);

		await runOnPostgres(renewJobLeases([claimed?.id ?? ""]));
		await turns.requeueInterrupted();

		const [row] = await onDatabase((db) =>
			db
				.select()
				.from(job)
				.where(eq(job.id, claimed?.id ?? "")),
		);
		expect(row?.status).toBe("running");
	});

	it("does not expose a thread to another workspace member outside its pod", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Private to the pod",
		});

		expect(await store.getVisible(details.thread.id, outsiderId)).toBeUndefined();
		expect(await store.listVisible(workspaceId, outsiderId)).toEqual([]);
	});

	it("treats a malformed thread id as absent", async () => {
		expect(await store.getVisible("not-a-uuid", memberId)).toBeUndefined();
	});
});

import { handleFromName, threadChannel } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "../../database/database.ts";
import { createEventBus } from "../../database/events/bus.ts";
import { postgresEventStore } from "../../database/events/store.ts";
import {
	agent,
	event,
	message,
	modelProvider,
	pod,
	podMember,
	providerModel,
	thread,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { ResourceHidden } from "../../workspaces/access.ts";
import { AgentRepository } from "../../workspaces/agents/agent-repository.ts";
import { SYSTEM_AGENTS } from "../../workspaces/agents/system-agents.ts";
import { PodRepository } from "../../workspaces/pods/pod-repository.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { Chats } from "../chats/chats.ts";
import { Compactions } from "../compaction/compactions.ts";
import { Summaries } from "../summaries/summaries.ts";
import { conversationsForTests } from "../testing.ts";
import { searchHistoryTool } from "../tools/search-history/tool.ts";
import { TurnCancellation } from "../turns/cancellation.ts";
import { modelPrompt } from "../turns/context.ts";
import { replyTurnOf, TurnExecution } from "../turns/execution.ts";
import { loadFacilitatorScope } from "../turns/facilitator.ts";
import { TurnRepository } from "../turns/repository.ts";
import { prepareRunnable, queueTurnForTests, releaseTurn, runningTurns } from "../turns/testing.ts";
import { ThreadView } from "./thread-view.ts";

/** What these tests set the workspace's system agents up with. */
const SYSTEM_AGENT_MODEL = "test-model";

const eventStore = await runOnPostgres(postgresEventStore);

describe.skipIf(!process.env.DATABASE_URL)("threads, against Postgres", async () => {
	const eventBus = createEventBus({ store: eventStore });
	const conversations = await conversationsForTests(eventBus);
	const viewAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));
	const chatsAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, Chats.Service));
	const cancellationAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, TurnCancellation.Service));
	const turns = onPostgres({ prepare: Context.get(conversations, TurnExecution.Service).prepare });
	const turnRecords = onPostgres(Context.get(conversations, TurnRepository.Service));
	const summaries = onPostgres(Context.get(conversations, Summaries.Service));
	const compactions = onPostgres(Context.get(conversations, Compactions.Service));
	let workspaceId: string;
	let podId: string;
	let agentId: string;
	let memberId: string;
	let outsiderId: string;

	async function createThread(input: {
		workspaceId: string;
		podId: string;
		hostAgentId: string;
		initiatorUserId: string;
		message: string;
	}) {
		const chats = chatsAs(input.initiatorUserId);
		const opened = await chats.open({
			workspace: input.workspaceId,
			podId: input.podId,
			hostAgentId: input.hostAgentId,
		});
		await chats.post({
			chatId: opened.id,
			messageId: crypto.randomUUID(),
			content: input.message,
		});
		return viewAs(input.initiatorUserId).get(opened.mainThreadId);
	}

	/** The agent's turn running in the thread, as its workflow runs it. */
	async function runningTurn(threadId: string, agent = agentId) {
		const run = (await runOnPostgres(runningTurns(threadId))).find(
			(running) => running.request.agentId === agent,
		);
		if (!run) throw new Error("No turn is running in the thread");
		return run;
	}

	/** Prepares the summary `request` asks for, for a case that needs it to run. */
	async function preparedSummary(request: Parameters<typeof summaries.prepare>[0]) {
		const preparation = await summaries.prepare(request);
		if (preparation._tag !== "Prepared") {
			throw new Error(`Thread test could not prepare its summary: ${preparation.reason}`);
		}
		return preparation;
	}

	/** Prepares the compaction `request` asks for, for a case that needs it to run. */
	async function preparedCompaction(request: Parameters<typeof compactions.prepare>[0]) {
		const preparation = await compactions.prepare(request);
		if (preparation._tag !== "Prepared") {
			throw new Error(`Thread test could not prepare its compaction: ${preparation.reason}`);
		}
		return preparation;
	}

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
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
			queueTurnForTests({
				threadId: details.thread.id,
				agentId: otherRow.id,
				triggerMessageId: details.messages[0]?.id ?? "",
				reason: "mention",
			}),
		);
		const prepared = await prepareRunnable(
			turns,
			await runningTurn(details.thread.id, otherRow.id),
		);

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
		const prepared = await summaries.prepare({
			threadId: details.thread.id,
			agentId: otherRow.id,
			sourceMessageId,
		});

		expect(prepared).toMatchObject({ _tag: "Prepared", threadId: details.thread.id });
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
		const run = await runningTurn(details.thread.id);

		// It stops rather than falling back to some other model, and the reason
		// names the agent so somebody can go and fix it.
		expect(await turns.prepare(run)).toMatchObject({
			_tag: "NotRunnable",
			reason: expect.stringContaining("has no model chosen"),
		});
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

	it("shows a thread as running while its turn lane is busy", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Run as a workflow",
		});
		const statusNow = async () => (await viewAs(memberId).get(details.thread.id))?.thread.status;
		expect(await statusNow()).toBe("running");

		await runOnPostgres(releaseTurn(await runningTurn(details.thread.id)));

		expect(await statusNow()).toBe("done");
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
		expect(await runOnPostgres(runningTurns(details.thread.id))).toMatchObject([
			{
				request: {
					threadId: details.thread.id,
					agentId,
					triggerMessageId: details.messages[0]?.id,
				},
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
			const page = await viewAs(memberId).get(details.thread.id, { limit: 50, cursor });
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
			viewAs(memberId).get(details.thread.id, { limit: 50, cursor: "not-a-cursor" }),
		).rejects.toMatchObject({ _tag: "InvalidThreadHistoryCursor" });
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
		await chatsAs(memberId).post({
			chatId: details.thread.chatId,
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

		const agents = await servedOnPostgres(AgentRepository.Service, AgentRepository.layer);
		const pods = await servedOnPostgres(PodRepository.Service, PodRepository.layer);
		await agents.remove(workspaceId, agentId);
		expect(
			await onDatabase((db) => db.select().from(thread).where(eq(thread.id, details.thread.id))),
		).toHaveLength(0);
		await expect(pods.remove(workspaceId, podId)).resolves.toBeUndefined();
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
		await chatsAs(outsiderId).post({
			chatId: details.thread.chatId,
			messageId: crypto.randomUUID(),
			content: "I can help",
		});

		expect((await viewAs(memberId).get(details.thread.id))?.participants).toEqual(
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
			(await viewAs(memberId).activity(details.thread.id))?.recentParticipants.map(({ id }) => id);

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
		const firstRun = await runningTurn(details.thread.id);
		const preparedTurn = await prepareRunnable(turns, firstRun);
		await turnRecords.complete(
			replyTurnOf(preparedTurn),
			{ content: "The work is complete.", collaborations: [], toolCalls: [] },
			{
				usage: { modelCalls: 1, inputTokens: 30, outputTokens: 5, totalTokens: 35 },
				contextTokens: 30,
				contextCapacity: 200_000,
			},
		);
		await runOnPostgres(releaseTurn(firstRun));
		const firstSummary = await preparedSummary({
			threadId: details.thread.id,
			agentId: preparedTurn.context.agent.id,
			sourceMessageId: preparedTurn.responseMessage.id,
		});
		expect(firstSummary.model).toBe(SYSTEM_AGENT_MODEL);

		// The summariser works in its own thread hanging off the one it summarises,
		// so its turns never appear in the conversation people are having.
		const [summaryTurn] = await onDatabase((db) =>
			db.select({ threadId: turn.threadId }).from(turn).where(eq(turn.id, firstSummary.turnId)),
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
		const listed = await viewAs(memberId).list(workspaceId);
		expect(listed.some((row) => row.id === summaryTurn?.threadId)).toBe(false);
		expect(listed.some((row) => row.id === details.thread.id)).toBe(true);
		await summaries.complete(
			firstSummary,
			{ title: "Verify the release", content: "The release work is complete." },
			{
				usage: { modelCalls: 1, inputTokens: 40, outputTokens: 6, totalTokens: 46 },
				contextTokens: 1_000,
			},
		);

		const refreshed = await viewAs(memberId).get(details.thread.id);
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
		expect((await viewAs(memberId).activity(details.thread.id))?.summary).toMatchObject({
			content: "The release work is complete.",
			sourceMessageId: preparedTurn.responseMessage.id,
		});
		// The Scribe's own turn, measured at 1,000 tokens, is in its child thread, so
		// the context is the crew reply's.
		expect((await viewAs(memberId).activity(details.thread.id))?.context).toEqual({
			usedTokens: 30,
			measuredAt: expect.any(String),
			// The window the reply was read with, as its turn recorded it.
			windowTokens: 200_000,
			compactionLineTokens: 140_000,
			compactedAt: null,
		});

		if (!details.thread.chatId) throw new Error("Chat thread has no Chat");
		await chatsAs(memberId).post({
			chatId: details.thread.chatId,
			messageId: crypto.randomUUID(),
			content: "What remains?",
		});
		const nextTurn = await prepareRunnable(turns, await runningTurn(details.thread.id));
		expect(nextTurn.context).not.toHaveProperty("summary");
		expect(nextTurn.context.messages.map(({ content }) => content)).toEqual([
			"Summarize this thread",
			"The work is complete.",
			"What remains?",
		]);
		await turnRecords.complete(
			replyTurnOf(nextTurn),
			{ content: "Only approval remains.", collaborations: [], toolCalls: [] },
			{ usage: {} },
		);
		const nextSummary = await preparedSummary({
			threadId: details.thread.id,
			agentId: nextTurn.context.agent.id,
			sourceMessageId: nextTurn.responseMessage.id,
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
		await summaries.complete(nextSummary, { content: "Only approval remains." }, { usage: {} });
		expect((await viewAs(memberId).get(details.thread.id))?.thread.title).toBe(
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
		const prepared = await prepareRunnable(turns, await runningTurn(details.thread.id));

		expect(await cancellationAs(memberId).request(prepared.turnId)).toBe(true);
		expect(await cancellationAs(memberId).request(prepared.turnId)).toBe(false);
		await expect(cancellationAs(outsiderId).request(prepared.turnId)).rejects.toThrow(
			ResourceHidden,
		);
		// Announced once, for the worker waiting on it.
		const announced = await onDatabase((db) =>
			db
				.select({ payload: event.payload })
				.from(event)
				.where(eq(event.type, "turn.cancel_requested")),
		);
		expect(announced.filter(({ payload }) => payload.turnId === prepared.turnId)).toHaveLength(1);
	});

	it("does not expose a thread to another workspace member outside its pod", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Private to the pod",
		});

		await expect(viewAs(outsiderId).get(details.thread.id)).rejects.toThrow(ResourceHidden);
		expect(await viewAs(outsiderId).list(workspaceId)).toEqual([]);
	});

	it("compacts a long thread into a summary and the newest messages, and searches what came before", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Plan the trip",
		});
		// Twenty messages of about 10,000 tokens each, written before the one
		// that opened the thread: far past the compaction line between them.
		const long = (index: number) =>
			`${index === 2 ? "The hotel budget is 150 euros a night. " : ""}Message ${index}. ${"word ".repeat(8_000)}`;
		const earlier = await onDatabase((db) =>
			db
				.insert(message)
				.values(
					Array.from({ length: 20 }, (_, index) => ({
						threadId: details.thread.id,
						authorUserId: memberId,
						kind: "text" as const,
						status: "complete" as const,
						parts: [{ type: "text" as const, text: long(index + 1) }],
						content: long(index + 1),
						createdAt: new Date(Date.now() - (20 - index) * 60_000),
					})),
				)
				.returning({ createdAt: message.createdAt }),
		);
		const sourceMessageId = details.messages[0]?.id ?? "";

		const prepared = await preparedCompaction({
			threadId: details.thread.id,
			agentId,
			sourceMessageId,
			readKeptFrom: null,
		});

		// Kept word for word: the newest six long messages and the short one,
		// about a quarter of the window. Summarised: the eleven before them.
		expect(prepared.model).toBe("claude-opus-4-1-20250805");
		expect(prepared.keptFrom).toEqual(earlier[14]?.createdAt);
		expect(prepared.historyStartsAt).toEqual(earlier[3]?.createdAt);
		expect(prepared.transcript.map(({ content }) => content.split(".")[0])).toEqual(
			Array.from({ length: 11 }, (_, index) => `Message ${index + 4}`),
		);
		await compactions.complete(prepared, "The family is planning a trip.", { usage: {} });

		const turn = await prepareRunnable(turns, await runningTurn(details.thread.id));
		expect(turn.context.compaction).toEqual({
			summary: "The family is planning a trip.",
			historyStartsAt: earlier[3]?.createdAt,
			keptFrom: earlier[14]?.createdAt,
		});
		expect(turn.context.messages.map(({ content }) => content.split(".")[0])).toEqual([
			...Array.from({ length: 6 }, (_, index) => `Message ${index + 15}`),
			"Plan the trip",
		]);
		const prompt = modelPrompt(turn.context, {
			now: new Date(),
			builtInTools: [],
			connectionTools: [],
		});
		expect(prompt.messages[0]?.content).toContain("The family is planning a trip.");
		await turnRecords.complete(
			replyTurnOf(turn),
			{ content: "Here is the plan.", collaborations: [], toolCalls: [] },
			{ usage: {}, contextTokens: 70_000 },
		);
		expect((await viewAs(memberId).activity(details.thread.id))?.context).toMatchObject({
			usedTokens: 70_000,
			compactedAt: expect.any(String),
		});

		const search = searchHistoryTool({
			threadId: details.thread.id,
			before: prepared.keptFrom,
			run: runOnPostgres,
		});
		const searchFor = (input: { query?: string; after?: string; before?: string }) =>
			search.execute?.(input, { toolCallId: "search", messages: [] } as never);
		expect(await searchFor({ query: "hotel budget" })).toEqual({
			messages: [
				expect.objectContaining({
					author: "Sam",
					text: expect.stringContaining("The hotel budget is 150 euros a night."),
				}),
			],
			more: false,
		});
		// A time range alone lists what was said then, oldest first.
		const listed = await searchFor({
			after: earlier[0]?.createdAt.toISOString(),
			before: earlier[2]?.createdAt.toISOString(),
		});
		expect(listed).toMatchObject({ more: false });
		expect(
			listed && "messages" in listed ? listed.messages.map(({ text }) => text.split(".")[0]) : [],
		).toEqual(["Message 1", "The hotel budget is 150 euros a night"]);
		// Nothing the bot already reads word for word, however late the range runs.
		const late = await searchFor({ after: earlier[13]?.createdAt.toISOString() });
		expect(
			late && "messages" in late ? late.messages.map(({ text }) => text.split(".")[0]) : [],
		).toEqual(["Message 14"]);
		expect(await searchFor({})).toEqual({
			refused: "Give words to look for, a time range, or both.",
		});

		const readKeptFrom = prepared.keptFrom.toISOString();
		// Nothing new past what the compaction kept: nothing to summarise.
		expect(
			await compactions.prepare({
				threadId: details.thread.id,
				agentId,
				sourceMessageId,
				readKeptFrom,
			}),
		).toMatchObject({ _tag: "Skipped" });

		// Three more long messages push the kept part on. A turn measured before the
		// compaction says nothing about the thread now, so only one that read it counts.
		const later = await onDatabase((db) =>
			db
				.insert(message)
				.values(
					Array.from({ length: 3 }, (_, index) => ({
						threadId: details.thread.id,
						authorUserId: memberId,
						kind: "text" as const,
						status: "complete" as const,
						parts: [{ type: "text" as const, text: long(21 + index) }],
						content: long(21 + index),
						createdAt: new Date(Date.now() + (index + 1) * 60_000),
					})),
				)
				.returning({ id: message.id }),
		);
		const newest = { threadId: details.thread.id, agentId, sourceMessageId: later[2]?.id ?? "" };
		expect(await compactions.prepare({ ...newest, readKeptFrom: null })).toMatchObject({
			_tag: "Skipped",
		});

		// The next compaction carries the first summary forward rather than dropping it.
		const next = await preparedCompaction({ ...newest, readKeptFrom });
		expect(next.previousSummary).toBe("The family is planning a trip.");
		expect(next.historyStartsAt).toEqual(earlier[3]?.createdAt);
		expect(next.keptFrom).toEqual(earlier[17]?.createdAt);
		expect(next.transcript.map(({ content }) => content.split(".")[0])).toEqual([
			"Message 15",
			"Message 16",
			"Message 17",
		]);
	});

	it("searches history in any language: stemmed, as written, and as substrings", async () => {
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Plan the trip",
		});
		const said = [
			"The hotels near the river are all booked.",
			// "was" is an English stop word, so stemmed English search drops it.
			"Was kostet das Hotel pro Nacht?",
			// No spaces between words: full-text search reads this as one token.
			"我们的酒店预算是每晚150欧元。",
			"Discount code: 50%_OFF",
			// "river" only as part of a longer word: a substring match, not a full-text one.
			"Riverside parking is free.",
		];
		await onDatabase((db) =>
			db.insert(message).values(
				said.map((content, index) => ({
					threadId: details.thread.id,
					authorUserId: memberId,
					kind: "text" as const,
					status: "complete" as const,
					parts: [{ type: "text" as const, text: content }],
					content,
					createdAt: new Date(Date.now() - (said.length - index) * 60_000),
				})),
			),
		);
		const search = searchHistoryTool({
			threadId: details.thread.id,
			before: new Date(Date.now() + 60_000),
			run: runOnPostgres,
		});
		const found = async (query: string) => {
			const result = await search.execute?.({ query }, {
				toolCallId: "search",
				messages: [],
			} as never);
			return result && "messages" in result ? result.messages.map(({ text }) => text) : [];
		};

		expect(await found("hotel booking")).toEqual([said[0]]);
		expect(await found("was kostet")).toEqual([said[1]]);
		expect(await found("酒店预算")).toEqual([said[2]]);
		// Wildcards the bot types are taken literally.
		expect(await found("50%_OFF")).toEqual([said[3]]);
		expect(await found("5%OFF")).toEqual([]);
		// A full-text match ranks above one found only as a substring, even a newer one.
		expect(await found("river")).toEqual([said[0], said[4]]);
	});

	/**
	 * A thread of twenty long messages, about 10K tokens each, before its
	 * first, with the bot's model given a 128K window and the system agents'
	 * a 64K one.
	 */
	async function threadWithLongHistory() {
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId,
					name: "Windows",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning({ id: modelProvider.id }),
		);
		if (!provider) throw new Error("Could not create the model provider");
		await onDatabase((db) =>
			db.insert(providerModel).values([
				// Both smaller than the 256K ceiling.
				{
					workspaceId,
					providerId: provider.id,
					modelId: "claude-opus-4-1-20250805",
					contextLength: 128_000,
					enabled: true,
					source: "manual" as const,
				},
				{
					workspaceId,
					providerId: provider.id,
					modelId: SYSTEM_AGENT_MODEL,
					contextLength: 64_000,
					enabled: true,
					source: "manual" as const,
				},
			]),
		);
		const details = await createThread({
			workspaceId,
			podId,
			hostAgentId: agentId,
			initiatorUserId: memberId,
			message: "Plan the trip",
		});
		const long = (index: number) => `Message ${index}. ${"word ".repeat(8_000)}`;
		const earlier = await onDatabase((db) =>
			db
				.insert(message)
				.values(
					Array.from({ length: 20 }, (_, index) => ({
						threadId: details.thread.id,
						authorUserId: memberId,
						kind: "text" as const,
						status: "complete" as const,
						parts: [{ type: "text" as const, text: long(index + 1) }],
						content: long(index + 1),
						createdAt: new Date(Date.now() - (20 - index) * 60_000),
					})),
				)
				.returning({ createdAt: message.createdAt }),
		);
		return { details, earlier };
	}

	it("compacts on the bot's model, sized to its window", async () => {
		const { details, earlier } = await threadWithLongHistory();

		const prepared = await preparedCompaction({
			threadId: details.thread.id,
			agentId,
			sourceMessageId: details.messages[0]?.id ?? "",
			readKeptFrom: null,
		});

		expect(prepared.model).toBe("claude-opus-4-1-20250805");
		// A quarter of the bot's 128K is kept: the three newest long messages.
		expect(prepared.keptFrom).toEqual(earlier[17]?.createdAt);
		// Up to the 89.6K compaction line less what is kept is summarised.
		expect(prepared.transcript.map(({ content }) => content.split(".")[0])).toEqual([
			"Message 13",
			"Message 14",
			"Message 15",
			"Message 16",
			"Message 17",
		]);

		const turn = await prepareRunnable(turns, await runningTurn(details.thread.id));
		expect(turn.context.windowTokens).toBe(128_000);
		await turnRecords.complete(
			replyTurnOf(turn),
			{ content: "Here is the plan.", collaborations: [], toolCalls: [] },
			{ usage: {}, contextTokens: 50_000, contextCapacity: turn.context.windowTokens },
		);
		expect((await viewAs(memberId).activity(details.thread.id))?.context).toMatchObject({
			windowTokens: 128_000,
			compactionLineTokens: 89_600,
		});
	});

	it("compacts for a bot without a model on the system agents' model, capped to its window", async () => {
		const { details, earlier } = await threadWithLongHistory();
		await onDatabase((db) => db.update(agent).set({ model: null }).where(eq(agent.id, agentId)));

		const prepared = await preparedCompaction({
			threadId: details.thread.id,
			agentId,
			sourceMessageId: details.messages[0]?.id ?? "",
			readKeptFrom: null,
		});

		expect(prepared.model).toBe(SYSTEM_AGENT_MODEL);
		// A quarter of the 256K ceiling is kept: the six newest long messages.
		expect(prepared.keptFrom).toEqual(earlier[14]?.createdAt);
		// The 64K model is given at most 60% of its window, three messages,
		// rather than the 115.2K the reader's window alone would allow.
		expect(prepared.transcript.map(({ content }) => content.split(".")[0])).toEqual([
			"Message 12",
			"Message 13",
			"Message 14",
		]);
	});

	it("treats a malformed thread id as absent", async () => {
		await expect(viewAs(memberId).get("not-a-uuid")).rejects.toThrow(ResourceHidden);
	});
});

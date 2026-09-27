import { chatStore } from "@sugabots/core/conversations/chats/store";
import { noBuiltInTools } from "@sugabots/core/conversations/tools/built-in";
import { toolCallStore } from "@sugabots/core/conversations/tools/calls/store";
import { collaborationStore } from "@sugabots/core/conversations/tools/collaborate/store";
import { noConnectionTools } from "@sugabots/core/conversations/tools/connections";
import type { TurnModel } from "@sugabots/core/conversations/turns/model";
import { queueTurnAsJob } from "@sugabots/core/conversations/turns/queue";
import { turnStore } from "@sugabots/core/conversations/turns/store";
import { createEventBus } from "@sugabots/core/database/events/bus";
import { eventPublisher } from "@sugabots/core/database/events/publish";
import { postgresEventStore } from "@sugabots/core/database/events/store";
import {
	agent,
	collaboration,
	job,
	message,
	pod,
	podMember,
	turn,
	user,
	workspace,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { closeDatabase, databaseForTests, onDatabase } from "@sugabots/core/database/testing";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { backgroundLayer } from "./runtime.ts";

/**
 * The whole round trip through the real workers: the host's model calls the
 * collaborate tool, the helper's turn runs on the same worker, and the host's
 * turn should finish as soon as the helper's does, not when the wait expires.
 */
const database = await databaseForTests.context();
const eventStore = await databaseForTests.runPromise(postgresEventStore);

describe.skipIf(!process.env.DATABASE_URL)("a collaboration round trip on the workers", () => {
	const bus = createEventBus({ store: eventStore });
	const publishEvents = eventPublisher(bus);
	const turns = turnStore(publishEvents, queueTurnAsJob);
	const chats = chatStore(publishEvents, queueTurnAsJob);
	const collaborations = collaborationStore(publishEvents, queueTurnAsJob);
	/** Host asks the helper through the tool; helper answers straight away. */
	const model: TurnModel = {
		stream: (input) =>
			Effect.sync(() => ({
				text: (async function* () {
					const collaborate = input.tools?.collaborate;
					if (input.system.startsWith("You are Host") && collaborate?.execute) {
						const result = (await collaborate.execute(
							{ to: "Helper", brief: "What pets do you have?" },
							{ toolCallId: "c1", messages: [] } as never,
						)) as { status: string; answer?: string };
						yield result.status === "answered"
							? `Helper says: ${result.answer}`
							: `Helper has not answered (${result.status}).`;
					} else {
						yield "A dog named Krypto.";
					}
				})(),
				accounting: Effect.succeed({ usage: { modelCalls: 1 } }),
			})),
	};

	const background = backgroundLayer({
		eventStore,
		bus,
		model,
		turns,
		// Summaries run as workflows now; this test is about turns.
		queueSummary: () => Effect.void,
		collaborations,
		calls: toolCallStore(publishEvents),
		builtInTools: noBuiltInTools,
		connectionTools: noConnectionTools,
		publishEvents,
	});
	const runtime = ManagedRuntime.make(
		background.pipe(Layer.provideMerge(Layer.succeedContext(database))),
	);

	afterAll(async () => {
		await runtime.dispose();
		await closeDatabase();
	});

	/** A workspace with a pod, a host agent and a helper the host can collaborate with. */
	async function aRoom(routing?: { facilitator: boolean }) {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `RT ${suffix}`, slug: `rt-${suffix}` })
				.returning(),
		);
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `rt-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !member) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: space.id, userId: member.id }),
		);
		const [madePod] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: space.id,
					ownerId: member.id,
					kind: "shared",
					name: "Room",
					slug: `room-${suffix}`,
					createdById: member.id,
					...(routing ? { routing } : {}),
				})
				.returning(),
		);
		if (!madePod) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId: space.id, podId: madePod.id, userId: member.id }),
		);
		const crew = await onDatabase((db) =>
			db
				.insert(agent)
				.values([
					{
						workspaceId: space.id,
						podId: madePod.id,
						name: "Host",
						handle: "host",
						color: "rose",
						face: "pill",
						model: "m",
						createdById: member.id,
					},
					{
						workspaceId: space.id,
						podId: madePod.id,
						name: "Helper",
						handle: "helper",
						description: "Has pets.",
						color: "rose",
						face: "dot",
						model: "m",
						createdById: member.id,
					},
				])
				.returning({ id: agent.id, name: agent.name }),
		);
		const host = crew.find((one) => one.name === "Host");
		if (!host) throw new Error("fixture");
		return { space, member, pod: madePod, host };
	}

	async function startChat(input: {
		workspaceId: string;
		podId: string;
		hostAgentId: string;
		userId: string;
		content: string;
	}) {
		const opened = await runtime.runPromise(chats.getOrCreate(input));
		await runtime.runPromise(
			chats.sendMain({
				chatId: opened.id,
				author: { id: input.userId, name: "Sam", image: null },
				messageId: crypto.randomUUID(),
				content: input.content,
			}),
		);
		return opened;
	}

	it("finishes the host's turn when the helper answers", async () => {
		const { space, pod: room, member, host } = await aRoom();
		const started = Date.now();
		const opened = await startChat({
			workspaceId: space.id,
			podId: room.id,
			hostAgentId: host.id,
			userId: member.id,
			content: "What pets does Helper have?",
		});

		const deadline = Date.now() + 10_000;
		let hostTurn: { status: string } | undefined;
		while (Date.now() < deadline) {
			[hostTurn] = await onDatabase((db) =>
				db
					.select({ status: turn.status })
					.from(turn)
					.where(and(eq(turn.threadId, opened.mainThreadId), eq(turn.agentId, host.id))),
			);
			if (hostTurn?.status === "done") break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const elapsed = Date.now() - started;
		const [made] = await onDatabase((db) =>
			db.select().from(collaboration).where(eq(collaboration.parentThreadId, opened.mainThreadId)),
		);
		const [reply] = await onDatabase((db) =>
			db
				.select({ content: message.content })
				.from(message)
				.where(and(eq(message.threadId, opened.mainThreadId), eq(message.authorAgentId, host.id))),
		);

		expect(hostTurn?.status).toBe("done");
		expect(made).toMatchObject({ status: "answered", answer: "A dog named Krypto." });
		expect(reply?.content).toBe("Helper says: A dog named Krypto.");
		// Well inside the tool's wait: the answer woke it, the timeout did not.
		expect(elapsed).toBeLessThan(5_000);
	}, 20_000);

	it("stops the child thread once the brief is answered, even with the Facilitator on", async () => {
		// The answer goes back to the agent that asked, which carries on in the
		// parent. Deciding who speaks next in the child as well left the two of
		// them talking to each other there, in a thread nobody was reading, until
		// the run cap — or until somebody killed the process.
		const { space, pod: room, member, host } = await aRoom({ facilitator: true });

		const opened = await startChat({
			workspaceId: space.id,
			podId: room.id,
			hostAgentId: host.id,
			userId: member.id,
			content: "What pets does Helper have?",
		});

		const deadline = Date.now() + 10_000;
		let answered: { childThreadId: string; status: string } | undefined;
		while (Date.now() < deadline) {
			[answered] = await onDatabase((db) =>
				db
					.select({ childThreadId: collaboration.childThreadId, status: collaboration.status })
					.from(collaboration)
					.where(eq(collaboration.parentThreadId, opened.mainThreadId)),
			);
			if (answered?.status === "answered") break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (!answered) throw new Error("The collaboration was never opened");
		// Long enough for a route job to have been claimed and run if one existed.
		await new Promise((resolve) => setTimeout(resolve, 1_500));

		const childJobs = await onDatabase((db) =>
			db.select({ kind: job.kind }).from(job).where(eq(job.threadId, answered.childThreadId)),
		);
		const childMessages = await onDatabase((db) =>
			db
				.select({ id: message.id })
				.from(message)
				.where(eq(message.threadId, answered.childThreadId)),
		);

		const parentJobs = await onDatabase((db) =>
			db
				.select({ kind: job.kind, status: job.status })
				.from(job)
				.where(and(eq(job.threadId, opened.mainThreadId), eq(job.kind, "facilitate"))),
		);
		expect(parentJobs).toHaveLength(0);

		expect(answered.status).toBe("answered");
		expect(childJobs.filter((one) => one.kind === "facilitate")).toHaveLength(0);
		expect(childMessages).toHaveLength(2);
	}, 25_000);
});

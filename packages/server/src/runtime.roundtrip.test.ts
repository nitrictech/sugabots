import { Chats } from "@sugabots/core/conversations/chats/chats";
import { Conversations } from "@sugabots/core/conversations/conversations";
import { RoutineRuns } from "@sugabots/core/conversations/routines/runs";
import { BuiltInTools } from "@sugabots/core/conversations/tools/built-in";
import { ConnectionTools } from "@sugabots/core/conversations/tools/connections";
import { facilitateLane } from "@sugabots/core/conversations/turns/facilitate.workflow";
import { Models, type TurnModel } from "@sugabots/core/conversations/turns/model";
import { TurnRequests } from "@sugabots/core/conversations/turns/requests";
import { TurnSignals } from "@sugabots/core/conversations/turns/signals";
import { EventBus } from "@sugabots/core/database/events/bus";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import { EventStore } from "@sugabots/core/database/events/store";
import {
	agent,
	collaboration,
	message,
	pod,
	podMember,
	turn,
	user,
	workspace,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, testInfrastructure } from "@sugabots/core/database/testing";
import { lane } from "@sugabots/core/workflows/sql";
import { CurrentActor } from "@sugabots/core/workspaces/current-actor";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, describe, expect, it } from "vitest";
import { Workflows } from "./workflows.ts";

/**
 * The whole round trip through the real turn workflow and workers: the host's
 * model calls the collaborate tool, the helper's turn runs in its own
 * workflow, and the host's turn should finish as soon as the helper's does,
 * not when the wait expires.
 */
describe.skipIf(!process.env.DATABASE_URL)("a collaboration round trip on the workers", () => {
	// The Scribe is left out: nothing here runs its workflow.
	const withoutSummaries = Layer.succeed(TurnRequests.Service, {
		...Context.get(services, TurnRequests.Service),
		queueSummary: () => Effect.void,
		queueCompaction: () => Effect.void,
	});
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

	// The server's tiers, over the test database and a workflow engine in
	// memory, with the model above and no tools but collaboration. The routine
	// scheduler, pruning and seeding are left out: nothing here needs them.
	const runtime = ManagedRuntime.make(
		Workflows.layer.pipe(
			Layer.provideMerge(
				Conversations.layer.pipe(
					Layer.provideMerge(
						Layer.mergeAll(TurnRequests.layer, TurnSignals.layer, RoutineRuns.layer),
					),
				),
			),
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(Models, model),
					Layer.succeed(BuiltInTools.Service, BuiltInTools.none),
					Layer.succeed(ConnectionTools.Service, ConnectionTools.none),
				),
			),
			Layer.provideMerge(Layer.mergeAll(EventOutbox.layer, Workflows.lanes)),
			Layer.provideMerge(
				Layer.mergeAll(
					Layer.sync(EventBus.Service, () => EventBus.inProcess({ store: EventStore.inMemory() })),
					WorkflowEngine.layerMemory,
				),
			),
			Layer.provideMerge(testInfrastructure),
		),
	);
	afterAll(async () => {
		await runtime.dispose();
		await closeDatabase();
	});

	/** The thread's facilitation lane, which exists once a facilitation has been asked for. */
	const facilitationLanes = (threadId: string) =>
		onDatabase((db) =>
			db
				.select()
				.from(lane)
				.where(eq(lane.key, facilitateLane({ threadId }))),
		);

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
		const asPerson = CurrentActor.provide(
			CurrentActor.AuthenticatedUserId.vouchedFor(input.userId),
		);
		return runtime.runPromise(
			Effect.gen(function* () {
				const chats = yield* Chats.Service;
				const opened = yield* chats.open({
					workspace: input.workspaceId,
					podId: input.podId,
					hostAgentId: input.hostAgentId,
				});
				yield* chats.post({
					chatId: opened.id,
					messageId: crypto.randomUUID(),
					content: input.content,
				});
				return opened;
			}).pipe(asPerson),
		);
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
		expect(await facilitationLanes(opened.mainThreadId)).toEqual([]);
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
		// Long enough for a facilitation to have run if one had been asked for.
		await new Promise((resolve) => setTimeout(resolve, 1_500));

		const childMessages = await onDatabase((db) =>
			db
				.select({ id: message.id })
				.from(message)
				.where(eq(message.threadId, answered.childThreadId)),
		);

		expect(await facilitationLanes(opened.mainThreadId)).toEqual([]);
		expect(answered.status).toBe("answered");
		expect(await facilitationLanes(answered.childThreadId)).toEqual([]);
		expect(childMessages).toHaveLength(2);
	}, 25_000);
});

import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { AutomationRuns } from "@sugabots/core/chats/automations/runs";
import { ChatServices } from "@sugabots/core/chats/chat-services";
import { Chats } from "@sugabots/core/chats/chats/chats";
import { BuiltInTools } from "@sugabots/core/chats/tools/built-in";
import { ComputerTools } from "@sugabots/core/chats/tools/computer";
import { ConnectorTools } from "@sugabots/core/chats/tools/connectors";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { ChatWorkflows } from "@sugabots/core/chats/workflows";
import { noComputers } from "@sugabots/core/computers/testing";
import { EventBus } from "@sugabots/core/database/events/bus";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import { EventStore } from "@sugabots/core/database/events/store";
import {
	bot,
	collaboration,
	membership,
	message,
	person,
	turn,
	workspace,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, testInfrastructure } from "@sugabots/core/database/testing";
import { Notifications } from "@sugabots/core/notifications/notifications";
import { Models } from "@sugabots/core/providers/models/models";
import { streamed } from "@sugabots/core/providers/models/testing";
import { unimplemented } from "@sugabots/core/testing";
import { defaultProjectOf } from "@sugabots/core/workspaces/projects/project-reads";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The whole round trip through the real turn workflows: the host's
 * model uses the collaborate tool, the helper's turn runs in its own
 * workflow, and the host's turn should finish as soon as the helper's does,
 * not when the wait expires.
 */
describe.skipIf(!process.env.DATABASE_URL)(
	"a collaboration round trip through the turn workflows",
	() => {
		/** Host asks the helper through the tool; helper answers straight away. */
		const model = Models.fromStream((input) =>
			Effect.sync(() =>
				streamed(
					(async function* () {
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
				),
			),
		);

		// The server's tiers, over the test database and a workflow engine in
		// memory, with the model above and no tools but collaboration. The automation
		// scheduler, pruning and seeding are left out: nothing here needs them.
		const runtime = ManagedRuntime.make(
			ChatWorkflows.layer.pipe(
				Layer.provideMerge(
					ChatServices.layer.pipe(
						Layer.provideMerge(Layer.mergeAll(Turns.signalsLayer, AutomationRuns.layer)),
					),
				),
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(Models.Service, model),
						Layer.succeed(BuiltInTools.Service, BuiltInTools.none),
						Layer.succeed(ComputerTools.Service, ComputerTools.none),
						Layer.succeed(ConnectorTools.Service, ConnectorTools.none),
						unimplemented(Notifications.Service, { handler: () => Effect.void }),
						noComputers,
					),
				),
				Layer.provideMerge(Layer.mergeAll(EventOutbox.layer, ChatWorkflows.lanes)),
				Layer.provideMerge(
					Layer.mergeAll(
						Layer.sync(EventBus.Service, () =>
							EventBus.inProcess({ store: EventStore.inMemory() }),
						),
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

		/** A workspace with a host bot and a helper bot the host can collaborate with. */
		async function aRoom() {
			const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			const [space] = await onDatabase((db) =>
				db
					.insert(workspace)
					.values({ name: `RT ${suffix}`, slug: `rt-${suffix}` })
					.returning(),
			);
			const [sam] = await onDatabase((db) =>
				db
					.insert(person)
					.values({ name: "Sam", email: `rt-${suffix}@example.com` })
					.returning(),
			);
			if (!space || !sam) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(membership).values({ workspaceId: space.id, personId: sam.id }),
			);
			const bots = await onDatabase((db) =>
				db
					.insert(bot)
					.values([
						{
							workspaceId: space.id,
							name: "Host",
							handle: "host",
							color: "rose",
							eyes: "pill",
							model: "m",
							createdById: sam.id,
						},
						{
							workspaceId: space.id,
							name: "Helper",
							handle: "helper",
							description: "Has pets.",
							color: "rose",
							eyes: "dot",
							model: "m",
							createdById: sam.id,
						},
					])
					.returning({ id: bot.id, name: bot.name }),
			);
			const host = bots.find((one) => one.name === "Host");
			if (!host) throw new Error("fixture");
			return { sam, host };
		}

		async function startChat(input: { hostBotId: string; personId: string; content: string }) {
			const asPerson = CurrentActor.provide(
				CurrentActor.AuthenticatedPersonId.vouchedFor(input.personId),
			);
			return runtime.runPromise(
				Effect.gen(function* () {
					const chats = yield* Chats.Service;
					const started = yield* chats.startProjectChat({
						projectId: yield* defaultProjectOf(input.hostBotId),
						messageId: crypto.randomUUID(),
						content: input.content,
					});
					return started.chat;
				}).pipe(asPerson),
			);
		}

		it("finishes the host's turn when the helper answers", async () => {
			const { sam, host } = await aRoom();
			const started = Date.now();
			const opened = await startChat({
				hostBotId: host.id,
				personId: sam.id,
				content: "What pets does Helper have?",
			});

			const deadline = Date.now() + 10_000;
			let hostTurn: { status: string } | undefined;
			while (Date.now() < deadline) {
				[hostTurn] = await onDatabase((db) =>
					db
						.select({ status: turn.status })
						.from(turn)
						.where(and(eq(turn.chatId, opened.id), eq(turn.botId, host.id))),
				);
				if (hostTurn?.status === "done") break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const elapsed = Date.now() - started;
			const [made] = await onDatabase((db) =>
				db.select().from(collaboration).where(eq(collaboration.parentChatId, opened.id)),
			);
			const [reply] = await onDatabase((db) =>
				db
					.select({ content: message.content })
					.from(message)
					.where(and(eq(message.chatId, opened.id), eq(message.authorBotId, host.id))),
			);

			expect(hostTurn?.status).toBe("done");
			expect(made).toMatchObject({ status: "answered", answer: "A dog named Krypto." });
			expect(reply?.content).toBe("Helper says: A dog named Krypto.");
			// Well inside the tool's wait: the answer woke it, the timeout did not.
			expect(elapsed).toBeLessThan(5_000);
		}, 20_000);
	},
);

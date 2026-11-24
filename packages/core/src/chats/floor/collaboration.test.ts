import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { transaction } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	bot,
	chatParticipant,
	member,
	membership,
	message,
	projectBot,
	projectMember,
	turn,
	workspace,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { asMember } from "../../operations/chats/testing.ts";
import { servedOperations } from "../../operations/testing.ts";
import { seedProject } from "../../workspaces/projects/seed.test-support.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatEvent } from "../events.ts";
import { seedChat } from "../seed.test-support.ts";
import { chatServicesForTests } from "../testing.ts";
import {
	prepareRunnable,
	queueTurnForTests,
	releaseTurn,
	replyTurnOf,
	runningTurns,
	TurnExecution,
	TurnStore,
	waitingTurns,
} from "../turns/testing.ts";

/**
 * Bots asking the project's other bots for help by mentioning them, against
 * Postgres: the turns a reply's mentions ask for, who they act for and what
 * they read, and the asking bot's hand-back once its helpers are done. The
 * turns' workflows only hold their lanes here; each case runs a turn's steps
 * itself and frees its lane, as its workflow would.
 */
describe.skipIf(!process.env.DATABASE_URL)("collaborations, against Postgres", async () => {
	const services = await chatServicesForTests(EventBus.inProcess({ store: EventStore.inMemory() }));
	const call = await servedOperations({ chats: services });
	const execution = onPostgres({ prepare: Context.get(services, TurnExecution.Service).prepare });
	const turns = onPostgres(Context.get(services, TurnStore.Service));
	let post: (content: string) => Promise<{ id: string }>;
	let samId: string;
	let chatId: string;
	/** The project's bots, by name; `outsider` is in the workspace but not the project. */
	let bots: Record<
		"asker" | "helper" | "checker" | "scout" | "outsider",
		{ id: string; handle: string }
	>;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = crypto.randomUUID();
		const [sam] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Sam", email: `collaboration-${suffix}@example.com` })
				.returning(),
		);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Collaborations", slug: `collaborations-${suffix}` })
				.returning(),
		);
		if (!sam || !space) throw new Error("fixture");
		samId = sam.id;
		const workspaceId = space.id;
		await onDatabase((db) => db.insert(membership).values({ workspaceId, memberId: samId }));
		const names = ["asker", "helper", "checker", "scout", "outsider"] as const;
		const made = await onDatabase((db) =>
			db
				.insert(bot)
				.values(
					names.map((name) => ({
						workspaceId,
						name,
						handle: name,
						color: "rose" as const,
						eyes: "pill" as const,
						model: "test/model",
						createdById: samId,
					})),
				)
				.returning({ id: bot.id, handle: bot.handle }),
		);
		bots = Object.fromEntries(names.map((name, index) => [name, made[index]])) as typeof bots;
		const project = await onDatabase((db) =>
			seedProject(db, {
				workspaceId,
				name: "Release",
				slug: `release-${suffix}`,
				createdById: samId,
				leadBotId: bots.asker.id,
			}),
		);
		await onDatabase((db) =>
			db.insert(projectBot).values(
				[bots.helper, bots.checker, bots.scout].map(({ id }) => ({
					workspaceId,
					projectId: project.id,
					botId: id,
				})),
			),
		);
		await onDatabase((db) =>
			db.insert(projectMember).values({ workspaceId, projectId: project.id, memberId: samId }),
		);
		const chat = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				projectId: project.id,
				title: "Release",
				startedById: samId,
			}),
		);
		chatId = chat.id;
		await onDatabase((db) => db.insert(chatParticipant).values({ chatId, memberId: samId }));
		const asSam = asMember(call, samId);
		post = (content) => asSam.post({ chatId, messageId: crypto.randomUUID(), content });
	});

	/** The turn of `botId` running in the chat, as its workflow holds it. */
	const runningTurnOf = async (botId: string) => {
		const run = (await runOnPostgres(runningTurns(chatId))).find(
			({ request }) => request.botId === botId,
		);
		if (!run) throw new Error(`No turn of ${botId} is running`);
		return run;
	};

	/** `botId`'s running turn replies `content` and ends, freeing its lane as its workflow would. */
	const answer = async (botId: string, content: string) => {
		const run = await runningTurnOf(botId);
		const prepared = await prepareRunnable(execution, run);
		await turns.complete(
			replyTurnOf(prepared),
			{ content, toolCalls: [] },
			{ contextCapacity: 128_000, readKeptFrom: null },
		);
		await runOnPostgres(releaseTurn(run));
		return prepared.responseMessage;
	};

	/** The turns running in the chat, as who answers what, and why. */
	const running = async () =>
		(await runOnPostgres(runningTurns(chatId))).map(({ request }) => ({
			botId: request.botId,
			triggerMessageId: request.triggerMessageId,
			reason: request.reason,
		}));

	it("asks the project's other bots a reply mentions, each reading the chat up to that reply, for its asker", async () => {
		await post("@asker is the release ready?");
		const asking = await answer(
			bots.asker.id,
			"@helper and @checker, can you look? Not @outsider, and not me, @asker.",
		);
		await post("Thanks, waiting on them.");

		expect(await running()).toEqual(
			expect.arrayContaining([
				{ botId: bots.helper.id, triggerMessageId: asking.id, reason: "collaboration" },
				{ botId: bots.checker.id, triggerMessageId: asking.id, reason: "collaboration" },
			]),
		);
		expect((await running()).map(({ botId }) => botId)).not.toContain(bots.outsider.id);
		const helping = await prepareRunnable(execution, await runningTurnOf(bots.helper.id));
		expect(helping.context.askerId).toBe(samId);
		expect(helping.context.messages.at(-1)?.id).toBe(asking.id);
		// A helper's own mentions ask nobody, so it is offered nobody to ask.
		expect(helping.context.botsToAsk).toEqual([]);
	});

	it("hands the asking bot one more turn on its reply once every helper has ended, asking only bots not asked yet", async () => {
		await post("@asker is the release ready?");
		const asking = await answer(bots.asker.id, "@helper and @checker, can you look?");

		await answer(bots.helper.id, "The changelog is fine. @checker, @scout, agree?");
		// The helper's mentions start no turn, and the asking bot waits for the checker.
		expect(await running()).toEqual([
			{ botId: bots.checker.id, triggerMessageId: asking.id, reason: "collaboration" },
		]);

		const lastHelperReply = await answer(bots.checker.id, "The tests pass.");
		expect(await running()).toEqual([
			{ botId: bots.asker.id, triggerMessageId: asking.id, reason: "hand_back" },
		]);
		const handingBack = await prepareRunnable(execution, await runningTurnOf(bots.asker.id));
		expect(handingBack.context.askerId).toBe(samId);
		expect(handingBack.context.messages.at(-1)?.id).toBe(lastHelperReply.id);
		expect(handingBack.context.botsToAsk.map(({ id }) => id)).toEqual([bots.scout.id]);

		const askingAgain = await answer(bots.asker.id, "Thanks. @helper, @scout: one more thing?");
		expect(await running()).toEqual([
			{ botId: bots.scout.id, triggerMessageId: askingAgain.id, reason: "collaboration" },
		]);
	});

	it("keeps a helper's turn apart from a member's turn for the same bot", async () => {
		await post("@helper what changed today?");
		await post("@asker is the release ready?");
		const asking = await answer(bots.asker.id, "@helper, can you check the release too?");
		await post("@helper and the docs?");

		// Each waits behind the helper's turn answering the member, and neither joins the other.
		expect(await runOnPostgres(waitingTurns({ chatId, botId: bots.helper.id }))).toEqual([
			expect.objectContaining({ triggerMessageId: asking.id, reason: "collaboration" }),
			expect.objectContaining({ reason: "mention" }),
		]);
	});

	it("waits for a helper whose turn failed and runs again before handing back", async () => {
		await post("@asker is the release ready?");
		const asking = await answer(bots.asker.id, "@helper and @checker, can you look?");
		const failing = await prepareRunnable(execution, await runningTurnOf(bots.helper.id));
		const runsAgain = await turns.fail(
			replyTurnOf(failing),
			{ content: "", toolCalls: [] },
			{ userMessage: userText`The model is busy.`, mayRunAgain: true },
		);
		expect(runsAgain).toBe(true);

		await answer(bots.checker.id, "The tests pass.");
		// Its workflow holds its lane, to run it again.
		expect(await running()).toEqual([
			{ botId: bots.helper.id, triggerMessageId: asking.id, reason: "collaboration" },
		]);

		await answer(bots.helper.id, "The changelog is fine.");
		expect(await running()).toEqual([
			{ botId: bots.asker.id, triggerMessageId: asking.id, reason: "hand_back" },
		]);
	});

	it("hands back once a helper's turn is given up before it opened", async () => {
		await post("@asker is the release ready?");
		const asking = await answer(bots.asker.id, "@helper and @checker, can you look?");
		await answer(bots.checker.id, "The tests pass.");
		await onDatabase((db) => db.delete(projectBot).where(eq(projectBot.botId, bots.helper.id)));

		expect(await execution.prepare(await runningTurnOf(bots.helper.id))).toMatchObject({
			_tag: "NotRunnable",
		});

		expect(await running()).toContainEqual({
			botId: bots.asker.id,
			triggerMessageId: asking.id,
			reason: "hand_back",
		});
	});

	it("lets a helper read the chat up to the asking message, and its own replies since", async () => {
		await post("@helper what changed today?");
		await post("@asker is the release ready?");
		const asking = await answer(bots.asker.id, "@helper, can you check the release too?");
		// Its turn answering the member, which the helper's turn waited behind.
		const ownReply = await answer(bots.helper.id, "Two fixes landed today.");
		await post("Unrelated: who's up for lunch?");

		const helping = await prepareRunnable(execution, await runningTurnOf(bots.helper.id));

		const read = helping.context.messages.map(({ id }) => id);
		expect(read).toContain(asking.id);
		expect(read.at(-1)).toBe(ownReply.id);
	});

	it("lets a hand-back with no helper's turn behind its asking message read the whole chat", async () => {
		await post("@asker is the release ready?");
		const asking = await answer(bots.asker.id, "Let me ask around.");
		// A helper's reply a migration moved into the chat, whose turn answered another message.
		const [moved] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId,
					authorBotId: bots.helper.id,
					status: "complete",
					parts: [],
					content: "The changelog is fine.",
				})
				.returning(),
		);
		await runOnPostgres(
			queueTurnForTests({
				chatId,
				botId: bots.asker.id,
				triggerMessageId: asking.id,
				reason: "hand_back",
			}),
		);

		const handingBack = await prepareRunnable(execution, await runningTurnOf(bots.asker.id));

		expect(handingBack.context.messages.at(-1)?.id).toBe(moved?.id);
	});

	it("owes no hand-back on a message no turn wrote, such as a brief", async () => {
		// A brief another bot wrote, which a migration moved into the chat with
		// the turn that answered it, and that turn's workflow ending only now.
		const [brief] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId,
					authorBotId: bots.asker.id,
					status: "complete",
					parts: [],
					content: "Check the changelog.",
				})
				.returning(),
		);
		if (!brief) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(turn).values({
				chatId,
				botId: bots.helper.id,
				triggerMessageId: brief.id,
				status: "cancelled",
				reason: "collaboration",
				model: "test/model",
				startedAt: new Date(),
				finishedAt: new Date(),
			}),
		);

		await runOnPostgres(
			transaction(
				Context.get(services, ChatEvents.Service).emit([
					ChatEvent.TurnAbandoned({
						chatId,
						botId: bots.helper.id,
						triggerMessageId: brief.id,
						reason: "collaboration",
						outcome: { state: "cancelled" },
					}),
				]),
			),
		);

		expect(await running()).toEqual([]);
	});
});

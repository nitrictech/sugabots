import { handleFromName, workspaceStream } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../../database/events/bus.ts";
import { EventStore } from "../../../database/events/store.ts";
import {
	bot,
	collaboration,
	event,
	membership,
	message,
	person,
	placedChat,
	project,
	projectBot,
	projectMember,
	turn,
	workspace,
} from "../../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../../database/testing.ts";
import { defaultProjectOf } from "../../../workspaces/projects/project-reads.ts";
import { onPostgresAs } from "../../../workspaces/testing.ts";
import { ChatDetailsView } from "../../chat-details-view.ts";
import { ChatView } from "../../chats/chat-view.ts";
import { Chats } from "../../chats/chats.ts";
import { startBotChat } from "../../chats/testing.ts";
import { chatServicesForTests } from "../../testing.ts";
import {
	modelPrompt,
	prepareRunnable,
	releaseTurn,
	replyTurnOf,
	runningTurns,
	TurnExecution,
	TurnStore,
	waitingTurns,
} from "../../turns/testing.ts";
import { CollaborationRefused, Collaborations } from "./collaborations.ts";
import { collaborateTool } from "./tool.ts";

/**
 * Collaboration against Postgres: what `open` writes, what policy refuses, and
 * how a collaboration moves between the asking bot and the answering one.
 */
describe.skipIf(!process.env.DATABASE_URL)("collaboration, against Postgres", async () => {
	const services = await chatServicesForTests(EventBus.inProcess({ store: EventStore.inMemory() }));
	const { open, collectAnswer, answer, failUnder } = Context.get(services, Collaborations.Service);
	const collaborations = onPostgres({ open, collectAnswer, answer, failUnder });
	const detailsAs = (personId: string) =>
		onPostgresAs(personId)(Context.get(services, ChatDetailsView.Service));
	const chatsAs = (personId: string) =>
		onPostgresAs(personId)(Context.get(services, Chats.Service));
	const chatViewAs = (personId: string) =>
		onPostgresAs(personId)(Context.get(services, ChatView.Service));
	const turns = onPostgres({ prepare: Context.get(services, TurnExecution.Service).prepare });
	const turnRecords = onPostgres(Context.get(services, TurnStore.Service));
	let workspaceId: string;
	let samId: string;
	let host: { id: string; name: string };
	let helper: { id: string; name: string };
	let checker: { id: string; name: string };
	let chatId: string;
	/** The host's reply in the chat, which its collaborations hang off. */
	let reply: Awaited<ReturnType<typeof openReply>>;

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
		const [sam] = await onDatabase((db) =>
			db
				.insert(person)
				.values({ name: "Sam", email: `collaboration-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !sam) throw new Error("fixture");
		workspaceId = space.id;
		samId = sam.id;
		await onDatabase((db) => db.insert(membership).values({ workspaceId, personId: samId }));
		const bots = await onDatabase((db) =>
			db
				.insert(bot)
				.values([
					{
						workspaceId,
						name: `Host ${suffix}`,
						handle: handleFromName(`Host ${suffix}`),
						color: "rose",
						eyes: "pill",
						model: "m",
						createdById: samId,
					},
					{
						workspaceId,
						name: `Helper ${suffix}`,
						handle: handleFromName(`Helper ${suffix}`),
						description: "Knows things.",
						color: "rose",
						eyes: "dot",
						model: "m",
						createdById: samId,
					},
					{
						workspaceId,
						name: `Checker ${suffix}`,
						handle: handleFromName(`Checker ${suffix}`),
						description: "Checks things.",
						color: "rose",
						eyes: "dot",
						model: "m",
						createdById: samId,
					},
				])
				.returning({ id: bot.id, name: bot.name }),
		);
		const [hostRow, helperRow, checkerRow] = bots;
		if (!hostRow || !helperRow || !checkerRow) throw new Error("fixture");
		host = hostRow;
		helper = helperRow;
		checker = checkerRow;
		const started = await startBotChat(chatsAs(samId), {
			botId: host.id,
			messageId: crypto.randomUUID(),
			content: "Please look into the release",
		});
		chatId = started.chat.id;
		reply = await openReply(chatId, host.id);
	});

	/** Prepares the turn running for a chat's bot, so a reply message exists. */
	async function openReply(chatId: string, botId: string) {
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const prepared = await prepareRunnable(turns, run);
		return {
			run,
			prepared,
			turnId: prepared.turnId,
			messageId: prepared.responseMessage.id,
			botId,
			context: prepared.context,
		};
	}

	const from = (atOffset = 0) => ({
		chatId,
		botId: host.id,
		turnId: reply.turnId,
		messageId: reply.messageId,
		atOffset,
	});

	it("opens the collaborator's chat with the brief, and records the collaboration on the reply", async () => {
		const opened = await collaborations.open({
			from: from(7),
			to: helper.name.toUpperCase(),
			brief: "Check the changelog\nfor anything alarming",
		});

		expect(opened.collaborator).toEqual(helper);
		expect(opened.collaboration).toMatchObject({
			type: "collaboration",
			botId: helper.id,
			botName: helper.name,
			status: "waiting",
			answer: null,
			atOffset: 7,
		});
		const child = await detailsAs(samId).get(opened.collaboration.chatId);
		expect(child?.chat).toMatchObject({
			parentChatId: chatId,
			botId: helper.id,
			title: "Check the changelog",
			status: "running",
		});
		expect(child?.messages).toMatchObject([
			{
				author: { kind: "bot", id: host.id },
				content: "Check the changelog\nfor anything alarming",
			},
		]);
		expect(child?.participants.map(({ id }) => id)).toEqual([host.id, helper.id]);
		// The collaboration's chat hangs off the asking chat rather than being listed beside it.
		const { chats } = await chatViewAs(samId).chats(await runOnPostgres(defaultProjectOf(host.id)));
		expect(chats.map(({ chat }) => chat.id)).toEqual([chatId]);
		expect(await runOnPostgres(runningTurns(opened.collaboration.chatId))).toMatchObject([
			{ request: { botId: helper.id } },
		]);
		// The lists showing the collaboration's chat are told of it.
		const recipientEvents = await onDatabase((db) =>
			db
				.select({ payload: event.payload })
				.from(event)
				.where(eq(event.stream, workspaceStream(workspaceId))),
		);
		expect(recipientEvents.map(({ payload }) => payload)).toContainEqual(
			expect.objectContaining({
				type: "chat.changed",
				chatId: opened.collaboration.chatId,
			}),
		);
	});

	it("asks a private bot, which another bot may ask for help though people cannot reach it", async () => {
		const [other] = await onDatabase((db) =>
			db
				.insert(person)
				.values({ name: "Kim", email: `kim-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!other) throw new Error("fixture");
		await onDatabase((db) =>
			db
				.update(bot)
				.set({ visibility: "private", createdById: other.id })
				.where(eq(bot.id, checker.id)),
		);

		const opened = await collaborations.open({ from: from(), to: checker.name, brief: "Check" });

		expect(opened.collaborator).toEqual(checker);
		expect(await runOnPostgres(runningTurns(opened.collaboration.chatId))).toMatchObject([
			{ request: { botId: checker.id } },
		]);
	});

	it("composes the collaboration into the reply's parts where it was made", async () => {
		const opened = await collaborations.open({ from: from(6), to: helper.name, brief: "Look" });
		await turnRecords.saveReply(replyTurnOf(reply.prepared), {
			content: "Hello. Asking now.",
			collaborations: [{ id: opened.collaboration.id, atOffset: 6 }],
			toolCalls: [],
		});

		const parent = await detailsAs(samId).get(chatId);
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
			db.select().from(placedChat).where(eq(placedChat.parentChatId, chatId)),
		);
		expect(rows).toHaveLength(0);
	});

	it("asks each bot at most once per turn, and never back up the chain", async () => {
		const first = await collaborations.open({ from: from(), to: helper.name, brief: "One" });
		const second = await collaborations.open({ from: from(), to: checker.name, brief: "Two" });
		expect(second.collaboration.chatId).not.toBe(first.collaboration.chatId);
		await expect(
			collaborations.open({ from: from(), to: helper.name, brief: "Again" }),
		).rejects.toThrow(/already asked .* this turn/);

		// The helper, in its collaboration, may not ask the host back: the host is
		// the one waiting on it.
		const helperReply = await openReply(first.collaboration.chatId, helper.id);
		await expect(
			collaborations.open({
				from: {
					chatId: first.collaboration.chatId,
					botId: helper.id,
					turnId: helperReply.turnId,
					messageId: helperReply.messageId,
					atOffset: 0,
				},
				to: host.name,
				brief: "Back",
			}),
		).rejects.toThrow(/already waiting on this chat/);
	});

	it("never asks back up the chain in a project people made, where a bot other than the lead asked", async () => {
		const [shared] = await onDatabase((db) =>
			db
				.insert(project)
				.values({
					workspaceId,
					name: "Shared",
					slug: `shared-${crypto.randomUUID()}`,
					createdById: samId,
					leadBotId: host.id,
				})
				.returning(),
		);
		if (!shared) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(projectMember).values({ workspaceId, projectId: shared.id, personId: samId }),
		);
		await onDatabase((db) =>
			db.insert(projectBot).values(
				[host, helper, checker].map(({ id: botId }) => ({
					workspaceId,
					projectId: shared.id,
					botId,
				})),
			),
		);
		// Mentioning the checker gives it the floor rather than the lead.
		const started = await chatsAs(samId).startProjectChat({
			projectId: shared.id,
			messageId: crypto.randomUUID(),
			content: `@${handleFromName(checker.name)} can you check the release?`,
		});
		const checkerReply = await openReply(started.chat.id, checker.id);
		const asked = await collaborations.open({
			from: {
				chatId: started.chat.id,
				botId: checker.id,
				turnId: checkerReply.turnId,
				messageId: checkerReply.messageId,
				atOffset: 0,
			},
			to: helper.name,
			brief: "Help me check",
		});

		const helperReply = await openReply(asked.collaboration.chatId, helper.id);
		await expect(
			collaborations.open({
				from: {
					chatId: asked.collaboration.chatId,
					botId: helper.id,
					turnId: helperReply.turnId,
					messageId: helperReply.messageId,
					atOffset: 0,
				},
				to: checker.name,
				brief: "Back",
			}),
		).rejects.toThrow(/already waiting on this chat/);
	});

	it("records the answer without a resume turn while the asker is still waiting", async () => {
		const opened = await collaborations.open({ from: from(), to: helper.name, brief: "Look" });

		await collaborations.answer({
			chatId: opened.collaboration.chatId,
			answer: "Nothing alarming.",
		});

		expect(await collaborations.collectAnswer(opened.collaboration.id)).toEqual({
			_tag: "Answered",
			answer: "Nothing alarming.",
		});
		expect(await runOnPostgres(waitingTurns({ chatId, botId: host.id }))).toHaveLength(0);
	});

	it("keeps a collaboration in model history", async () => {
		const opened = await collaborations.open({ from: from(6), to: helper.name, brief: "Look" });
		await collaborations.answer({
			chatId: opened.collaboration.chatId,
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
		await runOnPostgres(releaseTurn(reply.run));
		await chatsAs(samId).post({
			chatId,
			messageId: crypto.randomUUID(),
			content: "Who did you ask?",
		});

		const next = await openReply(chatId, host.id);
		const covered = next.context.messages.find(({ id }) => id === reply.messageId);

		expect(covered?.parts).toEqual([
			{ type: "text", text: "I asked for help." },
			expect.objectContaining({
				type: "collaboration",
				botId: helper.id,
				brief: "Look",
				status: "answered",
				answer: "Nothing alarming.",
			}),
			{ type: "text", text: " Everything is fine." },
		]);
		const promptMessages = modelPrompt(next.context, {
			now: new Date(),
			builtInTools: [],
			toolCatalog: undefined,
			computer: undefined,
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
		expect(await collaborations.collectAnswer(opened.collaboration.id)).toEqual({
			_tag: "MovedOn",
		});

		await collaborations.answer({
			chatId: opened.collaboration.chatId,
			answer: "Late, but fine.",
		});

		expect(await runOnPostgres(waitingTurns({ chatId, botId: host.id }))).toMatchObject([
			{ botId: host.id, triggerMessageId: reply.messageId },
		]);
		const [row] = await onDatabase((db) => db.select().from(turn).where(eq(turn.id, reply.turnId)));
		expect(row?.status).toBe("running");
	});
	describe("when the collaborator's turn ends without answering, outside any automation", () => {
		/** A collaboration the asker stopped waiting for, and the collaborator's turn on it, prepared. */
		const aPendingCollaboration = async () => {
			const opened = await collaborations.open({ from: from(), to: helper.name, brief: "Look" });
			await collaborations.collectAnswer(opened.collaboration.id);
			return { opened, collaborationChatId: opened.collaboration.chatId };
		};
		const statusOf = async (collaborationId: string) => {
			const [row] = await onDatabase((db) =>
				db.select().from(collaboration).where(eq(collaboration.id, collaborationId)),
			);
			return row?.status;
		};

		it("fails the collaboration once the turn fails for good", async () => {
			const { opened, collaborationChatId } = await aPendingCollaboration();
			const collaborator = await openReply(collaborationChatId, helper.id);

			await turnRecords.markActed(collaborator.prepared.turnId);
			const willRetry = await turnRecords.fail(
				replyTurnOf(collaborator.prepared),
				{ content: "", collaborations: [], toolCalls: [] },
				{ userMessage: userText`The model could not be reached`, mayRunAgain: true },
			);

			expect(willRetry).toBe(false);
			expect(await statusOf(opened.collaboration.id)).toBe("failed");
			// It told the person it would follow up, so it gets a turn to say what happened.
			expect(await runOnPostgres(waitingTurns({ chatId, botId: host.id }))).toMatchObject([
				{ botId: host.id, triggerMessageId: reply.messageId, reason: "resume" },
			]);
		});

		it("keeps the collaboration open while the failed turn runs again", async () => {
			const { opened, collaborationChatId } = await aPendingCollaboration();
			const collaborator = await openReply(collaborationChatId, helper.id);

			const willRetry = await turnRecords.fail(
				replyTurnOf(collaborator.prepared),
				{ content: "", collaborations: [], toolCalls: [] },
				{ userMessage: userText`The model could not be reached`, mayRunAgain: true },
			);

			expect(willRetry).toBe(true);
			expect(await statusOf(opened.collaboration.id)).toBe("pending");
		});

		it("fails the collaboration once the turn is cancelled", async () => {
			const { opened, collaborationChatId } = await aPendingCollaboration();
			const collaborator = await openReply(collaborationChatId, helper.id);

			await turnRecords.cancel(replyTurnOf(collaborator.prepared), {
				content: "Let me",
				collaborations: [],
				toolCalls: [],
			});

			expect(await statusOf(opened.collaboration.id)).toBe("failed");
		});

		it("fails the collaboration when the collaborator's turn may not run", async () => {
			const { opened, collaborationChatId } = await aPendingCollaboration();
			await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, helper.id)));
			const [run] = await runOnPostgres(runningTurns(collaborationChatId));
			if (!run) throw new Error("no turn running");

			expect(await turns.prepare(run)).toMatchObject({ _tag: "NotRunnable" });
			expect(await statusOf(opened.collaboration.id)).toBe("failed");
		});
	});

	it("gives the asker no turn when the automation run its collaboration worked for ends", async () => {
		const opened = await collaborations.open({ from: from(), to: helper.name, brief: "Look" });
		await collaborations.collectAnswer(opened.collaboration.id);

		await collaborations.failUnder([chatId]);

		expect(await runOnPostgres(waitingTurns({ chatId, botId: host.id }))).toEqual([]);
	});

	it("tells the asking model a collaboration failed while it waited, rather than that an answer is coming", async () => {
		const tool = collaborateTool({
			from: {
				chatId,
				botId: host.id,
				turnId: reply.turnId,
				messageId: reply.messageId,
			},
			collaborations: Context.get(services, Collaborations.Service),
			bus: EventBus.inProcess({ store: EventStore.inMemory() }),
			run: runOnPostgres,
			replyLength: () => 0,
			// The automation run it works for ends as soon as it is opened.
			noteCollaboration: () => Effect.promise(() => collaborations.failUnder([chatId])),
			signal: new AbortController().signal,
			wait: "50 millis",
		});

		const result = await tool.execute?.({ to: helper.name, brief: "Look" }, {
			toolCallId: "call",
			messages: [],
		} as unknown as Parameters<NonNullable<typeof tool.execute>>[1]);

		expect(result).toMatchObject({ status: "failed" });
		const [made] = await onDatabase((db) =>
			db.select().from(collaboration).where(eq(collaboration.parentChatId, chatId)),
		);
		expect(made?.status).toBe("failed");
		if (!made) throw new Error("no collaboration");
		expect(await collaborations.collectAnswer(made.id)).toEqual({ _tag: "Failed" });
	});
});

import { chatStream, handleFromName } from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eq } from "drizzle-orm";
import { Cause } from "effect";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { askerColumns } from "../../authentication/turn-facts.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	bot,
	chat,
	message,
	project,
	projectBot,
	projectMember,
	turn,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import {
	addTestMemberships,
	createTestWorkspace,
	createWorkspaceFixture,
} from "../../database/workspace.test-support.ts";
import { asMember } from "../../operations/chats/testing.ts";
import { servedOperations } from "../../operations/testing.ts";
import { BotStore } from "../../workspaces/bots/bot-store.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { seedProject } from "../../workspaces/projects/seed.test-support.ts";
import { startBotChat } from "../chats/testing.ts";
import { seedChat } from "../seed.test-support.ts";
import { chatServicesForTests } from "../testing.ts";
import {
	prepareTurn,
	queueTurnForTests,
	releaseTurn,
	runningTurns,
	runOver,
} from "../turns/testing.ts";

const eventStore = await runOnPostgres(EventStore.make);

describe.skipIf(!process.env.DATABASE_URL)("the chat store, against Postgres", async () => {
	const eventBus = EventBus.inProcess({ store: eventStore });
	const services = await chatServicesForTests(eventBus);
	const call = await servedOperations({ chats: services });
	const chatsAs = (memberId: string) => asMember(call, memberId);
	const drive = runOver(services);
	let workspaceId: string;
	let projectId: string;
	let botId: string;
	let memberId: string;
	let outsiderId: string;
	let outsiderEmail: string;

	/** A chat the member starts with the bot by sending it `message`, which the bot is asked to answer. */
	async function startChat(input: { botId: string; startedById: string; message: string }) {
		const started = await startBotChat(chatsAs(input.startedById), {
			botId: input.botId,
			messageId: crypto.randomUUID(),
			content: input.message,
		});
		return started.chat;
	}

	/** A chat as `startChat` starts it, with its participants and messages. */
	async function startChatShown(input: Parameters<typeof startChat>[0]) {
		const started = await startChat(input);
		return chatsAs(input.startedById).get(started.id);
	}

	/** The bot's turn running in the chat, as its workflow runs it. */
	async function runningTurn(chatId: string, bot = botId) {
		const run = (await runOnPostgres(runningTurns(chatId))).find(
			(running) => running.request.botId === bot,
		);
		if (!run) throw new Error("No turn is running in the chat");
		return run;
	}

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const {
			workspace: space,
			members: { insider, outsider },
		} = await createWorkspaceFixture(
			{ name: `Chat test ${suffix}`, slug: `chat-test-${suffix}` },
			{
				insider: { name: "Sam", email: `chat-sam-${suffix}@example.com`, role: "editor" },
				outsider: { name: "Kim", email: `chat-kim-${suffix}@example.com`, role: "editor" },
			},
		);
		workspaceId = space.id;
		memberId = insider.id;
		outsiderId = outsider.id;
		outsiderEmail = outsider.email;
		const projectRow = await onDatabase((db) =>
			seedProject(db, {
				workspaceId,
				name: "Suga-Team",
				slug: `suga-${suffix}`,
				createdById: memberId,
			}),
		);
		const [botRow] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: `Release bot ${suffix}`,
					handle: handleFromName(`Release bot ${suffix}`),
					color: "green",
					eyes: "pill",
					model: "claude-opus-4-1-20250805",
					createdById: memberId,
				})
				.returning(),
		);
		if (!botRow) throw new Error("Could not create chat scope");
		projectId = projectRow.id;
		botId = botRow.id;
		await onDatabase((db) =>
			db.insert(projectMember).values({ workspaceId, projectId, memberId: memberId }),
		);
	});

	it("prepares a turn for a project bot other than the one that spoke first", async () => {
		// Every bot mentioned in a project's chat takes a turn, not only the
		// first, so a turn for any of them prepares.
		const [otherRow] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: `Second bot ${Date.now()}`,
					handle: handleFromName(`Second bot ${Date.now()}`),
					color: "teal",
					eyes: "dot",
					model: "claude-opus-4-1-20250805",
					createdById: memberId,
				})
				.returning({ id: bot.id }),
		);
		if (!otherRow) throw new Error("Could not create the second bot");
		await onDatabase((db) =>
			db.insert(projectBot).values([
				{ workspaceId, projectId, botId },
				{ workspaceId, projectId, botId: otherRow.id },
			]),
		);
		// The bot that speaks first, by leading the project.
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
		);
		const { chat: projectChat, message: posted } = await chatsAs(memberId).startProjectChat({
			projectId,
			retryKey: crypto.randomUUID(),
			message: "Who should answer this?",
		});
		await runOnPostgres(
			queueTurnForTests({
				chatId: projectChat.id,
				botId: otherRow.id,
				triggerMessageId: posted.id,
				reason: "mention",
			}),
		);
		const prepared = await drive(prepareTurn(await runningTurn(projectChat.id, otherRow.id)));

		expect(prepared.context.bot.id).toBe(otherRow.id);
	});

	it("shows a chat as working while its turn lane is busy", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Run as a workflow",
		});
		const workingNow = async () => (await chatsAs(memberId).get(details.chat.id))?.chat.working;
		expect(await workingNow()).toBe(true);

		await runOnPostgres(releaseTurn(await runningTurn(details.chat.id)));

		expect(await workingNow()).toBe(false);
	});

	it("loads a chat with its participants and first message", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Check the release\nPay attention to migrations.",
		});

		// A chat is titled from its first message.
		expect(details.chat.title).toBe("Check the release Pay attention to migrations.");
		expect(details.participants.map(({ kind }) => kind).sort()).toEqual(["bot", "member"]);
		expect(details.messages).toMatchObject([
			{
				author: { kind: "member", id: memberId },
				content: "Check the release\nPay attention to migrations.",
				parts: [{ type: "text", text: "Check the release\nPay attention to migrations." }],
			},
		]);
		expect(await runOnPostgres(runningTurns(details.chat.id))).toMatchObject([
			{
				request: {
					chatId: details.chat.id,
					botId,
					triggerMessageId: details.messages[0]?.id,
				},
			},
		]);
	});

	it("pages a large history without gaps at equal-timestamp boundaries", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Message 000",
		});
		const firstMessageId = details.messages[0]?.id;
		if (!firstMessageId) {
			throw new Error("Chat test has no first message");
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
					chatId: details.chat.id,
					authorMemberId: memberId,
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
					chatId: details.chat.id,
					botId,
					triggerMessageId,
					status: "done" as const,
					model: "test/model",
					startedAt: sharedCreatedAt,
					finishedAt: sharedCreatedAt,
					...askerColumns({ chatId: details.chat.id, botId, triggerMessageId }),
				})),
			),
		);

		const pages = [];
		let cursor: string | undefined;
		do {
			const page = await chatsAs(memberId).get(details.chat.id, { limit: 50, cursor });
			if (!page) {
				throw new Error("Chat history disappeared");
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
			chatsAs(memberId).get(details.chat.id, { limit: 50, cursor: "not-a-cursor" }),
		).rejects.toMatchObject({ _tag: "InvalidCursor" });
	});

	it("replays a committed message after reconnect", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "First",
		});
		const stream = chatStream(details.chat.id);
		const [resumePoint] = await eventStore.replay(stream, 0, 10);
		if (!resumePoint) {
			throw new Error("Chat creation did not commit its durable event");
		}

		const retryKey = crypto.randomUUID();
		if (!details.chat.rootChatId) throw new Error("The chat has no root chat");
		const posted = await chatsAs(memberId).send({
			chatId: details.chat.rootChatId,
			retryKey: retryKey,
			message: "Second",
		});

		const iterator = eventBus.subscribe(stream, { since: resumePoint.seq })[Symbol.asyncIterator]();
		const replayed = await iterator.next();
		await iterator.return?.();
		expect(replayed.value?.event).toMatchObject({
			type: "message.created",
			message: { id: posted.id, retryKey, content: "Second" },
		});
	});

	it("rejects projects and bots from another workspace at the database boundary", async () => {
		const otherWorkspace = await createTestWorkspace({
			name: "Other chat workspace",
			slug: `other-chat-${crypto.randomUUID()}`,
		});
		await addTestMemberships({
			workspaceId: otherWorkspace.id,
			memberId: memberId,
			role: "editor",
		});
		const foreignProject = await onDatabase((db) =>
			seedProject(db, {
				workspaceId: otherWorkspace.id,
				name: "Foreign",
				slug: "foreign",
			}),
		);
		const [foreignBot] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId: otherWorkspace.id,
					name: "Foreign bot",
					handle: "foreign-bot",
					color: "rose",
					eyes: "pill",
					model: "test/model",
				})
				.returning(),
		);
		if (!foreignProject || !foreignBot) {
			throw new Error("Could not create foreign chat scope");
		}

		const violatedProjectWorkspaceConstraint = ({ cause }: { cause?: unknown }) => {
			const sqlError = Cause.isCause(cause) ? Cause.squash(cause) : cause;
			if (!isSqlError(sqlError) || sqlError.reason._tag !== "ConstraintError") return false;
			const constraint = sqlError.reason.cause;
			return (
				typeof constraint === "object" &&
				constraint !== null &&
				"constraint" in constraint &&
				constraint.constraint === "project_chat_project_workspace_fkey"
			);
		};

		await expect(
			onDatabase((db) =>
				seedChat(db, {
					workspaceId,
					kind: "project_chat",
					projectId: foreignProject.id,
					title: "Foreign project",
					startedById: memberId,
				}),
			),
		).rejects.toSatisfy(violatedProjectWorkspaceConstraint);
		await expect(
			onDatabase((db) =>
				seedChat(db, {
					workspaceId,
					kind: "project_chat",
					botId: foreignBot.id,
					title: "Foreign host",
					startedById: memberId,
				}),
			),
		).rejects.toSatisfy(violatedProjectWorkspaceConstraint);
	});

	it("deletes a bot's chat history with the bot", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Keep this history",
		});

		const bots = await servedOnPostgres(BotStore.Service, BotStore.layer);
		await bots.remove(workspaceId, botId);
		expect(
			await onDatabase((db) => db.select().from(chat).where(eq(chat.id, details.chat.id))),
		).toHaveLength(0);
	});

	it("adds each member who writes to the participant stack", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "First",
		});

		if (!details.chat.rootChatId) throw new Error("The chat has no root chat");
		await chatsAs(outsiderId).send({
			chatId: details.chat.rootChatId,
			retryKey: crypto.randomUUID(),
			message: "I can help",
		});

		expect((await chatsAs(memberId).get(details.chat.id))?.participants).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "member", id: outsiderId, email: outsiderEmail }),
			]),
		);
	});

	it("counts a quiet chat's latest messages as recent, and a busy chat's last week", async () => {
		const details = await startChatShown({
			botId,
			startedById: memberId,
			message: "Latest",
		});
		const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const written = (author: { authorMemberId: string } | { authorBotId: string }, at: Date) => ({
			chatId: details.chat.id,
			...author,
			status: "complete" as const,
			parts: [{ type: "text" as const, text: "Earlier" }],
			content: "Earlier",
			createdAt: at,
		});
		await onDatabase((db) =>
			db
				.insert(message)
				.values([
					written({ authorMemberId: outsiderId }, daysAgo(30)),
					written({ authorBotId: botId }, daysAgo(3)),
				]),
		);
		const recentIds = async () =>
			(await chatsAs(memberId).chats(await runOnPostgres(defaultProjectOf(botId)))).chats
				.find((listed) => listed.chat.id === details.chat.id)
				?.participants.map(({ id }) => id);

		expect(await recentIds()).toEqual([memberId, botId, outsiderId]);

		await onDatabase((db) =>
			db
				.insert(message)
				.values(
					Array.from({ length: 100 }, () => written({ authorMemberId: memberId }, daysAgo(1))),
				),
		);
		expect(await recentIds()).toEqual([memberId, botId]);
	});

	it("treats a malformed chat id as absent", async () => {
		await expect(chatsAs(memberId).get("not-a-uuid")).rejects.toThrow(ResourceHidden);
	});
});

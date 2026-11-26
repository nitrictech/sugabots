import {
	type ChatMessageItem,
	chatStream,
	type FilePart,
	handleFromName,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { Context, Stream } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { askerColumns } from "../../authentication/turn-facts.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	automationRun,
	bot,
	chatParticipant,
	event,
	laneRequest,
	message,
	messageReaction,
	placedChat,
	project,
	projectBot,
	projectMember,
	type TurnStatus,
	toolCall,
	turn,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import {
	addTestMemberships,
	createTestMember,
	createTestWorkspace,
	createWorkspaceFixture,
} from "../../database/workspace.test-support.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import { type AsMember, asMember } from "../../operations/chats/testing.ts";
import { servedOperations } from "../../operations/testing.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/bots/interview-prompt.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { seedProject } from "../../workspaces/projects/seed.test-support.ts";
import { AutomationRunner } from "../automations/automation-runner.ts";
import {
	automationsAs,
	manualRunsOver,
	type StartRun,
	startRunning,
} from "../automations/testing.ts";
import { seedChat } from "../seed.test-support.ts";
import { ChatStore } from "../store/store.ts";
import { chatServicesForTests } from "../testing.ts";
import {
	completeTurn,
	modelPrompt,
	openTurn,
	parkTurn,
	prepareTurn,
	releaseTurn,
	runningTurns,
	runOver,
} from "../turns/testing.ts";
import { Turns } from "../turns/turns.ts";
import { WAITING_APPROVALS } from "./chat-view.ts";
import { startBotChat } from "./testing.ts";

const eventStore = await runOnPostgres(EventStore.make);

describe.skipIf(!process.env.DATABASE_URL)("chats, against Postgres", async () => {
	const services = await chatServicesForTests(EventBus.inProcess({ store: eventStore }));
	const drive = runOver(services);
	const call = await servedOperations({ chats: services });
	const manualRunsAs = await manualRunsOver(services);
	/** As the editor the chats are with. */
	let chats: AsMember;
	/** As an administrator, who may define and run the bots' automations. */
	let automations: ReturnType<typeof automationsAs>;
	/** Starting the bots' automations' runs by hand, as that administrator. */
	let runByHand: StartRun;
	let workspaceId: string;
	let projectId: string;
	let botId: string;
	/** The host bot's default project, which holds its automations. */
	let botProjectId: string;
	let recipientBotId: string;
	let memberId: string;
	let administratorId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	/**
	 * A chat the editor started with `chatBotId`, written straight to the
	 * database, so it holds no message and nobody has been asked to answer.
	 */
	const aChat = async (chatBotId = botId) => {
		const { id } = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				botId: chatBotId,
				title: "Chat",
				startedById: memberId,
			}),
		);
		await onDatabase((db) =>
			db.insert(chatParticipant).values([
				{ chatId: id, memberId },
				{ chatId: id, botId: chatBotId },
			]),
		);
		return { id };
	};

	async function createAutomation(name: string, instructions: string) {
		const { automation } = await automations.create(
			{ projectId: botProjectId },
			{ name, instructions, triggers: [{ kind: "webhook" }] },
		);
		const run = () =>
			runByHand({
				projectId: botProjectId,
				automationId: automation.id,
				requestId: crypto.randomUUID(),
			});
		const openFeed = () =>
			chats.openAutomationFeed({
				workspace: workspaceId,
				automationId: automation.id,
			});
		return { automationId: automation.id, run, openFeed };
	}
	/** The bot's chat `chatId` as the editor's list of the bot's chats shows it. */
	const listedChat = async (chatId: string, chatBotId = botId) =>
		(await chats.chats(await runOnPostgres(defaultProjectOf(chatBotId)))).chats.find(
			(item) => item.chat.id === chatId,
		);

	/**
	 * A chat the editor started in `inProjectId`, called `name`, written
	 * straight to the database, so it holds no message and nobody has been
	 * asked to answer.
	 */
	const namedChat = async (inProjectId: string, name: string) => {
		const { id } = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				projectId: inProjectId,
				title: name,
				startedById: memberId,
			}),
		);
		await onDatabase((db) => db.insert(chatParticipant).values({ chatId: id, memberId }));
		return { id };
	};

	beforeEach(async () => {
		const suffix = crypto.randomUUID();
		const {
			workspace: space,
			members: { editor, administrator },
		} = await createWorkspaceFixture(
			{ name: "Chat workspace", slug: `chat-${suffix}` },
			{
				editor: { name: "Chat editor", email: `chat-${suffix}@example.com`, role: "editor" },
				administrator: {
					name: "Chat admin",
					email: `chat-admin-${suffix}@example.com`,
					role: "admin",
				},
			},
		);
		memberId = editor.id;
		administratorId = administrator.id;
		workspaceId = space.id;
		chats = asMember(call, memberId);
		automations = automationsAs(call, administrator.id);
		runByHand = manualRunsAs(administrator.id);
		const room = await onDatabase((db) =>
			seedProject(db, {
				workspaceId,
				name: "Chat project",
				slug: `chat-${suffix}`,
				createdById: memberId,
			}),
		);
		if (!room) throw new Error("Could not create chat test project");
		projectId = room.id;
		await onDatabase((db) => db.insert(projectMember).values({ workspaceId, projectId, memberId }));
		const [host, recipient] = await onDatabase((db) =>
			db
				.insert(bot)
				.values([
					{
						workspaceId,
						name: "Own Bot",
						handle: handleFromName(`Own Bot ${suffix}`),
						color: "green",
						eyes: "pill",
						model: "test/model",
						createdById: memberId,
					},
					{
						workspaceId,
						name: "Impersonal Bot",
						handle: handleFromName(`Impersonal Bot ${suffix}`),
						color: "sky",
						eyes: "square",
						model: "test/model",
						createdById: memberId,
					},
				])
				.returning(),
		);
		if (!host || !recipient) throw new Error("Could not create chat test bots");
		botId = host.id;
		recipientBotId = recipient.id;
		const [own] = await onDatabase((db) =>
			db.select({ id: project.id }).from(project).where(eq(project.defaultOfBotId, botId)),
		);
		if (!own) throw new Error("The host bot has no default project");
		botProjectId = own.id;
		// Both bots are in the project, so either may be asked in its chats; the host leads it.
		await onDatabase((db) =>
			db.insert(projectBot).values([
				{ workspaceId, projectId, botId },
				{ workspaceId, projectId, botId: recipientBotId },
			]),
		);
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
		);
	});

	it("shows a personal bot's chat to its creator, and to nobody else", async () => {
		await onDatabase((db) =>
			db.update(bot).set({ visibility: "personal" }).where(eq(bot.id, botId)),
		);
		const opened = await aChat();
		const otherEditor = await createTestMember(
			{ name: "Another editor" },
			{ workspaceId, role: "editor" },
		);
		const stranger = await createTestMember({ name: "Outside the workspace" });
		expect(await chats.get(opened.id)).toMatchObject({ chat: { id: opened.id } });
		for (const memberId of [otherEditor.id, stranger.id]) {
			await expect(asMember(call, memberId).get(opened.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "chat",
			});
		}
	});

	it("refuses a chat with a personal bot to anyone but its creator", async () => {
		await onDatabase((db) =>
			db
				.update(bot)
				.set({ visibility: "personal", createdById: administratorId })
				.where(eq(bot.id, botId)),
		);

		await expect(
			startBotChat(chats, { botId, messageId: crypto.randomUUID(), content: "Hello?" }),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
		await expect(chats.chats(botProjectId)).rejects.toMatchObject({ _tag: "ResourceHidden" });
	});

	it("starts a chat with the bot from its first message, which the bot answers, once", async () => {
		const messageId = crypto.randomUUID();
		const input = {
			botId,
			messageId,
			content: "\n  Budget   review is Friday\nand bring the numbers",
		};

		const started = await startBotChat(chats, input);

		expect(started.chat).toMatchObject({
			botId,
			title: "Budget review is Friday and bring the numbers",
		});
		expect(started.message).toMatchObject({
			retryKey: messageId,
			chatId: started.chat.id,
		});
		expect(await runOnPostgres(runningTurns(started.chat.id))).toHaveLength(1);
		expect((await startBotChat(chats, input)).chat.id).toBe(started.chat.id);
		expect((await chats.messages(started.chat.id))?.items.map((item) => item.kind)).toEqual([
			"message",
		]);
		const listed = await chats.chats(botProjectId);
		expect(listed.chats).toEqual([
			{
				chat: expect.objectContaining({ id: started.chat.id }),
				lastMessageAt: expect.any(String),
				participants: expect.any(Array),
				messageCount: 1,
				unreadMessages: 0,
				needsApproval: false,
				mentionsYou: false,
				status: null,
			},
		]);
	});

	it("returns the one chat to sends of its first message made at once", async () => {
		const input = { botId, messageId: crypto.randomUUID(), content: "Plan the offsite" };

		const [first, retry] = await Promise.all([
			startBotChat(chats, input),
			startBotChat(chats, input),
		]);

		expect(retry.chat.id).toBe(first.chat.id);
		expect((await chats.chats(botProjectId)).chats).toHaveLength(1);
	});

	it("gives the chat's bot the message the chat was started with", async () => {
		const messageId = crypto.randomUUID();
		const started = await startBotChat(chats, {
			botId,
			messageId,
			content: "Can you check the renewal numbers?",
		});
		const [run] = await runOnPostgres(runningTurns(started.chat.id));
		if (!run) throw new Error("The chat's bot was not asked");

		const prepared = await drive(prepareTurn(run));

		expect(prepared.context.messages).toEqual([
			expect.objectContaining({ id: started.message.id, chatId: started.chat.id }),
		]);
		expect(prepared.context.askerId).toBe(memberId);
	});

	it("lists a bot's automations by name, each with its feed once it has run", async () => {
		const [quiet, ran] = await Promise.all(
			["Weekly digest", "Overnight review"].map((name) =>
				automations.create(
					{ projectId: botProjectId },
					{ name, instructions: "Review it.", triggers: [{ kind: "webhook" }] },
				),
			),
		);
		if (!quiet || !ran) throw new Error("Could not create the automations");
		const accepted = await runByHand({
			projectId: botProjectId,
			automationId: ran.automation.id,
			requestId: crypto.randomUUID(),
		});

		const listed = (await chats.chats(botProjectId)).automations;

		expect(listed).toEqual([
			expect.objectContaining({
				automation: expect.objectContaining({ id: ran.automation.id, name: "Overnight review" }),
				chat: expect.objectContaining({ title: "Overnight review" }),
			}),
			expect.objectContaining({
				automation: expect.objectContaining({ id: quiet.automation.id }),
				chat: null,
			}),
		]);
		const feed = listed?.[0]?.chat;
		if (!feed) throw new Error("The automation has no feed");
		expect((await chats.messages(feed.id))?.items).toEqual([
			expect.objectContaining({ kind: "run", chatId: accepted.chatId }),
		]);
		expect(
			(
				await chats.openAutomationFeed({
					workspace: workspaceId,
					automationId: quiet.automation.id,
				})
			).title,
		).toBe("Weekly digest");
	});

	it("marks an automation whose run failed until the member opens it after the run ends", async () => {
		const automation = await createAutomation("Overnight review", "Review it.");
		const accepted = await automation.run();
		const feed = await automation.openFeed();
		// Opened while the run was still going, so before it failed.
		await chats.markRead(feed.id);
		const runError = userText`The reply took too long and was stopped.`;
		await onDatabase((db) =>
			db
				.update(automationRun)
				.set({
					state: "failed",
					startedAt: sql`${automationRun.acceptedAt}`,
					finishedAt: sql`${automationRun.acceptedAt} + interval '1 minute'`,
					error: runError,
				})
				.where(eq(automationRun.id, accepted.runId)),
		);
		const failed = async () =>
			(await chats.attentionMarks(workspaceId)).projects[botProjectId]?.failedAutomations ?? 0;

		expect(await failed()).toBe(1);
		await chats.markRead(feed.id);
		expect(await failed()).toBe(0);
		// Seen, it is still failing until a run goes well.
		expect((await chats.chats(botProjectId)).automations[0]?.status).toEqual({
			failing: true,
			latestRun: {
				id: expect.any(String),
				state: "failed",
				posted: false,
				acceptedAt: expect.any(String),
				error: runError,
			},
		});
	});

	it("marks a chat resolved, and reopens it by hand or when somebody writes in it", async () => {
		const { chat: current } = await startBotChat(chats, {
			botId,
			messageId: crypto.randomUUID(),
			content: "Can you check the renewal numbers?",
		});
		const resolvedAt = async () => (await listedChat(current.id))?.chat.resolvedAt;

		await chats.setResolved({ chatId: current.id, resolved: true });
		expect(await resolvedAt()).toEqual(expect.any(String));
		await chats.setResolved({ chatId: current.id, resolved: false });
		expect(await resolvedAt()).toBeNull();

		await chats.setResolved({ chatId: current.id, resolved: true });
		await chats.send({
			chatId: current.id,
			retryKey: crypto.randomUUID(),
			message: "One more thing",
		});
		expect(await resolvedAt()).toBeNull();
	});

	it("says when a message the member has not read mentions them", async () => {
		const current = await aChat();
		const mentioned = async () => (await listedChat(current.id))?.mentionsYou;
		expect(await mentioned()).toBe(false);

		await onDatabase((db) =>
			db.insert(message).values({
				chatId: current.id,
				authorMemberId: administratorId,
				status: "complete",
				parts: [{ type: "text", text: "@chat-editor can you look?" }],
				content: "@chat-editor can you look?",
			}),
		);
		expect(await mentioned()).toBe(true);

		await chats.markRead(current.id);
		expect(await mentioned()).toBe(false);
	});

	it("says when a message the member has not read mentions everyone", async () => {
		const current = await aChat();

		await onDatabase((db) =>
			db.insert(message).values({
				chatId: current.id,
				authorMemberId: administratorId,
				status: "complete",
				parts: [{ type: "text", text: "@here standup is starting" }],
				content: "@here standup is starting",
			}),
		);

		expect((await listedChat(current.id))?.mentionsYou).toBe(true);
	});

	it("does not say a bot's @channel mentions the member", async () => {
		const current = await aChat();

		await onDatabase((db) =>
			db.insert(message).values({
				chatId: current.id,
				authorBotId: botId,
				status: "complete",
				parts: [{ type: "text", text: "@channel the report is done" }],
				content: "@channel the report is done",
			}),
		);

		expect((await listedChat(current.id))?.mentionsYou).toBe(false);
	});

	const botWrites = async (chatId: string, content: string, at: Date | number = 0) => {
		const [written] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId,
					authorBotId: botId,
					status: "complete",
					parts: content ? [{ type: "text", text: content }] : [],
					content,
					createdAt: typeof at === "number" ? new Date(Date.now() + at * 1000) : at,
				})
				.returning(),
		);
		if (!written) throw new Error("fixture");
		return written;
	};
	async function parkApprovalsIn(chatId: string, tools: string[]) {
		const [running] = await runOnPostgres(runningTurns(chatId));
		if (!running) throw new Error("The chat has no turn to park");
		const opened = await drive(openTurn(running));
		const parked = await drive(
			parkTurn(
				opened,
				tools.map((tool, index) => ({
					tool,
					toolCallId: `sdk-${index}`,
					input: { title: "Checkout times out" },
					binding: { kind: "built-in" },
					writeOrDelete: true,
				})),
			),
		);
		if (parked._tag !== "Waiting") throw new Error("The turn did not park");
		return onDatabase((db) =>
			db
				.select()
				.from(toolCall)
				.where(inArray(toolCall.approvalId, [...parked.approvals])),
		);
	}

	async function askForApproval(chatId: string) {
		await chats.send({ chatId, retryKey: crypto.randomUUID(), message: "File it." });
		const [pending] = await parkApprovalsIn(chatId, ["linear__create_issue"]);
		if (!pending) throw new Error("The turn has no pending call");
		return pending.id;
	}

	describe("unread and waiting chats", () => {
		/** The host's one chat, as the list of its chats shows it. */
		const hostRow = async () => (await chats.chats(botProjectId)).chats[0];

		it("counts what a bot writes after the member last read the chat", async () => {
			const current = await aChat();
			await chats.send({
				chatId: current.id,
				retryKey: crypto.randomUUID(),
				message: "Hi",
			});
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });

			await botWrites(current.id, "Hello!", 1);
			await botWrites(current.id, "", 2);
			await botWrites(current.id, "How can I help?", 3);
			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });

			await chats.markRead(current.id);
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });

			await botWrites(current.id, "One more thing", 4);
			expect(await hostRow()).toMatchObject({ unreadMessages: 1 });
		});

		it("stops counting what came before the member's own reply", async () => {
			const current = await aChat();
			await botWrites(current.id, "Hello!", -2);
			await botWrites(current.id, "Anything else?", -1);
			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });

			await chats.send({
				chatId: current.id,
				retryKey: crypto.randomUUID(),
				message: "All good",
			});
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });
		});

		it("keeps a reply that finishes after the chat was read unread", async () => {
			const current = await aChat();
			await chats.send({
				chatId: current.id,
				retryKey: crypto.randomUUID(),
				message: "Hey",
			});
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						chatId: current.id,
						authorBotId: botId,
						status: "writing",
						parts: [],
						content: "",
						createdAt: new Date(Date.now() + 1000),
					})
					.returning({ id: message.id }),
			);
			if (!reply) throw new Error("fixture");

			await chats.markRead(current.id);
			await onDatabase((db) =>
				db
					.update(message)
					.set({
						status: "complete",
						content: "Hi there",
						parts: [{ type: "text", text: "Hi there" }],
					})
					.where(eq(message.id, reply.id)),
			);

			expect(await hostRow()).toMatchObject({ unreadMessages: 1 });
		});

		it("keeps a reply unread that began before something the member read while it was written", async () => {
			const current = await aChat();
			await chats.send({
				chatId: current.id,
				retryKey: crypto.randomUUID(),
				message: "Hey",
			});
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						chatId: current.id,
						authorBotId: botId,
						status: "writing",
						parts: [],
						content: "",
						createdAt: new Date(Date.now() + 1000),
					})
					.returning({ id: message.id }),
			);
			if (!reply) throw new Error("fixture");
			await botWrites(current.id, "Meanwhile, the deploy finished.", 2);

			await chats.markRead(current.id);
			await onDatabase((db) =>
				db
					.update(message)
					.set({
						status: "complete",
						content: "Hi there",
						parts: [{ type: "text", text: "Hi there" }],
					})
					.where(eq(message.id, reply.id)),
			);

			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });
		});

		it("shows how far the member has read, and announces it only when they read further", async () => {
			const current = await aChat();
			const reply = await botWrites(current.id, "Hello!", new Date("2025-01-01T00:00:00Z"));
			const readsAnnounced = async () =>
				(
					await onDatabase((db) =>
						db
							.select({ type: event.type })
							.from(event)
							.where(eq(event.stream, chatStream(current.id))),
					)
				).filter(({ type }) => type === "chat.read").length;

			await chats.markRead(current.id);
			await chats.markRead(current.id);

			const [read] = (await chats.get(current.id)).reads;
			expect(read).toEqual({
				member: expect.objectContaining({ kind: "member", id: memberId }),
				readThrough: reply.createdAt.toISOString(),
				readAt: expect.any(String),
			});
			expect(await readsAnnounced()).toBe(1);
			expect(Date.parse(read?.readAt ?? "")).toBeGreaterThan(reply.createdAt.getTime());

			const newest = await botWrites(
				current.id,
				"One more thing",
				new Date("2025-01-01T00:01:00Z"),
			);
			await chats.markRead(current.id);
			const [readAgain] = (await chats.get(current.id)).reads;
			expect(readAgain?.readThrough).toBe(newest.createdAt.toISOString());
			expect(await readsAnnounced()).toBe(2);
		});

		it("adds up each bot's unread messages for the sidebar, under its default project", async () => {
			const current = await aChat();
			const other = await aChat(recipientBotId);
			const recipientProjectId = await runOnPostgres(defaultProjectOf(recipientBotId));
			expect(await chats.attentionMarks(workspaceId)).toEqual({ projects: {} });

			await botWrites(current.id, "Hello!");
			await botWrites(current.id, "Are you there?", 1);
			await onDatabase((db) =>
				db.insert(message).values({
					chatId: other.id,
					authorBotId: recipientBotId,
					status: "complete",
					parts: [{ type: "text", text: "Morning" }],
					content: "Morning",
				}),
			);

			expect(await chats.attentionMarks(workspaceId)).toEqual({
				projects: {
					[botProjectId]: { unreadMessages: 2, needsApproval: false, failedAutomations: 0 },
					[recipientProjectId]: { unreadMessages: 1, needsApproval: false, failedAutomations: 0 },
				},
			});
		});

		it("marks a project members made by its automation feeds and failing automations, as it does a bot", async () => {
			const created = await automations.create(
				{ projectId },
				{ name: "Nightly", instructions: "Check the build.", triggers: [{ kind: "webhook" }] },
			);
			const feed = await chats.openAutomationFeed({
				workspace: workspaceId,
				automationId: created.automation.id,
			});
			await chats.markRead(feed.id);
			await botWrites(feed.id, "The build is red.", 1);
			const accepted = await runByHand({
				projectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			await onDatabase((db) =>
				db
					.update(automationRun)
					.set({
						state: "failed",
						startedAt: sql`${automationRun.acceptedAt}`,
						finishedAt: sql`${automationRun.acceptedAt} + interval '1 minute'`,
						error: userText`The reply took too long and was stopped.`,
					})
					.where(eq(automationRun.id, accepted.runId)),
			);

			expect((await chats.attentionMarks(workspaceId)).projects[projectId]).toEqual({
				unreadMessages: 1,
				needsApproval: false,
				failedAutomations: 1,
			});
		});

		it("marks a chat waiting on a tool call the member may decide", async () => {
			const current = await aChat();
			await askForApproval(current.id);

			// An automation run elsewhere, so an approval outside any run must not be taken for one.
			const [recipientProject] = await onDatabase((db) =>
				db
					.select({ id: project.id })
					.from(project)
					.where(eq(project.defaultOfBotId, recipientBotId)),
			);
			if (!recipientProject) throw new Error("The recipient bot has no default project");
			const elsewhere = await automations.create(
				{ projectId: recipientProject.id },
				{ name: "Elsewhere", instructions: "Run somewhere else.", triggers: [{ kind: "webhook" }] },
			);
			await runByHand({
				projectId: recipientProject.id,
				automationId: elsewhere.automation.id,
				requestId: crypto.randomUUID(),
			});

			expect(await hostRow()).toMatchObject({ needsApproval: true });
			expect((await chats.attentionMarks(workspaceId)).projects[botProjectId]).toEqual({
				unreadMessages: 0,
				needsApproval: true,
				failedAutomations: 0,
			});
		});

		describe("what the bot is doing in a chat", () => {
			const startedAt = new Date("2026-11-20T09:00:00.000Z");

			const finishedAt = new Date("2026-11-20T09:10:00.000Z");

			/** The host's turn in `chatId`, answering a message of the member's, with its reply. */
			const aTurn = async (chatId: string, status: TurnStatus) => {
				const [asking] = await onDatabase((db) =>
					db
						.insert(message)
						.values({
							chatId,
							authorMemberId: memberId,
							status: "complete",
							parts: [{ type: "text", text: "Deploy it" }],
							content: "Deploy it",
							createdAt: new Date(startedAt.getTime() - 1000),
						})
						.returning(),
				);
				if (!asking) throw new Error("fixture");
				const ended = status !== "running" && status !== "waiting";
				const [started] = await onDatabase((db) =>
					db
						.insert(turn)
						.values({
							chatId,
							botId,
							triggerMessageId: asking.id,
							status,
							model: "test/model",
							startedAt,
							finishedAt: ended ? finishedAt : null,
							error: status === "failed" ? userText`The model could not be reached.` : null,
							...askerColumns({ chatId: chatId, botId: botId, triggerMessageId: asking.id }),
						})
						.returning({ id: turn.id }),
				);
				if (!started) throw new Error("fixture");
				const [reply] = await onDatabase((db) =>
					db
						.insert(message)
						.values({
							chatId,
							authorBotId: botId,
							turnId: started.id,
							status: ended ? "complete" : "writing",
							parts: ended ? [{ type: "text", text: "Deployed." }] : [],
							content: ended ? "Deployed." : "",
							createdAt: startedAt,
						})
						.returning(),
				);
				if (!reply) throw new Error("fixture");
				return { turnId: started.id, reply };
			};

			it("says a bot is working since its turn started", async () => {
				const current = await aChat();
				await aTurn(current.id, "running");

				expect(await hostRow()).toMatchObject({
					status: { kind: "working", since: startedAt.toISOString() },
				});
			});

			it("says a bot is waiting since its tool call asked for an approval", async () => {
				const current = await aChat();
				await chats.send({
					chatId: current.id,
					retryKey: crypto.randomUUID(),
					message: "Deploy it",
				});
				const [pending] = await parkApprovalsIn(current.id, ["linear__create_issue"]);
				if (!pending) throw new Error("The turn has no pending call");

				expect(await hostRow()).toMatchObject({
					status: { kind: "waiting", since: pending.startedAt.toISOString() },
				});
			});

			it("says a bot finished its reply until the member reads it", async () => {
				const current = await aChat();
				await aTurn(current.id, "done");

				expect(await hostRow()).toMatchObject({
					status: { kind: "replied", at: finishedAt.toISOString() },
				});

				await chats.markRead(current.id);
				expect(await hostRow()).toMatchObject({ status: null });
			});

			it("says nothing of a turn that failed", async () => {
				const current = await aChat();
				await aTurn(current.id, "failed");

				expect(await hostRow()).toMatchObject({ status: null });
			});
		});
	});

	it("lists a project the member is in, and hides one they are not", async () => {
		const unjoined = await onDatabase((db) =>
			seedProject(db, {
				workspaceId,
				name: "Elsewhere",
				slug: `elsewhere-${crypto.randomUUID()}`,
				visibility: "private",
				createdById: administratorId,
			}),
		);
		if (!unjoined) throw new Error("Could not create the project");

		await expect(chats.chats(unjoined.id)).rejects.toMatchObject({ _tag: "ResourceHidden" });
		expect(await chats.chats(projectId)).toEqual({ chats: [], automations: [] });
	});

	describe("the interview a new bot starts with its creator", () => {
		const interviewDue = (changes: Partial<typeof bot.$inferInsert> = {}) =>
			onDatabase((db) =>
				db
					.update(bot)
					.set({ instructions: INTERVIEW_PROMPT, ...changes })
					.where(eq(bot.id, botId)),
			);

		it("starts once, in a chat named for the bot, without posting a message for the creator", async () => {
			await interviewDue();
			const opened = await chats.startInterview(botId);
			if (!opened) throw new Error("The interview did not start");
			expect(opened).toMatchObject({ botId, title: "Setting up Own Bot" });
			expect(await chats.startInterview(botId)).toBeNull();
			expect((await chats.messages(opened.id)).items).toEqual([]);
			expect(await runOnPostgres(runningTurns(opened.id))).toEqual([
				expect.objectContaining({
					request: expect.objectContaining({ botId, reason: "interview" }),
				}),
			]);
		});

		it("starts the interview in its reply and reopens the same reply after a restart", async () => {
			await interviewDue();
			const opened = await chats.startInterview(botId);
			if (!opened) throw new Error("The interview did not start");
			const runs = await runOnPostgres(runningTurns(opened.id));
			expect(runs).toHaveLength(1);
			const run = runs[0];
			if (!run) throw new Error("The interview did not start");
			const prepared = await drive(prepareTurn(run));
			expect(prepared.replyMessageId).toBe(run.request.triggerMessageId);
			const prompt = modelPrompt(prepared.context, {
				now: new Date("2026-10-26T00:00:00Z"),
				builtInTools: [],
				toolCatalog: undefined,
				computer: undefined,
			});
			expect(prompt.messages).toHaveLength(1);
			expect(prompt.messages[0]?.content).toContain("Start the interview now");
			expect(prompt.messages[0]?.content).toContain("They have not sent a message yet");
			// Opened again for the same run, as after a crash, it is the same turn and reply.
			const resumed = await drive(prepareTurn(run));
			expect(resumed.replyMessageId).toBe(prepared.replyMessageId);
			const reply = "What would you like me to help with?";
			await drive(completeTurn(resumed, reply));
			await runOnPostgres(releaseTurn(run));

			expect((await chats.get(opened.id)).chat.working).toBe(false);
			const messages = (await chats.messages(opened.id)).items;
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				kind: "message",
				message: {
					id: prepared.replyMessageId,
					retryKey: prepared.turnId,
					status: "complete",
					content: reply,
					author: { kind: "bot", id: botId },
				},
			});
		});

		it("starts only for the bot's creator", async () => {
			await interviewDue({ createdById: administratorId });

			await expect(chats.startInterview(botId)).rejects.toMatchObject({
				_tag: "ActionForbidden",
			});
			const creator = asMember(call, administratorId);
			const opened = await creator.startInterview(botId);
			if (!opened) throw new Error("The interview did not start");
			expect(await runOnPostgres(runningTurns(opened.id))).toHaveLength(1);
		});

		it("starts once a missing model is configured", async () => {
			await interviewDue({ model: null });
			expect(await chats.startInterview(botId)).toBeNull();

			await onDatabase((db) =>
				db.update(bot).set({ model: "test/model" }).where(eq(bot.id, botId)),
			);

			const opened = await chats.startInterview(botId);
			if (!opened) throw new Error("The interview did not start");
			expect(await runOnPostgres(runningTurns(opened.id))).toHaveLength(1);
		});

		it("does not start for a bot that already has a chat", async () => {
			await aChat();
			await interviewDue();

			expect(await chats.startInterview(botId)).toBeNull();
		});

		it.each(["", "Help with releases"])(
			"does not start for a bot with written instructions %j",
			async (instructions) => {
				await onDatabase((db) => db.update(bot).set({ instructions }).where(eq(bot.id, botId)));

				expect(await chats.startInterview(botId)).toBeNull();
			},
		);
	});

	it("lets those who manage a project, and nobody else in it, decide its computer's requests, whichever bot asks", async () => {
		const chat = await namedChat(projectId, "General");
		await onDatabase((db) =>
			db.insert(chatParticipant).values([
				{ chatId: chat.id, botId },
				{ chatId: chat.id, botId: recipientBotId },
			]),
		);
		const approves = (memberId: string) =>
			asMember(call, memberId)
				.get(chat.id)
				.then((details) => details.permissions?.approveComputerRequests);

		// The editor made the bot, but the computer is the project's.
		expect(await approves(memberId)).toBe(false);
		expect(await approves(administratorId)).toBe(true);
	});

	it.each([
		{
			reason: "default",
			post: async () => ({
				content: "Morning, all.",
				expectedBot: botId,
			}),
		},
		{
			reason: "mention",
			post: async () => {
				const [recipient] = await onDatabase((db) =>
					db.select({ handle: bot.handle }).from(bot).where(eq(bot.id, recipientBotId)),
				);
				if (!recipient) throw new Error("The named bot is missing");
				return {
					content: `@${recipient.handle} can you look at this?`,
					expectedBot: recipientBotId,
				};
			},
		},
		{
			reason: "reply",
			post: async (chatId: string) => {
				const content = "Nothing logged for yesterday.";
				const [answer] = await onDatabase((db) =>
					db
						.insert(message)
						.values({
							chatId,
							authorBotId: recipientBotId,
							status: "complete",
							parts: [{ type: "text", text: content }],
							content,
						})
						.returning({ id: message.id }),
				);
				if (!answer) throw new Error("The bot's message was not written");
				return {
					content: "Do you have saved automations?",
					replyTo: answer.id,
					expectedBot: recipientBotId,
				};
			},
		},
	] as const)("asks for a $reason turn in a project's chat", async ({ reason, post }) => {
		const { id: chatId } = await namedChat(projectId, "General");
		const { expectedBot, content, ...reply } = await post(chatId);

		await chats.send({ chatId, retryKey: crypto.randomUUID(), message: content, ...reply });

		expect(await runOnPostgres(runningTurns(chatId))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId: expectedBot, reason }) }),
		]);
	});

	it.each([
		{ member: "a participant", mention: "@chat-editor", visibility: "public", reason: "optional" },
		{
			member: "a non-participant",
			mention: "@chat-admin",
			visibility: "public",
			reason: "optional",
		},
		{
			member: "a member outside its reach",
			mention: "@chat-admin",
			visibility: "personal",
			reason: "default",
		},
		{
			member: "an unknown handle",
			mention: "@Backlog Manager",
			visibility: "public",
			reason: "default",
		},
		{
			member: "a former member still in the chat",
			prepareChat: async (chatId: string) => {
				const former = await createTestMember({
					name: "Former teammate",
					email: `former-${crypto.randomUUID()}@example.com`,
				});
				await onDatabase((db) =>
					db.insert(chatParticipant).values({ chatId, memberId: former.id }),
				);
			},
			mention: "@former-teammate",
			visibility: "public",
			reason: "optional",
		},
	] as const)(
		"gives a $visibility bot a turn with reason $reason when the message mentions $member",
		async ({ mention, visibility, reason, prepareChat }) => {
			if (visibility === "personal") {
				await onDatabase((db) => db.update(bot).set({ visibility }).where(eq(bot.id, botId)));
			}
			const chat = await aChat();
			await prepareChat?.(chat.id);
			await chats.send({
				chatId: chat.id,
				retryKey: crypto.randomUUID(),
				message: `${mention} can you look at this?`,
			});

			expect(await runOnPostgres(runningTurns(chat.id))).toEqual([
				expect.objectContaining({ request: expect.objectContaining({ botId, reason }) }),
			]);
		},
	);

	it("offers for mention in a public bot's chat everyone who reaches the bot, as the floor reads them", async () => {
		const chat = await aChat();

		const details = await asMember(call, memberId).get(chat.id);

		// The bot's default project has no members; the admin reaches it through the bot.
		expect(details.membersReachingProject.map(({ id }) => id)).toEqual(
			expect.arrayContaining([memberId, administratorId]),
		);
	});

	it("starts a chat in a project from its first message, which its lead bot answers, once", async () => {
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
		);
		const input = {
			projectId,
			retryKey: crypto.randomUUID(),
			message: "Plan the launch\nby Friday",
		};

		const started = await chats.startProjectChat(input);

		expect(started.chat).toMatchObject({
			projectId,
			botId: null,
			title: "Plan the launch by Friday",
		});
		expect(started.message).toMatchObject({ retryKey: input.retryKey });
		expect(started.message.id).not.toBe(input.retryKey);
		expect(await runOnPostgres(runningTurns(started.chat.id))).toEqual([
			expect.objectContaining({ request: expect.objectContaining({ botId }) }),
		]);
		expect((await chats.startProjectChat(input)).chat.id).toBe(started.chat.id);
		await expect(chats.startProjectChat({ ...input, message: "Changed" })).rejects.toMatchObject({
			_tag: "MessageRetryKeyConflict",
		});
	});

	it("starts chats and posts equally with keys from a hidden chat or with fresh keys", async () => {
		const hidden = await startBotChat(chats, {
			botId,
			messageId: crypto.randomUUID(),
			content: "Private question",
		});
		await onDatabase((db) =>
			db
				.update(bot)
				.set({ visibility: "personal", createdById: administratorId })
				.where(eq(bot.id, botId)),
		);
		await expect(chats.messages(hidden.chat.id)).rejects.toMatchObject({ _tag: "ResourceHidden" });
		for (const key of [hidden.message.id, hidden.message.retryKey, crypto.randomUUID()]) {
			if (!key) throw new Error("Message has no retry key");
			const started = await chats.startProjectChat({ projectId, retryKey: key, message: "Hello" });
			const another = await namedChat(projectId, "Another chat");
			const posted = await chats.send({ chatId: another.id, retryKey: key, message: "Hello" });
			expect(started.message).toMatchObject({ retryKey: key, content: "Hello" });
			expect(posted).toMatchObject({ chatId: another.id, retryKey: key, content: "Hello" });
			expect(started.message.id).not.toBe(posted.id);
			expect(posted.id).not.toBe(key);
		}
	});

	it("starts a chat in a project members made with its lead in it, though the first message asks another bot", async () => {
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: recipientBotId }).where(eq(project.id, projectId)),
		);
		const [host] = await onDatabase((db) =>
			db.select({ handle: bot.handle }).from(bot).where(eq(bot.id, botId)),
		);
		// Asking another bot, so the lead is not brought in by being asked.
		const started = await chats.startProjectChat({
			projectId,
			retryKey: crypto.randomUUID(),
			message: `@${host?.handle} can you look?`,
		});

		const details = await asMember(call, memberId).get(started.chat.id);
		expect(details.participants.map(({ kind, id }) => ({ kind, id }))).toEqual(
			expect.arrayContaining([
				{ kind: "member", id: memberId },
				{ kind: "bot", id: recipientBotId },
			]),
		);
	});

	it("lists a project's chat with what the member has not read in it, and counts that in the sidebar", async () => {
		const projectChat = await namedChat(projectId, "General");
		await onDatabase((db) =>
			db.insert(message).values({
				chatId: projectChat.id,
				authorMemberId: administratorId,
				status: "complete",
				parts: [{ type: "text", text: "Lunch?" }],
				content: "Lunch?",
			}),
		);

		expect((await chats.chats(projectId)).chats).toEqual([
			{
				chat: expect.objectContaining({ id: projectChat.id }),
				lastMessageAt: expect.any(String),
				participants: [expect.objectContaining({ kind: "member", id: administratorId })],
				messageCount: 1,
				unreadMessages: 1,
				needsApproval: false,
				mentionsYou: false,
				status: null,
			},
		]);
		expect(await chats.attentionMarks(workspaceId)).toEqual({
			projects: { [projectId]: { unreadMessages: 1, needsApproval: false, failedAutomations: 0 } },
		});
	});

	it("lists the project's chats, the newest message first, by their names", async () => {
		const general = await namedChat(projectId, "General");
		const pricing = await namedChat(projectId, "Pricing");
		await namedChat(projectId, "Launch");

		const listed = async () => (await chats.chats(projectId)).chats.map(({ chat }) => chat.title);
		expect(await listed()).toEqual(["Launch", "Pricing", "General"]);

		await chats.send({
			chatId: general.id,
			retryKey: crypto.randomUUID(),
			message: "Morning, all.",
		});
		expect(await listed()).toEqual(["General", "Launch", "Pricing"]);

		// Renaming a chat is for whoever may change the project.
		const administering = asMember(call, administratorId);
		await administering.renameChat({ chatId: pricing.id, name: "Prices" });

		expect(await listed()).toEqual(["General", "Launch", "Prices"]);
	});

	it("leaves renaming a project's chat to whoever may change the project", async () => {
		const pricing = await namedChat(projectId, "Pricing");

		// The editor the chats are with may start one, but not change the project.
		await expect(chats.renameChat({ chatId: pricing.id, name: "Prices" })).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
	});

	it.each([
		{ placement: "the bot's own chat", chat: () => aChat() },
		// The project's lead, the host, would answer.
		{ placement: "a project members made", chat: () => namedChat(projectId, "General") },
	])(
		"refuses a message in $placement when the bot that would answer has no model, and saves nothing",
		async ({ chat }) => {
			await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, botId)));
			const current = await chat();
			const messageId = crypto.randomUUID();

			await expect(
				chats.send({ chatId: current.id, retryKey: messageId, message: "Anyone there?" }),
			).rejects.toMatchObject({ _tag: "BotHasNoModel" });
			expect(
				await onDatabase((db) => db.select().from(message).where(eq(message.retryKey, messageId))),
			).toHaveLength(0);
			expect(await runOnPostgres(runningTurns(current.id))).toHaveLength(0);
		},
	);

	it("delivers a message for members only in a project members made, though its lead has no model", async () => {
		await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, botId)));
		const chat = await namedChat(projectId, "General");
		const messageId = crypto.randomUUID();

		// It offers the lead a turn it may decline, which it can't take.
		await chats.send({ chatId: chat.id, retryKey: messageId, message: "@chat-editor over to you" });
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.retryKey, messageId))),
		).toHaveLength(1);
		expect(await runOnPostgres(runningTurns(chat.id))).toHaveLength(0);
	});

	it("retries the same message without creating another message or turn", async () => {
		const current = await aChat();
		const send = {
			chatId: current.id,
			retryKey: crypto.randomUUID(),
			message: "A simple question",
		};
		const retryKey = send.retryKey;
		const [first, retried] = await Promise.all([chats.send(send), chats.send(send)]);
		expect(retried).toEqual(first);
		await expect(chats.send({ ...send, message: "Another question" })).rejects.toMatchObject({
			_tag: "MessageRetryKeyConflict",
		});
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.retryKey, retryKey))),
		).toHaveLength(1);
		expect(await runOnPostgres(runningTurns(current.id))).toHaveLength(1);
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(laneRequest)
					.where(like(laneRequest.laneKey, `turn:${current.id}:%`)),
			),
		).toHaveLength(0);
	});

	it("quotes the message a reply answers, but only one in the same chat", async () => {
		const current = await aChat();
		const elsewhere = await aChat(recipientBotId);
		const asked = await chats.send({
			chatId: current.id,
			retryKey: crypto.randomUUID(),
			message: "Ship the **release** today\nand tell the team",
		});
		const other = await chats.send({
			chatId: elsewhere.id,
			retryKey: crypto.randomUUID(),
			message: "Something else",
		});

		const reply = await chats.send({
			chatId: current.id,
			retryKey: crypto.randomUUID(),
			message: "Actually, tomorrow",
			replyTo: asked.id,
		});

		const quoted = { id: asked.id, author: asked.author, preview: "Ship the release today" };
		expect(reply.replyTo).toEqual(quoted);
		const page = await chats.messages(current.id);
		expect(page.items).toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({ id: reply.id, replyTo: quoted }),
			}),
		);
		await expect(
			chats.send({
				chatId: current.id,
				retryKey: crypto.randomUUID(),
				message: "About that",
				replyTo: other.id,
			}),
		).rejects.toMatchObject({ _tag: "ReplyTargetNotFound" });
	});

	it("lets members react to a message once per emoji, announcing each change", async () => {
		const reactions = asMember(call, memberId).reactions;
		const current = await aChat();
		const asked = await chats.send({
			chatId: current.id,
			retryKey: crypto.randomUUID(),
			message: "Ship it?",
		});
		const announced = () =>
			onDatabase((db) =>
				db
					.select({ payload: event.payload })
					.from(event)
					.where(
						and(
							eq(event.stream, chatStream(current.id)),
							eq(event.type, "message.reactions_changed"),
						),
					)
					.orderBy(event.seq),
			);

		const added = await reactions.add(asked.id, "👍🏽");
		expect(added).toEqual([
			{ emoji: "👍🏽", members: [{ id: memberId, name: "Chat editor", at: expect.any(String) }] },
		]);
		expect(await reactions.add(asked.id, "👍🏽")).toEqual(added);
		const page = await chats.messages(current.id);
		expect(page.items).toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({ id: asked.id, reactions: added }),
			}),
		);
		expect(await reactions.remove(asked.id, "👍🏽")).toEqual([]);
		expect(await reactions.remove(asked.id, "👍🏽")).toEqual([]);
		expect((await announced()).map(({ payload }) => payload)).toEqual([
			expect.objectContaining({ messageId: asked.id, reactions: added }),
			expect.objectContaining({ messageId: asked.id, reactions: [] }),
		]);

		const stranger = await createTestMember({
			name: "Stranger",
			email: `stranger-${crypto.randomUUID()}@example.com`,
		});
		const strangers = asMember(call, stranger.id).reactions;
		await expect(strangers.add(asked.id, "👍🏽")).rejects.toMatchObject({ _tag: "ResourceHidden" });
		await expect(reactions.add("not-a-message", "👍🏽")).rejects.toMatchObject({
			_tag: "ResourceHidden",
			resource: "message",
		});
	});

	it("refuses a reaction to a reply still being written, and a new emoji past the limit", async () => {
		const reactions = asMember(call, memberId).reactions;
		const current = await aChat();
		const asked = await chats.send({
			chatId: current.id,
			retryKey: crypto.randomUUID(),
			message: "Ship it?",
		});
		const [writing] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					chatId: current.id,
					authorBotId: botId,
					status: "writing",
					parts: [],
					content: "",
				})
				.returning(),
		);
		if (!writing) throw new Error("Could not start a reply");
		await expect(reactions.add(writing.id, "👍")).rejects.toMatchObject({
			_tag: "MessageNotFinished",
		});

		const used = Array.from("😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘😗😙😚");
		await onDatabase((db) =>
			db
				.insert(messageReaction)
				.values(used.map((emoji) => ({ messageId: asked.id, memberId: administratorId, emoji }))),
		);
		await expect(reactions.add(asked.id, "🎉")).rejects.toMatchObject({
			_tag: "TooManyReactionEmoji",
		});
		const joined = await reactions.add(asked.id, "😀");
		expect(joined[0]?.members.map((somebody) => somebody.id)).toEqual([administratorId, memberId]);
	});

	it("says which messages wait for the bot's next turn, and announces when one starts waiting", async () => {
		const chatDetailsView = asMember(call, memberId);
		const current = await aChat();
		const post = (content: string) =>
			chats.send({ chatId: current.id, retryKey: crypto.randomUUID(), message: content });
		const changesAnnounced = async () =>
			(
				await onDatabase((db) =>
					db
						.select({ type: event.type })
						.from(event)
						.where(eq(event.stream, chatStream(current.id))),
				)
			).filter(({ type }) => type === "chat.changed").length;

		await post("Is checkout timing out?");
		expect((await chatDetailsView.get(current.id)).queuedSince).toBeNull();
		const changedBefore = await changesAnnounced();
		// The editor's own follow-up would join their turn, so the admin follows up.
		const adminPost = (content: string) =>
			asMember(call, administratorId).send({
				chatId: current.id,
				retryKey: crypto.randomUUID(),
				message: content,
			});

		const followUp = await adminPost("The Stripe webhook too?");
		await adminPost("Started around 9.");

		expect((await chatDetailsView.get(current.id)).queuedSince).toBe(followUp.createdAt);
		// Once, when the admin's turn started waiting; their next message joins it.
		expect((await changesAnnounced()) - changedBefore).toBe(1);
	});

	it("queues nothing posted before a hand-back on an earlier reply starts waiting", async () => {
		const chatDetailsView = asMember(call, memberId);
		const turns = Context.get(services, Turns.Service);
		const current = await aChat();
		const asked = await chats.send({
			chatId: current.id,
			retryKey: crypto.randomUUID(),
			message: "Who owns checkout?",
		});

		// A hand-back answers an earlier message, which is long since answered.
		await runOnPostgres(
			turns.ask({
				chatId: current.id,
				botId,
				triggerMessageId: asked.id,
				reason: "hand_back",
			}),
		);
		const later = await chats.send({
			chatId: current.id,
			retryKey: crypto.randomUUID(),
			message: "And billing?",
		});

		const { queuedSince } = await chatDetailsView.get(current.id);
		expect(Date.parse(queuedSince ?? "")).toBeGreaterThan(Date.parse(asked.createdAt));
		expect(Date.parse(queuedSince ?? "")).toBeLessThanOrEqual(Date.parse(later.createdAt));
	});

	it("announces a member's message before the bot it brings into the chat", async () => {
		const current = await aChat();
		// The chat's bot has not joined it yet, so the message brings it in.
		await onDatabase((db) =>
			db
				.delete(chatParticipant)
				.where(and(eq(chatParticipant.chatId, current.id), eq(chatParticipant.botId, botId))),
		);

		await chats.send({
			chatId: current.id,
			retryKey: crypto.randomUUID(),
			message: "Are you there?",
		});

		const announced = await onDatabase((db) =>
			db
				.select({ type: event.type })
				.from(event)
				.where(eq(event.stream, chatStream(current.id)))
				.orderBy(event.seq),
		);
		expect(announced.slice(0, 2).map(({ type }) => type)).toEqual([
			"message.created",
			"chat.changed",
		]);
	});

	it("lists automation runs in the automation's feed", async () => {
		const automation = await createAutomation("Overnight review", "Review overnight changes.");
		const accepted = await automation.run();
		const current = await automation.openFeed();

		expect((await chats.messages(current.id))?.items).toEqual([
			expect.objectContaining({
				kind: "run",
				id: accepted.runId,
				chatId: accepted.chatId,
				automationName: "Overnight review",
				triggerKind: "manual",
			}),
		]);
	});

	it("paginates interleaved messages and automation runs in an automation's feed without gaps", async () => {
		const automation = await createAutomation("Overnight review", "Review overnight changes.");
		const accepted = await automation.run();
		const current = await automation.openFeed();
		const olderMessageId = crypto.randomUUID();
		const newerMessageId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values([
				{
					id: olderMessageId,
					chatId: current.id,
					authorMemberId: memberId,
					status: "complete",
					parts: [{ type: "text", text: "Older message" }],
					content: "Older message",
					createdAt: new Date("2026-09-18T09:00:00.000Z"),
				},
				{
					id: newerMessageId,
					chatId: current.id,
					authorMemberId: memberId,
					status: "complete",
					parts: [{ type: "text", text: "Newer message" }],
					content: "Newer message",
					createdAt: new Date("2026-09-18T11:00:00.000Z"),
				},
			]),
		);
		await onDatabase((db) =>
			db
				.update(automationRun)
				.set({ acceptedAt: new Date("2026-09-18T10:00:00.000Z") })
				.where(eq(automationRun.id, accepted.runId)),
		);

		const firstPage = await chats.messages(current.id, { limit: 2 });
		expect(firstPage?.items.map(timelineItemId)).toEqual([accepted.runId, newerMessageId]);
		expect(firstPage?.nextCursor).toBeTypeOf("string");
		if (!firstPage?.nextCursor) throw new Error("Expected another Chat timeline page");

		const secondPage = await chats.messages(current.id, {
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		expect(secondPage?.items.map(timelineItemId)).toEqual([olderMessageId]);
		expect(secondPage?.nextCursor).toBeNull();
	});

	describe("the approvals and mentions waiting for a member across a workspace", () => {
		/** The run completes, posting `content` as its result in the automation's feed. */
		const runPosts = async (run: { runId: string; chatId: string }, content: string) => {
			await onDatabase((db) =>
				db
					.update(automationRun)
					.set({
						state: "completed",
						startedAt: sql`${automationRun.acceptedAt}`,
						finishedAt: sql`${automationRun.acceptedAt} + interval '1 minute'`,
					})
					.where(eq(automationRun.id, run.runId)),
			);
			const [runChat] = await onDatabase((db) =>
				db
					.select({ rootChatId: placedChat.rootChatId })
					.from(placedChat)
					.where(eq(placedChat.id, run.chatId)),
			);
			const feedId = runChat?.rootChatId;
			if (!feedId) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(message).values({
					chatId: feedId,
					authorBotId: botId,
					runId: run.runId,
					status: "complete",
					parts: [{ type: "text", text: content }],
					content,
				}),
			);
		};

		it("lists a call waiting on the member's decision, then among the answered once decided", async () => {
			const current = await aChat();
			const callId = await askForApproval(current.id);

			expect(await chats.approvals(workspaceId)).toEqual({
				waiting: [
					expect.objectContaining({
						call: expect.objectContaining({ id: callId, tool: "linear__create_issue" }),
						bot: expect.objectContaining({ id: botId }),
						projectId: null,
						chatId: current.id,
						rootChatId: current.id,
					}),
				],
				answered: [],
			});

			await chats.decide({ toolCallId: callId, decision: "deny" });

			const approvals = await chats.approvals(workspaceId);
			expect(approvals.waiting).toEqual([]);
			expect(approvals.answered).toEqual([
				expect.objectContaining({
					call: expect.objectContaining({ id: callId }),
					answer: expect.objectContaining({ status: "denied", decidedByName: "Chat editor" }),
				}),
			]);
			// Nor is it listed in another workspace the member is in.
			const elsewhere = await createTestWorkspace({
				name: "Elsewhere",
				slug: `elsewhere-${crypto.randomUUID()}`,
			});
			await addTestMemberships({ workspaceId: elsewhere.id, memberId, role: "editor" });
			expect((await chats.approvals(elsewhere.id)).answered).toEqual([]);
		});

		it("lists a call waiting on the member's decision behind many they may not decide", async () => {
			// Made by the administrator, so the editor uses it but does not manage it.
			await onDatabase((db) =>
				db.update(bot).set({ createdById: administratorId }).where(eq(bot.id, botId)),
			);
			const current = await aChat();
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight filing", instructions: "File it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await runByHand({
				projectId: botProjectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			const { startRun } = Context.get(services, AutomationRunner.Service);
			await startRunning(onPostgres({ startRun }), created.automation.id);
			const backlog = await parkApprovalsIn(
				run.chatId,
				Array.from({ length: WAITING_APPROVALS + 1 }, () => "linear__create_issue"),
			);
			expect(backlog).toHaveLength(WAITING_APPROVALS + 1);
			const callId = await askForApproval(current.id);

			expect((await chats.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({ call: expect.objectContaining({ id: callId }) }),
			]);
		});

		it("leaves out a request to change the bot's computer, which only its managers decide", async () => {
			// Made by the administrator, so the editor uses it but does not manage it.
			await onDatabase((db) =>
				db.update(bot).set({ createdById: administratorId }).where(eq(bot.id, botId)),
			);
			const current = await aChat();
			await chats.send({ chatId: current.id, retryKey: crypto.randomUUID(), message: "File it." });
			const pending = await parkApprovalsIn(current.id, ["request_host", "linear__create_issue"]);
			const deciding = pending.find(({ tool }) => tool === "linear__create_issue");
			if (!deciding) throw new Error("The turn has no pending connector call");

			expect((await chats.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({ call: expect.objectContaining({ id: deciding.id }) }),
			]);
		});

		/** How many unread messages and automation results mention the member. */
		const unreadForYou = async () => (await chats.attention(workspaceId)).unreadForYou;

		it("counts a message that mentions the member until they read it", async () => {
			const current = await aChat();
			await botWrites(current.id, "The deploy finished.", 1);
			await botWrites(current.id, "@chat-editor can you check it?", 2);

			expect(await unreadForYou()).toBe(1);

			await chats.markRead(current.id);

			expect(await unreadForYou()).toBe(0);
		});

		it("does not take an email address for a mention", async () => {
			const current = await aChat();
			await botWrites(current.id, "Mail it to ops@chat-editor.example", 1);

			expect(await unreadForYou()).toBe(0);
		});

		it("counts an automation run's result that mentions the member only once it is posted", async () => {
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const runAutomation = () =>
				runByHand({
					projectId: botProjectId,
					automationId: created.automation.id,
					requestId: crypto.randomUUID(),
				});
			const asking = await runAutomation();
			await botWrites(asking.chatId, "@chat-editor the deploy needs your sign-off.", 1);

			expect(await unreadForYou()).toBe(0);

			await runPosts(asking, "@chat-editor the deploy needs your sign-off.");

			expect(await unreadForYou()).toBe(1);
		});

		it("shows each run in its automation's feed with its own bot's reply, not a helper's, over its result once posted", async () => {
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const runAutomation = () =>
				runByHand({
					projectId: botProjectId,
					automationId: created.automation.id,
					requestId: crypto.randomUUID(),
				});
			const unposted = await runAutomation();
			const posted = await runAutomation();
			await botWrites(unposted.chatId, "Two PRs merged.\nThe release branch is green.", 1);
			// A helper the run's bot asked answers in the run's chat after it.
			await onDatabase((db) =>
				db.insert(message).values({
					chatId: unposted.chatId,
					authorBotId: recipientBotId,
					status: "complete",
					parts: [{ type: "text", text: "Billing is unchanged." }],
					content: "Billing is unchanged.",
					createdAt: new Date(Date.now() + 2_000),
				}),
			);
			await botWrites(posted.chatId, "Posted the summary.", 1);
			await runPosts(posted, "All green overnight.");
			const feed = (await chats.chats(botProjectId)).automations[0]?.chat;

			// The result's time is the database's, so the two may come in either order.
			const items = (await chats.messages(feed?.id ?? ""))?.items;
			expect(items).toHaveLength(2);
			expect(items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "run",
						chatId: unposted.chatId,
						reply: expect.objectContaining({
							chatId: unposted.chatId,
							content: "Two PRs merged.\nThe release branch is green.",
						}),
					}),
					{
						kind: "message",
						message: expect.objectContaining({ content: "All green overnight." }),
						runReply: expect.objectContaining({
							chatId: posted.chatId,
							content: "Posted the summary.",
						}),
					},
				]),
			);
		});

		it("makes a run opened while it ran news again once it posts its result", async () => {
			const created = await automations.create(
				{ projectId: botProjectId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await runByHand({
				projectId: botProjectId,
				automationId: created.automation.id,
				requestId: crypto.randomUUID(),
			});
			await chats.markNestedChatRead(run.chatId);

			await runPosts(run, "@chat-editor the deploy needs your sign-off.");

			expect(await unreadForYou()).toBe(1);
		});

		it("reads only the automation run opened, leaving the automation's other runs unread", async () => {
			const automation = await createAutomation("Overnight review", "Review it.");

			const earlier = await automation.run();
			const opened = await automation.run();
			const later = await automation.run();
			for (const run of [earlier, opened, later]) await runPosts(run, "@chat-editor all green.");

			await chats.markNestedChatRead(opened.chatId);

			expect(await unreadForYou()).toBe(2);
		});

		it("refuses a chat that is not an automation run", async () => {
			const current = await aChat();

			await expect(chats.markNestedChatRead(current.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("counts an automation run read with the automation's feed it is listed in", async () => {
			const automation = await createAutomation("Overnight review", "Review it.");
			const run = await automation.run();
			await runPosts(run, "@chat-editor all green.");
			expect(await unreadForYou()).toBe(1);

			await chats.markRead((await automation.openFeed()).id);

			expect(await unreadForYou()).toBe(0);
		});
	});

	describe("sending files", () => {
		/** The chat, with the editor's uploads to it. */
		async function aChatWithFiles() {
			const { id: chatId } = await aChat();
			const files = asMember(call, memberId).chatFiles;
			const upload = (name: string) =>
				files.upload({
					chatId,
					name,
					type: "text/plain",
					stream: Stream.succeed(new TextEncoder().encode(name)),
				});
			return { chatId, files, upload };
		}
		const asPart = ({ id, name, contentType, size }: ChatFileStore.UnsentAttachment): FilePart => ({
			type: "file",
			id,
			name,
			contentType,
			size,
		});
		const shownMessage = async (chatId: string, messageId: string) =>
			(await chats.messages(chatId)).items.find(
				(item) => item.kind === "message" && item.message.id === messageId,
			);

		it("sends the files with the message, in the order listed, for its readers to open", async () => {
			const { chatId, files, upload } = await aChatWithFiles();
			const first = await upload("a.txt");
			const second = await upload("b.txt");

			const sent = await chats.send({
				chatId,
				retryKey: crypto.randomUUID(),
				message: "",
				attachments: [second.id, first.id],
			});

			expect(sent).toMatchObject({ content: "", parts: [asPart(second), asPart(first)] });
			expect(await shownMessage(chatId, sent.id)).toMatchObject({
				message: { parts: [asPart(second), asPart(first)] },
			});
			// Watching clients add the announced message as it is, so it must carry its files.
			const [announced] = await onDatabase((db) =>
				db
					.select({ payload: event.payload })
					.from(event)
					.where(and(eq(event.stream, chatStream(sent.chatId)), eq(event.type, "message.created")))
					.orderBy(desc(event.seq))
					.limit(1),
			);
			expect(announced?.payload).toMatchObject({
				message: { id: sent.id, parts: [asPart(second), asPart(first)] },
			});
			expect(await files.read({ chatId, fileId: first.id })).toMatchObject({
				name: "a.txt",
			});
		});

		it("posts nothing when a file is not one of the author's unsent uploads", async () => {
			const { chatId, upload } = await aChatWithFiles();
			const sentBefore = await upload("sent.txt");
			await chats.send({
				chatId,
				retryKey: crypto.randomUUID(),
				message: "first",
				attachments: [sentBefore.id],
			});
			const fresh = await upload("fresh.txt");
			const messageId = crypto.randomUUID();

			await expect(
				chats.send({
					chatId,
					retryKey: messageId,
					message: "again",
					attachments: [fresh.id, sentBefore.id],
				}),
			).rejects.toBeInstanceOf(ChatFileStore.UnsentAttachmentsNotFound);
			expect((await chats.messages(chatId)).items).not.toContainEqual(
				expect.objectContaining({ message: expect.objectContaining({ retryKey: messageId }) }),
			);
			// The fresh upload is still the author's to send.
			await expect(
				chats.send({ chatId, retryKey: messageId, message: "again", attachments: [fresh.id] }),
			).resolves.toMatchObject({ parts: [{ type: "text" }, asPart(fresh)] });
		});

		it("returns a message sent again with its files, and refuses its id for other files", async () => {
			const { chatId, upload } = await aChatWithFiles();
			const attached = await upload("a.txt");
			const other = await upload("b.txt");
			const messageId = crypto.randomUUID();
			const send = (attachments: string[]) =>
				chats.send({ chatId, retryKey: messageId, message: "files", attachments });
			const sent = await send([attached.id]);

			await expect(send([attached.id])).resolves.toEqual(sent);
			await expect(send([other.id])).rejects.toBeInstanceOf(ChatStore.MessageRetryKeyConflict);
		});
	});

	it("keeps an uploaded file as the type it was given, or else the type its name suggests", async () => {
		const { id: chatId } = await aChat();
		const files = asMember(call, memberId).chatFiles;
		const upload = (name: string, type: string | undefined) =>
			files.upload({
				chatId,
				name,
				type,
				stream: Stream.succeed(new TextEncoder().encode("x")),
			});

		// Browsers give no type for many text files, which bots must still read as text.
		expect(await upload("notes.md", undefined)).toMatchObject({
			contentType: "text/markdown; charset=utf-8",
		});
		expect(await upload("report.csv", "application/octet-stream")).toMatchObject({
			contentType: "text/csv; charset=utf-8",
		});
		expect(await upload("chart", "image/png")).toMatchObject({ contentType: "image/png" });
		expect(await upload("data", undefined)).toMatchObject({
			contentType: "application/octet-stream",
		});
	});
});

function timelineItemId(item: ChatMessageItem) {
	return item.kind === "message" ? item.message.id : item.id;
}

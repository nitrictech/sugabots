import {
	chatNotificationTag,
	type EventStream,
	handleFromName,
	type Message,
	type NotificationPreferences,
	personStream,
	type StreamEvent,
} from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentActor } from "../authorization/current-actor.ts";
import { ChatEvent } from "../chats/events.ts";
import { seedChat } from "../chats/seed.test-support.ts";
import { HOST_REQUEST_TOOL } from "../chats/tools/host-request/tool.ts";
import { transaction } from "../database/database.ts";
import { EventBus } from "../database/events/bus.ts";
import {
	automation,
	automationRun,
	bot as botTable,
	chatParticipant,
	membership,
	message,
	person,
	project,
	projectBot,
	projectMember,
	toolCall,
	turn,
	workspace,
} from "../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	runOnPostgres,
	type TestInfrastructure,
} from "../database/testing.ts";
import { unimplemented } from "../testing.ts";
import { seedProject } from "../workspaces/projects/seed.test-support.ts";
import { Notifications } from "./notifications.ts";
import { inQuietHours } from "./recipients.ts";

/** The preferences a person has before choosing, with `chosen` in their place. */
function preferences(chosen: Partial<NotificationPreferences>): NotificationPreferences {
	return {
		level: "mentions",
		pausedUntil: null,
		quietHours: null,
		turnFailures: true,
		automationRuns: "failures",
		...chosen,
	};
}

/** What the service published on the bus, for every test in the file. */
const published: { stream: EventStream; event: StreamEvent }[] = [];

/**
 * The service over the test database's own pool, publishing to `published`,
 * with `run` to call it and `close` to stop what it is still sending.
 */
async function served() {
	const scope = Scope.makeUnsafe();
	const bus = unimplemented(EventBus.Service, {
		publish: async (stream, event) => {
			published.push({ stream, event });
		},
	});
	const context = await runOnPostgres(
		Layer.buildWithScope(Notifications.layer.pipe(Layer.provide(bus)), scope),
	);
	return {
		run: <A, E>(effect: Effect.Effect<A, E, Notifications.Service | TestInfrastructure>) =>
			runOnPostgres(Effect.provide(effect, context)),
		close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
	};
}

describe("quiet hours", () => {
	const overnight = { from: "22:00", to: "07:30", timeZone: "Pacific/Auckland" };

	it("span midnight in the person's time zone", () => {
		// 23:15 and 06:00 in Auckland (UTC+13 in January), and 12:00.
		expect(inQuietHours(overnight, new Date("2026-01-15T10:15:00Z"))).toBe(true);
		expect(inQuietHours(overnight, new Date("2026-01-15T17:00:00Z"))).toBe(true);
		expect(inQuietHours(overnight, new Date("2026-01-14T23:00:00Z"))).toBe(false);
	});

	it("are none when they start and end together", () => {
		expect(
			inQuietHours({ ...overnight, to: overnight.from }, new Date("2026-01-15T10:15:00Z")),
		).toBe(false);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("notifications, against Postgres", () => {
	const service = served();
	const run = async <A, E>(
		effect: Effect.Effect<A, E, Notifications.Service | TestInfrastructure>,
	) => (await service).run(effect);
	const notifications = () => run(Notifications.Service);
	const as = <A, E>(
		personId: string,
		effect: Effect.Effect<A, E, CurrentActor.Service | Notifications.Service>,
	) =>
		run(effect.pipe(CurrentActor.provide(CurrentActor.AuthenticatedPersonId.vouchedFor(personId))));
	const emit = async (...events: ChatEvent[]) => {
		const { handler } = await notifications();
		await run(transaction(handler(events)));
	};
	const sentTo = (personId: string) =>
		published
			.filter(
				({ stream, event }) => stream === personStream(personId) && event.type === "notification",
			)
			.map(({ event: { type: _type, v: _version, ...notification } }) => notification);
	/** Waits for `personId` to be sent something, then for anything sent alongside it. */
	const deliveredTo = async (personId: string) => {
		await vi.waitFor(() => expect(sentTo(personId)).not.toHaveLength(0), { timeout: 5_000 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		return sentTo(personId);
	};

	let workspaceId: string;
	let workspaceSlug: string;
	let projectId: string;
	let projectSlug: string;
	let botId: string;
	let people: Record<"ada" | "bob" | "cy" | "outsider", { id: string; name: string }>;

	afterAll(async () => {
		await (await service).close();
		await closeDatabase();
	});

	beforeEach(async () => {
		published.length = 0;
		const suffix = crypto.randomUUID().slice(0, 8);
		const names = {
			ada: `Ada ${suffix}`,
			bob: `Bob ${suffix}`,
			cy: `Cy ${suffix}`,
			outsider: `Outsider ${suffix}`,
		};
		const rows = await onDatabase((db) =>
			db
				.insert(person)
				.values(
					Object.values(names).map((name) => ({
						name,
						email: `${handleFromName(name)}@example.com`,
					})),
				)
				.returning(),
		);
		const [ada, bob, cy, outsider] = rows;
		if (!ada || !bob || !cy || !outsider) throw new Error("Could not create the people");
		people = { ada, bob, cy, outsider };
		workspaceSlug = `notify-${suffix}`;
		const [space] = await onDatabase((db) =>
			db.insert(workspace).values({ name: "Notify", slug: workspaceSlug }).returning(),
		);
		if (!space) throw new Error("Could not create the workspace");
		workspaceId = space.id;
		await onDatabase((db) =>
			db.insert(membership).values(rows.map((person) => ({ workspaceId, personId: person.id }))),
		);
		projectSlug = `project-${suffix}`;
		const room = await onDatabase((db) =>
			seedProject(db, {
				workspaceId,
				name: "Launch",
				slug: projectSlug,
				createdById: ada.id,
			}),
		);
		if (!room) throw new Error("Could not create the project");
		projectId = room.id;
		// Everybody but the outsider is in the project.
		await onDatabase((db) =>
			db
				.insert(projectMember)
				.values([ada, bob, cy].map((person) => ({ workspaceId, projectId, personId: person.id }))),
		);
		const [bot] = await onDatabase((db) =>
			db
				.insert(botTable)
				.values({
					workspaceId,
					name: "Scout",
					handle: `scout-${suffix}`,
					color: "green",
					eyes: "pill",
					model: "test/model",
					createdById: ada.id,
				})
				.returning(),
		);
		if (!bot) throw new Error("Could not create the bot");
		botId = bot.id;
		await onDatabase((db) =>
			db.insert(projectBot).values({ workspaceId, projectId, botId: botId }),
		);
	});

	const chatWithBot = async (participants: readonly string[]) => {
		const id = crypto.randomUUID();
		await onDatabase((db) =>
			seedChat(db, {
				id,
				workspaceId,
				kind: "project_chat",
				botId,
				title: "Release notes",
				startedById: people.ada.id,
			}),
		);
		await onDatabase((db) =>
			db
				.insert(chatParticipant)
				.values([
					{ chatId: id, botId: botId },
					...participants.map((personId) => ({ chatId: id, personId })),
				]),
		);
		return id;
	};

	const projectChat = async () => {
		const id = crypto.randomUUID();
		await onDatabase((db) =>
			seedChat(db, {
				id,
				workspaceId,
				kind: "project_chat",
				projectId,
				title: "Launch",
				startedById: people.ada.id,
			}),
		);
		return id;
	};

	/**
	 * The bot's turn answering `askerId`, finished with `content`. Nobody in
	 * the project asks, unless a test says who did.
	 */
	const botReplied = async (
		chatId: string,
		content: string,
		askerId: { id: string } = people.outsider,
	) => {
		const asked = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values({
				id: asked,
				chatId,
				authorPersonId: askerId.id,
				kind: "text",
				status: "complete",
				parts: [],
				content: "Can you help?",
			}),
		);
		const turnId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(turn).values({
				id: turnId,
				chatId,
				botId: botId,
				triggerMessageId: asked,
				status: "done",
				model: "test/model",
				startedAt: new Date(),
			}),
		);
		return ChatEvent.TurnCompleted({
			chatId,
			workspaceId,
			turnId,
			botId: botId,
			messageId: crypto.randomUUID(),
			content,
			contextTokens: undefined,
			contextCapacity: 0,
			readKeptFrom: null,
		});
	};

	const personPosted = (
		chatId: string,
		author: { id: string; name: string },
		content: string,
		more: Partial<Message> = {},
	) =>
		ChatEvent.MessagePosted({
			chatId,
			workspaceId,
			message: {
				id: crypto.randomUUID(),
				content,
				parts: content === "" ? [] : [{ type: "text", text: content }],
				...more,
				author: {
					kind: "person",
					id: author.id,
					name: author.name,
					email: `${handleFromName(author.name)}@example.com`,
					handle: handleFromName(author.name),
					image: null,
				},
			} as Message,
		});

	const chooseLevel = (personId: string, level: "all" | "mentions" | "nothing") =>
		as(
			personId,
			Effect.flatMap(Notifications.Service, (service) =>
				service.updatePreferences(preferences({ level })),
			),
		);

	it("tells a person they were mentioned in a project, linking to the message", async () => {
		const chat = await projectChat();
		const posted = personPosted(
			chat,
			people.ada,
			`@${handleFromName(people.bob.name)} can you look at the launch checklist?`,
		);

		await emit(posted);

		expect(await deliveredTo(people.bob.id)).toEqual([
			{
				title: `${people.ada.name} mentioned you in Launch`,
				body: `@${handleFromName(people.bob.name)} can you look at the launch checklist?`,
				tag: `chat:${chat}`,
				path: `/${workspaceSlug}/projects/${projectSlug}/${chat}?message=${posted.message.id}`,
				chatId: chat,
			},
		]);
		// Not the author, nor somebody who was only in the project.
		expect(sentTo(people.ada.id)).toEqual([]);
		expect(sentTo(people.cy.id)).toEqual([]);
	});

	it.each(["@here the launch moved to Friday", "@channel the launch moved to Friday"])(
		"tells everyone in the project of a person's %s, but not the author or an outsider",
		async (text) => {
			const chat = await projectChat();

			await emit(personPosted(chat, people.ada, text));

			expect(await deliveredTo(people.bob.id)).toEqual([
				expect.objectContaining({
					title: `${people.ada.name} mentioned you in Launch`,
					body: text,
				}),
			]);
			expect(await deliveredTo(people.cy.id)).toHaveLength(1);
			expect(sentTo(people.ada.id)).toEqual([]);
			expect(sentTo(people.outsider.id)).toEqual([]);
		},
	);

	it("does not let a bot reach everyone with @channel", async () => {
		const chat = await chatWithBot([people.ada.id]);
		await chooseLevel(people.ada.id, "all");

		await emit(await botReplied(chat, "@channel I am done."));

		expect(await deliveredTo(people.ada.id)).toEqual([
			expect.objectContaining({ title: "Scout in Release notes" }),
		]);
		expect(sentTo(people.bob.id)).toEqual([]);
	});

	it("tells a person of a reply to their message in a project, and names a file shared without text", async () => {
		const chat = await projectChat();
		const asked = personPosted(chat, people.bob, "Who has the launch checklist?");

		await emit(
			personPosted(chat, people.ada, "", {
				parts: [
					{
						type: "file",
						id: crypto.randomUUID(),
						name: "checklist.pdf",
						contentType: "application/pdf",
						size: 1_024,
					},
				],
				replyTo: {
					id: asked.message.id,
					author: asked.message.author,
					preview: asked.message.content,
				},
			}),
		);

		expect(await deliveredTo(people.bob.id)).toEqual([
			expect.objectContaining({
				title: `${people.ada.name} in Launch`,
				body: "Shared checklist.pdf",
			}),
		]);
	});

	it("names the files an automation's result shares without text in a project", async () => {
		const chat = await projectChat();
		await chooseLevel(people.bob.id, "all");
		const resultSharing = (titles: readonly string[]) =>
			ChatEvent.MessagePosted({
				chatId: chat,
				workspaceId,
				message: {
					id: crypto.randomUUID(),
					content: "",
					parts: titles.map((title) => ({
						type: "written_file",
						fileId: crypto.randomUUID(),
						kind: "html",
						title,
						version: 1,
					})),
					author: {
						kind: "bot",
						id: botId,
						name: "Scout",
						handle: "scout",
						color: "green",
						eyes: "pill",
						shape: "circle",
					},
				} as Message,
			});

		await emit(resultSharing(["Weekly traction"]));
		await emit(resultSharing(["Weekly traction", "Pipeline"]));

		expect(await deliveredTo(people.bob.id)).toEqual([
			expect.objectContaining({ body: "Shared Weekly traction" }),
			expect.objectContaining({ body: "Shared 2 files" }),
		]);
	});

	it("tells the people in a bot's chat of the bot's reply, linking to the chat, and those who chose everything", async () => {
		const chat = await chatWithBot([people.ada.id]);
		await chooseLevel(people.cy.id, "all");

		const reply = await botReplied(chat, "The release notes are drafted.", people.ada);
		await emit(reply);

		expect(await deliveredTo(people.ada.id)).toEqual([
			{
				title: "Scout in Release notes",
				body: "The release notes are drafted.",
				tag: `chat:${chat}`,
				path: `/${workspaceSlug}/chats/${chat}?message=${reply.messageId}`,
				chatId: chat,
			},
		]);
		expect(await deliveredTo(people.cy.id)).toHaveLength(1);
		expect(sentTo(people.bob.id)).toEqual([]);
		expect(sentTo(people.outsider.id)).toEqual([]);
	});

	it("tells the people taking part in a project's chat of a bot's reply there, as in a bot's chat", async () => {
		const chat = await projectChat();
		await onDatabase((db) =>
			db.insert(chatParticipant).values({ chatId: chat, personId: people.ada.id }),
		);

		await emit(await botReplied(chat, "The checklist is done."));

		expect(await deliveredTo(people.ada.id)).toEqual([
			expect.objectContaining({ title: "Scout in Launch", body: "The checklist is done." }),
		]);
		expect(sentTo(people.bob.id)).toEqual([]);
	});

	it("leaves out somebody who muted the bot or paused", async () => {
		const chat = await chatWithBot([people.ada.id, people.bob.id, people.cy.id]);
		await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) =>
				service.setLevel({ kind: "bot", id: botId }, "nothing"),
			),
		);
		await as(
			people.cy.id,
			Effect.flatMap(Notifications.Service, (service) =>
				service.updatePreferences(
					preferences({ pausedUntil: new Date(Date.now() + 60_000).toISOString() }),
				),
			),
		);

		await emit(await botReplied(chat, "Done."));

		expect(await deliveredTo(people.ada.id)).toHaveLength(1);
		expect(sentTo(people.bob.id)).toEqual([]);
		expect(sentTo(people.cy.id)).toEqual([]);
	});

	it("passes what one of a person's tabs is looking at to their other tabs, and nobody else", async () => {
		const looking = {
			clientId: crypto.randomUUID(),
			chatId: crypto.randomUUID(),
			sequence: 1,
		};

		await as(
			people.ada.id,
			Effect.flatMap(Notifications.Service, (service) => service.reportPresence(looking)),
		);

		expect(published).toEqual([
			{
				stream: personStream(people.ada.id),
				event: expect.objectContaining({ type: "presence", ...looking }),
			},
		]);
	});

	it("lets a project's level quiet its bots, and a bot's level win over it", async () => {
		const chat = await projectChat();
		for (const person of [people.ada, people.bob]) {
			await as(
				person.id,
				Effect.flatMap(Notifications.Service, (service) =>
					service.setLevel({ kind: "project", id: projectId }, "nothing"),
				),
			);
		}
		await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) =>
				service.setLevel({ kind: "bot", id: botId }, "all"),
			),
		);

		await emit(await botReplied(chat, "Shipped."));

		expect(await deliveredTo(people.bob.id)).toHaveLength(1);
		expect(sentTo(people.ada.id)).toEqual([]);
	});

	it("quiets a muted bot's replies in a project, and not what people post there", async () => {
		const chat = await projectChat();
		await chooseLevel(people.bob.id, "all");
		await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) =>
				service.setLevel({ kind: "bot", id: botId }, "nothing"),
			),
		);

		await emit(await botReplied(chat, "Here is the checklist."));
		await emit(personPosted(chat, people.ada, "Thanks, Scout."));

		expect(await deliveredTo(people.bob.id)).toEqual([
			expect.objectContaining({ title: `${people.ada.name} in Launch` }),
		]);
	});

	it("quiets a bot muted for a while until the mute ends, then keeps its level", async () => {
		const chat = await chatWithBot([people.ada.id, people.bob.id]);
		const muteUntil = (person: { id: string }, until: Date) =>
			as(
				person.id,
				Effect.flatMap(Notifications.Service, (service) =>
					service.mute({ kind: "bot", id: botId }, until),
				),
			);
		await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) =>
				service.setLevel({ kind: "bot", id: botId }, "all"),
			),
		);
		await muteUntil(people.ada, new Date(Date.now() + 60_000));
		await muteUntil(people.bob, new Date(Date.now() - 60_000));

		await emit(await botReplied(chat, "Shipped."));

		expect(await deliveredTo(people.bob.id)).toHaveLength(1);
		expect(sentTo(people.ada.id)).toEqual([]);
		const settings = await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) => service.settings),
		);
		expect(settings.bots).toEqual({ [botId]: "all" });
		expect(settings.mutedUntil.bots).toEqual({});
	});

	it("quiets every bot in a project muted for a while, even one with a level of its own", async () => {
		const chat = await projectChat();
		for (const person of [people.ada, people.bob]) {
			await as(
				person.id,
				Effect.flatMap(Notifications.Service, (service) =>
					service.setLevel({ kind: "bot", id: botId }, "all"),
				),
			);
		}
		await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) =>
				service.mute({ kind: "project", id: projectId }, new Date(Date.now() + 60_000)),
			),
		);

		await emit(await botReplied(chat, "Shipped."));

		expect(await deliveredTo(people.ada.id)).toHaveLength(1);
		expect(sentTo(people.bob.id)).toEqual([]);
	});

	/**
	 * A run the bot does, in a chat of its own, which Ada started, of an
	 * automation `createdById` made in `inProjectId`, by default one of the
	 * bot's own, ended as `ended` when given.
	 */
	const automationRunElsewhere = async (
		ended?: { state: "completed" | "failed"; error?: UserText },
		createdById?: string,
		name = "Digest",
		inProjectId?: string,
	) => {
		const [ownProject] = await onDatabase((db) =>
			db.select({ id: project.id }).from(project).where(eq(project.defaultOfBotId, botId)),
		);
		if (!ownProject) throw new Error("The bot has no default project");
		const [defined] = await onDatabase((db) =>
			db
				.insert(automation)
				.values({
					workspaceId,
					projectId: inProjectId ?? ownProject.id,
					name,
					instructions: "Summarise",
					createdById,
				})
				.returning(),
		);
		if (!defined) throw new Error("Could not create the automation");
		const requestId = crypto.randomUUID();
		const run = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "run",
				title: "Digest",
				run: {
					automationId: defined.id,
					botId: botId,
					triggerKind: "manual",
					triggerIdentity: requestId,
					trigger: {
						kind: "manual",
						requestId,
						requestedAt: new Date().toISOString(),
						requestedByPersonId: people.ada.id,
					},
					automationName: "Digest",
					instructions: "Summarise",
					...(ended && {
						state: ended.state,
						error: ended.error,
						startedAt: new Date(),
						finishedAt: new Date(),
					}),
				},
			}),
		);
		return run.id;
	};

	const runSettled = (chatId: string) =>
		ChatEvent.RunSettled({
			workspaceId,
			rootChatId: chatId,
			chatId,
		});

	it("tells the person who made an automation and the one who ran it when a run fails, and not when it finishes", async () => {
		const failedRun = await automationRunElsewhere(
			{ state: "failed", error: userText`The calendar could not be read.` },
			people.bob.id,
		);
		const finishedRun = await automationRunElsewhere(
			{ state: "completed" },
			people.bob.id,
			"Briefing",
		);

		await emit(runSettled(failedRun), runSettled(finishedRun));

		const failure = {
			title: "Digest failed",
			body: "The calendar could not be read.",
			tag: `automation:${failedRun}`,
			path: `/${workspaceSlug}/chats/${failedRun}?nestedChatPage=${failedRun}`,
			chatId: failedRun,
		};
		expect(await deliveredTo(people.bob.id)).toEqual([failure]);
		expect(await deliveredTo(people.ada.id)).toEqual([failure]);
		expect(sentTo(people.cy.id)).toEqual([]);
	});

	it("tells somebody of every run of their automation when they chose to", async () => {
		const run = await automationRunElsewhere({ state: "completed" }, people.bob.id);
		await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) =>
				service.updatePreferences(preferences({ automationRuns: "all" })),
			),
		);

		await emit(runSettled(run));

		expect(await deliveredTo(people.bob.id)).toEqual([
			expect.objectContaining({ title: "Digest finished", body: "Scout finished the run." }),
		]);
		expect(sentTo(people.ada.id)).toEqual([]);
	});

	it("tells those an automation's result mentions in its automation's feed, unless it went to a project as well", async () => {
		const runChat = await automationRunElsewhere({ state: "completed" }, people.bob.id);
		const [run] = await onDatabase((db) =>
			db
				.select({ id: automationRun.id, automationId: automationRun.automationId })
				.from(automationRun)
				.where(eq(automationRun.chatId, runChat)),
		);
		if (!run) throw new Error("fixture");
		const { id: feed } = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "automation_feed",
				automationId: run.automationId,
				title: "Digest",
			}),
		);
		await chooseLevel(people.cy.id, "all");
		const content = `@${handleFromName(people.ada.name)} the calendar needs reconnecting.`;
		const resultPosted = async (chatId: string) => {
			const id = crypto.randomUUID();
			await onDatabase((db) =>
				db.insert(message).values({
					id,
					chatId,
					authorBotId: botId,
					runId: run.id,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: content }],
					content,
				}),
			);
			return ChatEvent.MessagePosted({
				chatId,
				workspaceId,
				message: {
					id,
					content,
					parts: [{ type: "text", text: content }],
					author: {
						kind: "bot",
						id: botId,
						name: "Scout",
						handle: "scout",
						color: "green",
						eyes: "pill",
						shape: "circle",
					},
					automationResultOf: {
						runId: run.id,
						chatId: runChat,
						automationId: run.automationId,
						automationName: "Digest",
					},
				} as Message,
			});
		};

		const inFeed = await resultPosted(feed);
		await emit(inFeed);

		expect(await deliveredTo(people.ada.id)).toEqual([
			{
				title: "Scout mentioned you in Digest",
				body: content,
				tag: chatNotificationTag(feed),
				path: `/${workspaceSlug}/chats/${feed}?nestedChatPage=${runChat}`,
				chatId: feed,
			},
		]);
		// Everything is what is said in chats; an automation's feed speaks up only for those it mentions.
		expect(sentTo(people.cy.id)).toEqual([]);

		published.length = 0;
		const chat = await projectChat();
		const inChat = await resultPosted(chat);
		await emit(inFeed, inChat);

		expect(await deliveredTo(people.ada.id)).toEqual([
			expect.objectContaining({ tag: chatNotificationTag(chat) }),
		]);
	});

	it("tells the person a bot was answering that its reply failed, unless they turned that off", async () => {
		const chat = await chatWithBot([people.ada.id, people.bob.id]);
		const failedTurn = async (asker: { id: string }) => {
			const asked = crypto.randomUUID();
			await onDatabase((db) =>
				db.insert(message).values({
					id: asked,
					chatId: chat,
					authorPersonId: asker.id,
					kind: "text",
					status: "complete",
					parts: [],
					content: "Draft the notes",
				}),
			);
			const turnId = crypto.randomUUID();
			await onDatabase((db) =>
				db.insert(turn).values({
					id: turnId,
					chatId: chat,
					botId: botId,
					triggerMessageId: asked,
					status: "failed",
					model: "test/model",
					startedAt: new Date(),
				}),
			);
			return ChatEvent.TurnFailed({
				chatId: chat,
				workspaceId,
				turnId,
				botId: botId,
				messageId: crypto.randomUUID(),
				userMessage: userText`The model is unavailable.`,
				willRetry: false,
			});
		};
		await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) =>
				service.updatePreferences(preferences({ turnFailures: false })),
			),
		);

		await emit(await failedTurn(people.ada), await failedTurn(people.bob));

		expect(await deliveredTo(people.ada.id)).toEqual([
			expect.objectContaining({
				title: "Scout couldn't finish its reply",
				body: "The model is unavailable.",
			}),
		]);
		expect(sentTo(people.bob.id)).toEqual([]);
	});

	/**
	 * A turn of the bot, asked by Ada in `chat`, waiting for approval
	 * of a call to each of `tools`, raised in that order.
	 */
	const turnWaitingOn = async (chat: string, tools: readonly string[]) => {
		const triggerId = crypto.randomUUID();
		const replyId = crypto.randomUUID();
		const turnId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values({
				id: triggerId,
				chatId: chat,
				authorPersonId: people.ada.id,
				kind: "text",
				status: "complete",
				parts: [],
				content: "Post the notes",
			}),
		);
		await onDatabase((db) =>
			db.insert(turn).values({
				id: turnId,
				chatId: chat,
				botId: botId,
				triggerMessageId: triggerId,
				status: "waiting",
				model: "test/model",
				startedAt: new Date(),
			}),
		);
		await onDatabase((db) =>
			db.insert(message).values({
				id: replyId,
				chatId: chat,
				authorBotId: botId,
				kind: "text",
				status: "complete",
				parts: [],
				content: "",
				turnId,
			}),
		);
		const callIds = tools.map(() => crypto.randomUUID());
		const startedAt = Date.now();
		await onDatabase((db) =>
			db.insert(toolCall).values(
				tools.map((tool, index) => ({
					id: callIds[index],
					chatId: chat,
					messageId: replyId,
					turnId,
					tool,
					approvalStatus: "pending" as const,
					input: {},
					atOffset: index,
					startedAt: new Date(startedAt + index),
				})),
			),
		);
		return { turnId, callIds };
	};

	it("asks the people who may decide a bot's tool call to approve it", async () => {
		// Only Ada, who made it, reaches a private bot, so only she may decide its calls.
		await onDatabase((db) =>
			db.update(botTable).set({ visibility: "private" }).where(eq(botTable.id, botId)),
		);
		// An automation run elsewhere must not make this call one raised during a run.
		await automationRunElsewhere();
		const chat = await chatWithBot([people.ada.id]);
		const { turnId, callIds } = await turnWaitingOn(chat, ["post_message"]);
		const [callId] = callIds;

		await emit(ChatEvent.TurnSuspended({ chatId: chat, workspaceId, turnId }));

		expect(await deliveredTo(people.ada.id)).toEqual([
			{
				title: "Scout needs your approval",
				body: "To run post_message in Release notes",
				tag: `approval:${turnId}`,
				path: `/${workspaceSlug}/approvals/${callId}`,
				chatId: chat,
			},
		]);
		expect(sentTo(people.bob.id)).toEqual([]);
		expect(sentTo(people.outsider.id)).toEqual([]);
	});

	it("links each person to an approval they may decide, leaving out computer requests they may not", async () => {
		// Ada administers the workspace, so she manages the project's computer; Bob is only an editor.
		await onDatabase((db) =>
			db.update(membership).set({ role: "admin" }).where(eq(membership.personId, people.ada.id)),
		);
		const chat = await projectChat();
		const { turnId, callIds } = await turnWaitingOn(chat, [HOST_REQUEST_TOOL, "post_message"]);
		const [networkCallId, postCallId] = callIds;

		await emit(ChatEvent.TurnSuspended({ chatId: chat, workspaceId, turnId }));

		expect(await deliveredTo(people.ada.id)).toEqual([
			{
				title: "Scout needs your approval",
				body: "To run 2 tools in Launch",
				tag: `approval:${turnId}`,
				path: `/${workspaceSlug}/approvals/${networkCallId}`,
				chatId: chat,
			},
		]);
		expect(await deliveredTo(people.bob.id)).toEqual([
			{
				title: "Scout needs your approval",
				body: "To run post_message in Launch",
				tag: `approval:${turnId}`,
				path: `/${workspaceSlug}/approvals/${postCallId}`,
				chatId: chat,
			},
		]);
	});

	it("asks the lead bot's creator and admins to approve what a project's run asks, and no other editor", async () => {
		// Scout, which Ada made, leads the project; Cy administers the workspace; Bob is only an editor.
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
		);
		await onDatabase((db) =>
			db.update(membership).set({ role: "admin" }).where(eq(membership.personId, people.cy.id)),
		);
		const runChat = await automationRunElsewhere(undefined, people.bob.id, "Digest", projectId);
		const { turnId, callIds } = await turnWaitingOn(runChat, ["post_message"]);
		const [callId] = callIds;

		await emit(ChatEvent.TurnSuspended({ chatId: runChat, workspaceId, turnId }));

		const asked = {
			title: "Scout needs your approval",
			body: "To run post_message in Digest",
			tag: `approval:${turnId}`,
			path: `/${workspaceSlug}/approvals/${callId}`,
			chatId: expect.any(String),
		};
		expect(await deliveredTo(people.ada.id)).toEqual([asked]);
		expect(await deliveredTo(people.cy.id)).toEqual([asked]);
		expect(sentTo(people.bob.id)).toEqual([]);
	});
});

import {
	type Channel,
	handleFromName,
	type Message,
	type NotificationContent,
	type NotificationPreferences,
	type PushDevice,
	type PushService,
	personChannel,
	type StreamEvent,
} from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentActor } from "../authorization/current-actor.ts";
import { ConversationEvent } from "../conversations/events.ts";
import { transaction } from "../database/database.ts";
import { EventBus } from "../database/events/bus.ts";
import {
	agent,
	message,
	pod,
	podMember,
	routine,
	routineExecution,
	session,
	thread,
	threadParticipant,
	toolCall,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	runOnPostgres,
	type TestInfrastructure,
} from "../database/testing.ts";
import { Push } from "../push/push.ts";
import { unimplemented } from "../testing.ts";
import { Notifications } from "./notifications.ts";
import { inQuietHours } from "./recipients.ts";

/** The preferences a person has before choosing, with `chosen` in their place. */
function preferences(chosen: Partial<NotificationPreferences>): NotificationPreferences {
	return {
		level: "mentions",
		pausedUntil: null,
		quietHours: null,
		turnFailures: true,
		routineRuns: "failures",
		...chosen,
	};
}

/** What the service published on the bus, for every test in the file. */
const published: { channel: Channel; event: StreamEvent }[] = [];

/** What the service pushed to phones, for every test in the file. */
const pushed: { device: PushDevice; notification: NotificationContent }[] = [];

/** Phones Apple would say are gone, by token. */
const goneTokens = new Set<string>();

/** Tokens Apple would refuse as malformed, for another app, or for the other environment. */
const refusedTokens = new Set<string>();

/** Tokens Apple couldn't be asked about, as when it is unreachable. */
const uncheckableTokens = new Set<string>();

/** Push services this installation has no key for. */
const unreachedServices = new Set<PushService>();

/**
 * The service over the test database's own pool, publishing to `published`
 * and pushing to `pushed`, with `run` to call it and `close` to stop what it
 * is still sending.
 */
async function served() {
	const scope = Scope.makeUnsafe();
	const bus = unimplemented(EventBus.Service, {
		publish: async (channel, event) => {
			published.push({ channel, event });
		},
	});
	const refusal = (token: string) =>
		goneTokens.has(token)
			? Effect.fail(new Push.DeviceGone({ reason: "Unregistered" }))
			: refusedTokens.has(token)
				? Effect.fail(new Push.TokenRefused({ reason: "BadDeviceToken" }))
				: undefined;
	const push = Layer.succeed(Push.Service, {
		reaches: (service) => !unreachedServices.has(service),
		send: (device, notification) =>
			refusal(device.token) ??
			Effect.sync(() => {
				pushed.push({ device, notification });
			}),
		check: (device) =>
			refusal(device.token) ??
			(uncheckableTokens.has(device.token)
				? Effect.fail(new Push.DeliveryFailed({ service: device.service, cause: "unreachable" }))
				: Effect.void),
	});
	const context = await runOnPostgres(
		Layer.buildWithScope(Notifications.layerNoDeps.pipe(Layer.provide([bus, push])), scope),
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
		userId: string,
		effect: Effect.Effect<A, E, CurrentActor.Service | Notifications.Service>,
	) => run(effect.pipe(CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId))));
	const emit = async (...events: ConversationEvent[]) => {
		const { handler } = await notifications();
		await run(transaction(handler(events)));
	};
	const sentTo = (userId: string) =>
		published
			.filter(
				({ channel, event }) => channel === personChannel(userId) && event.type === "notification",
			)
			.map(({ event: { type: _type, v: _version, ...notification } }) => notification);
	/** Waits for `userId` to be sent something, then for anything sent alongside it. */
	const deliveredTo = async (userId: string) => {
		await vi.waitFor(() => expect(sentTo(userId)).not.toHaveLength(0), { timeout: 5_000 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		return sentTo(userId);
	};

	let workspaceId: string;
	let workspaceSlug: string;
	let podId: string;
	let podSlug: string;
	let botId: string;
	let people: Record<"ada" | "bob" | "cy" | "outsider", { id: string; name: string }>;

	afterAll(async () => {
		await (await service).close();
		await closeDatabase();
	});

	beforeEach(async () => {
		published.length = 0;
		pushed.length = 0;
		goneTokens.clear();
		refusedTokens.clear();
		uncheckableTokens.clear();
		unreachedServices.clear();
		const suffix = crypto.randomUUID().slice(0, 8);
		const names = {
			ada: `Ada ${suffix}`,
			bob: `Bob ${suffix}`,
			cy: `Cy ${suffix}`,
			outsider: `Outsider ${suffix}`,
		};
		const rows = await onDatabase((db) =>
			db
				.insert(user)
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
			db.insert(workspaceMember).values(rows.map((person) => ({ workspaceId, userId: person.id }))),
		);
		podSlug = `pod-${suffix}`;
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: ada.id,
					kind: "shared",
					name: "Launch",
					slug: podSlug,
					createdById: ada.id,
				})
				.returning(),
		);
		if (!room) throw new Error("Could not create the pod");
		podId = room.id;
		// Everybody but the outsider is in the pod.
		await onDatabase((db) =>
			db
				.insert(podMember)
				.values([ada, bob, cy].map((person) => ({ workspaceId, podId, userId: person.id }))),
		);
		const [bot] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId,
					name: "Scout",
					handle: `scout-${suffix}`,
					color: "green",
					face: "pill",
					model: "test/model",
					createdById: ada.id,
				})
				.returning(),
		);
		if (!bot) throw new Error("Could not create the bot");
		botId = bot.id;
	});

	const conversationWithBot = async (participants: readonly string[]) => {
		const id = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(thread).values({
				id,
				workspaceId,
				podId,
				hostAgentId: botId,
				conversationId: id,
				type: "conversation",
				title: "Release notes",
			}),
		);
		await onDatabase((db) =>
			db
				.insert(threadParticipant)
				.values([
					{ threadId: id, agentId: botId },
					...participants.map((userId) => ({ threadId: id, userId })),
				]),
		);
		return id;
	};

	const podChat = async () => {
		const id = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(thread).values({
				id,
				workspaceId,
				podId,
				conversationId: id,
				type: "pod_chat",
				title: "Launch",
				main: true,
			}),
		);
		return id;
	};

	/**
	 * The bot's turn answering `askedBy`, finished with `content`. Nobody in
	 * the pod asks, unless a test says who did.
	 */
	const botReplied = async (
		threadId: string,
		content: string,
		askedBy: { id: string } = people.outsider,
	) => {
		const asked = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values({
				id: asked,
				threadId,
				authorUserId: askedBy.id,
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
				threadId,
				agentId: botId,
				triggerMessageId: asked,
				status: "done",
				model: "test/model",
				startedAt: new Date(),
			}),
		);
		return ConversationEvent.TurnCompleted({
			threadId,
			workspaceId,
			podId,
			turnId,
			agentId: botId,
			messageId: crypto.randomUUID(),
			content,
			contextTokens: undefined,
			contextCapacity: 0,
			readKeptFrom: null,
		});
	};

	const personPosted = (
		threadId: string,
		author: { id: string; name: string },
		content: string,
		more: Partial<Message> = {},
	) =>
		ConversationEvent.MessagePosted({
			threadId,
			workspaceId,
			podId,
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

	const chooseLevel = (userId: string, level: "all" | "mentions" | "nothing") =>
		as(
			userId,
			Effect.flatMap(Notifications.Service, (service) =>
				service.updatePreferences(preferences({ level })),
			),
		);

	it("tells a person they were mentioned in the pod's chat, linking to the message", async () => {
		const chat = await podChat();
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
				tag: `conversation:${chat}`,
				path: `/${workspaceSlug}/activity/${podSlug}/${chat}?message=${posted.message.id}`,
				conversationId: chat,
			},
		]);
		// Not the author, nor somebody who was only in the pod.
		expect(sentTo(people.ada.id)).toEqual([]);
		expect(sentTo(people.cy.id)).toEqual([]);
	});

	it.each(["@here the launch moved to Friday", "@channel the launch moved to Friday"])(
		"tells everyone in the pod of a person's %s, but not the author or an outsider",
		async (text) => {
			const chat = await podChat();

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
		const conversation = await conversationWithBot([people.ada.id]);
		await chooseLevel(people.ada.id, "all");

		await emit(await botReplied(conversation, "@channel I am done."));

		expect(await deliveredTo(people.ada.id)).toEqual([
			expect.objectContaining({ title: "Scout in Release notes" }),
		]);
		expect(sentTo(people.bob.id)).toEqual([]);
	});

	it("tells a person of a reply to their message in the pod's chat, and names a file shared without text", async () => {
		const chat = await podChat();
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

	it("names the artifacts a routine's result shares without text in the pod's chat", async () => {
		const chat = await podChat();
		await chooseLevel(people.bob.id, "all");
		const resultSharing = (titles: readonly string[]) =>
			ConversationEvent.MessagePosted({
				threadId: chat,
				workspaceId,
				podId,
				message: {
					id: crypto.randomUUID(),
					content: "",
					parts: titles.map((title) => ({
						type: "artifact",
						artifactId: crypto.randomUUID(),
						kind: "html",
						title,
						version: 1,
					})),
					author: {
						kind: "agent",
						id: botId,
						name: "Scout",
						handle: "scout",
						color: "green",
						face: "pill",
						shape: "circle",
					},
				} as Message,
			});

		await emit(resultSharing(["Weekly traction"]));
		await emit(resultSharing(["Weekly traction", "Pipeline"]));

		expect(await deliveredTo(people.bob.id)).toEqual([
			expect.objectContaining({ body: "Shared Weekly traction" }),
			expect.objectContaining({ body: "Shared 2 artifacts" }),
		]);
	});

	it("tells the people in a conversation of a bot's reply, and those who chose everything", async () => {
		const conversation = await conversationWithBot([people.ada.id]);
		await chooseLevel(people.cy.id, "all");

		await emit(await botReplied(conversation, "The release notes are drafted."));

		expect(await deliveredTo(people.ada.id)).toEqual([
			expect.objectContaining({
				title: "Scout in Release notes",
				body: "The release notes are drafted.",
			}),
		]);
		expect(await deliveredTo(people.cy.id)).toHaveLength(1);
		expect(sentTo(people.bob.id)).toEqual([]);
		expect(sentTo(people.outsider.id)).toEqual([]);
	});

	it("leaves out somebody who muted the bot or paused", async () => {
		const conversation = await conversationWithBot([people.ada.id, people.bob.id, people.cy.id]);
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

		await emit(await botReplied(conversation, "Done."));

		expect(await deliveredTo(people.ada.id)).toHaveLength(1);
		expect(sentTo(people.bob.id)).toEqual([]);
		expect(sentTo(people.cy.id)).toEqual([]);
	});

	it("passes what one of a person's tabs is looking at to their other tabs, and nobody else", async () => {
		const looking = {
			clientId: crypto.randomUUID(),
			conversationId: crypto.randomUUID(),
			sequence: 1,
		};

		await as(
			people.ada.id,
			Effect.flatMap(Notifications.Service, (service) => service.reportPresence(looking)),
		);

		expect(published).toEqual([
			{
				channel: personChannel(people.ada.id),
				event: expect.objectContaining({ type: "presence", ...looking }),
			},
		]);
	});

	/** A push token as the app writes it, different each time. */
	const pushToken = () => crypto.randomUUID().replaceAll("-", "").repeat(2);
	/** A session of `userId`'s, as signing in on a phone makes one `agoMs` before, lasting `lifetimeMs` more. */
	const signedIn = async (userId: string, lifetimeMs = 60 * 60_000, agoMs = 0) => {
		const [row] = await onDatabase((db) =>
			db
				.insert(session)
				.values({
					userId,
					token: crypto.randomUUID(),
					createdAt: new Date(Date.now() - agoMs),
					expiresAt: new Date(Date.now() + lifetimeMs),
				})
				.returning(),
		);
		if (!row) throw new Error("Could not sign in");
		return row.id;
	};
	const registerDevice = (
		userId: string,
		sessionId: string,
		token: string,
		device: PushDevice = { service: "apns", token, environment: "production" },
	) =>
		as(
			userId,
			Effect.flatMap(Notifications.Service, (service) => service.registerDevice(sessionId, device)),
		);
	const tokensOf = async (userId: string) =>
		(await onDatabase((db) => db.select().from(session).where(eq(session.userId, userId))))
			.flatMap((row) => (row.pushToken ? [row.pushToken] : []))
			.sort();
	const sendTestTo = (userId: string) =>
		as(
			userId,
			Effect.flatMap(Notifications.Service, (service) => service.sendTest),
		);

	it("pushes what it sends a person's tabs to each phone they are signed in on", async () => {
		const [phone, tablet] = [pushToken(), pushToken()];
		await registerDevice(people.bob.id, await signedIn(people.bob.id), phone);
		await registerDevice(people.bob.id, await signedIn(people.bob.id), tablet);
		const chat = await podChat();

		await emit(
			personPosted(chat, people.ada, `@${handleFromName(people.bob.name)} is the quote ready?`),
		);

		const [notification] = await deliveredTo(people.bob.id);
		await vi.waitFor(() => expect(pushed).toHaveLength(2));
		expect(pushed).toEqual(
			expect.arrayContaining([
				{ device: expect.objectContaining({ token: phone }), notification },
				{ device: expect.objectContaining({ token: tablet }), notification },
			]),
		);
	});

	it("keeps a phone's session for 60 days, where a browser's lasts a week", async () => {
		const phone = await signedIn(people.ada.id, 7 * 24 * 60 * 60_000);
		await registerDevice(people.ada.id, phone, pushToken());

		expect(await daysLeftOn(phone)).toBeGreaterThan(59);
	});

	it("lengthens a phone's session no further than 90 days from signing in", async () => {
		const phone = await signedIn(people.ada.id, 24 * 60 * 60_000, 85 * 24 * 60 * 60_000);
		await registerDevice(people.ada.id, phone, pushToken());

		expect(await daysLeftOn(phone)).toBeGreaterThan(4);
		expect(await daysLeftOn(phone)).toBeLessThan(6);
	});

	it("lengthens the session without asking the push service again about the token it holds", async () => {
		const [token, phone] = [pushToken(), await signedIn(people.ada.id)];
		uncheckableTokens.add(token);
		await registerDevice(people.ada.id, phone, token);
		// Refused now: registering again succeeds only by not asking.
		uncheckableTokens.delete(token);
		refusedTokens.add(token);

		expect(await registerDevice(people.ada.id, phone, token)).toEqual({ available: true });
		expect(await daysLeftOn(phone)).toBeGreaterThan(59);
	});

	const daysLeftOn = async (sessionId: string) => {
		const [row] = await onDatabase((db) =>
			db.select().from(session).where(eq(session.id, sessionId)),
		);
		return ((row?.expiresAt.getTime() ?? 0) - Date.now()) / (24 * 60 * 60_000);
	};

	it("refuses a phone whose push service refuses its token, keeping nothing and not lengthening the session", async () => {
		const [token, phone] = [pushToken(), await signedIn(people.ada.id, 7 * 24 * 60 * 60_000)];
		refusedTokens.add(token);

		const refused = await as(
			people.ada.id,
			Effect.flip(
				Effect.flatMap(Notifications.Service, (service) =>
					service.registerDevice(phone, { service: "apns", token, environment: "production" }),
				),
			),
		);

		expect(refused).toBeInstanceOf(Notifications.PushDeviceRefused);
		expect(await tokensOf(people.ada.id)).toEqual([]);
		expect(await daysLeftOn(phone)).toBeLessThan(8);
	});

	it("keeps nothing for a platform this server can't push to, and says so", async () => {
		unreachedServices.add("fcm");
		const token = `android-${pushToken()}`;

		const registration = await registerDevice(people.ada.id, await signedIn(people.ada.id), token, {
			service: "fcm",
			token,
		});

		expect(registration).toEqual({ available: false });
		expect(await tokensOf(people.ada.id)).toEqual([]);
	});

	it("keeps a phone whose token couldn't be checked, without lengthening its session", async () => {
		const [token, phone] = [pushToken(), await signedIn(people.ada.id, 7 * 24 * 60 * 60_000)];
		uncheckableTokens.add(token);

		expect(await registerDevice(people.ada.id, phone, token)).toEqual({ available: true });
		expect(await tokensOf(people.ada.id)).toEqual([token]);
		expect(await daysLeftOn(phone)).toBeLessThan(8);
	});

	it("keeps a phone whose token is refused after it was taken, as that points at the server's settings", async () => {
		const token = pushToken();
		await registerDevice(people.ada.id, await signedIn(people.ada.id), token);
		refusedTokens.add(token);

		await sendTestTo(people.ada.id);

		expect(await tokensOf(people.ada.id)).toEqual([token]);
	});

	it("stops pushing to a phone once its session ends, by signing out or expiring", async () => {
		const [leaving, lapsing] = [await signedIn(people.ada.id), await signedIn(people.ada.id)];
		await registerDevice(people.ada.id, leaving, pushToken());
		await registerDevice(people.ada.id, lapsing, pushToken());
		await onDatabase((db) => db.delete(session).where(eq(session.id, leaving)));
		await onDatabase((db) =>
			db
				.update(session)
				.set({ expiresAt: new Date(Date.now() - 60_000) })
				.where(eq(session.id, lapsing)),
		);

		await sendTestTo(people.ada.id);

		expect(pushed).toEqual([]);
	});

	it("forgets a phone Apple says is gone, and keeps the others", async () => {
		const [gone, kept] = [pushToken(), pushToken()];
		await registerDevice(people.ada.id, await signedIn(people.ada.id), gone);
		await registerDevice(people.ada.id, await signedIn(people.ada.id), kept);
		goneTokens.add(gone);

		await sendTestTo(people.ada.id);

		expect(pushed).toEqual([
			{
				device: expect.objectContaining({ token: kept }),
				notification: expect.objectContaining({ tag: "test" }),
			},
		]);
		expect(await tokensOf(people.ada.id)).toEqual([kept]);
	});

	it("moves a phone to whoever signs in on it last", async () => {
		const token = pushToken();
		await registerDevice(people.ada.id, await signedIn(people.ada.id), token);
		await registerDevice(people.bob.id, await signedIn(people.bob.id), token);

		await sendTestTo(people.ada.id);

		expect(pushed).toEqual([]);
		expect(await tokensOf(people.ada.id)).toEqual([]);
		expect(await tokensOf(people.bob.id)).toEqual([token]);
	});

	it("lets a person turn off only their own session's phone", async () => {
		const token = pushToken();
		const bobs = await signedIn(people.bob.id);
		await registerDevice(people.bob.id, bobs, token);
		const unregister = (userId: string) =>
			as(
				userId,
				Effect.flatMap(Notifications.Service, (service) => service.unregisterDevice(bobs)),
			);

		await unregister(people.ada.id);
		expect(await tokensOf(people.bob.id)).toEqual([token]);

		await unregister(people.bob.id);
		expect(await tokensOf(people.bob.id)).toEqual([]);
	});

	it("lets a pod's level quiet its bots, and a bot's level win over it", async () => {
		const conversation = await conversationWithBot([people.ada.id, people.bob.id]);
		for (const person of [people.ada, people.bob]) {
			await as(
				person.id,
				Effect.flatMap(Notifications.Service, (service) =>
					service.setLevel({ kind: "pod", id: podId }, "nothing"),
				),
			);
		}
		await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) =>
				service.setLevel({ kind: "bot", id: botId }, "mentions"),
			),
		);

		await emit(await botReplied(conversation, "Shipped."));

		expect(await deliveredTo(people.bob.id)).toHaveLength(1);
		expect(sentTo(people.ada.id)).toEqual([]);
	});

	it("quiets a muted bot's replies in the pod's chat, and not what people post there", async () => {
		const chat = await podChat();
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
		const conversation = await conversationWithBot([people.ada.id, people.bob.id]);
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

		await emit(await botReplied(conversation, "Shipped."));

		expect(await deliveredTo(people.bob.id)).toHaveLength(1);
		expect(sentTo(people.ada.id)).toEqual([]);
		const settings = await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) => service.settings),
		);
		expect(settings.bots).toEqual({ [botId]: "all" });
		expect(settings.mutedUntil.bots).toEqual({});
	});

	it("quiets every bot in a pod muted for a while, even one with a level of its own", async () => {
		const conversation = await conversationWithBot([people.ada.id, people.bob.id]);
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
				service.mute({ kind: "pod", id: podId }, new Date(Date.now() + 60_000)),
			),
		);

		await emit(await botReplied(conversation, "Shipped."));

		expect(await deliveredTo(people.ada.id)).toHaveLength(1);
		expect(sentTo(people.bob.id)).toEqual([]);
	});

	it("tells the person a bot answers in its channel of the reply, and the others only when they chose everything", async () => {
		const channel = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(thread).values({
				id: channel,
				workspaceId,
				podId,
				hostAgentId: botId,
				conversationId: channel,
				type: "bot_channel",
				title: "Scout",
			}),
		);
		const reply = await botReplied(channel, "Two checklist items.", people.ada);
		await chooseLevel(people.cy.id, "all");

		await emit(reply);

		expect(await deliveredTo(people.ada.id)).toEqual([
			{
				title: "Scout",
				body: "Two checklist items.",
				tag: `conversation:${channel}`,
				path: `/${workspaceSlug}/activity/${podSlug}/${channel}?message=${reply.messageId}`,
				conversationId: channel,
			},
		]);
		expect(await deliveredTo(people.cy.id)).toHaveLength(1);
		expect(sentTo(people.bob.id)).toEqual([]);
	});

	/**
	 * A run of one of the bot's routines, in a thread of its own, which Ada
	 * started, of a routine `createdById` made, ended as `ended` when given.
	 */
	const routineRunElsewhere = async (
		ended?: { state: "completed" | "failed"; error?: UserText },
		createdById?: string,
		name = "Digest",
	) => {
		const [defined] = await onDatabase((db) =>
			db
				.insert(routine)
				.values({
					workspaceId,
					agentId: botId,
					name,
					instructions: "Summarise",
					createdById,
				})
				.returning(),
		);
		if (!defined) throw new Error("Could not create the routine");
		const threadId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(thread).values({
				id: threadId,
				workspaceId,
				podId,
				hostAgentId: botId,
				type: "routine",
				title: "Digest",
			}),
		);
		const requestId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(routineExecution).values({
				routineId: defined.id,
				workspaceId,
				agentId: botId,
				threadId,
				triggerKind: "manual",
				triggerIdentity: requestId,
				trigger: {
					kind: "manual",
					requestId,
					requestedAt: new Date().toISOString(),
					requestedByUserId: people.ada.id,
				},
				routineName: "Digest",
				instructions: "Summarise",
				...(ended && {
					state: ended.state,
					error: ended.error,
					startedAt: new Date(),
					finishedAt: new Date(),
				}),
			}),
		);
		return threadId;
	};

	const runSettled = (threadId: string) =>
		ConversationEvent.RoutineExecutionSettled({
			workspaceId,
			podId,
			conversationId: threadId,
			threadId,
		});

	it("tells the person who made a routine and the one who ran it when a run fails, and not when it finishes", async () => {
		const failedRun = await routineRunElsewhere(
			{ state: "failed", error: userText`The calendar could not be read.` },
			people.bob.id,
		);
		const finishedRun = await routineRunElsewhere(
			{ state: "completed" },
			people.bob.id,
			"Briefing",
		);

		await emit(runSettled(failedRun), runSettled(finishedRun));

		const failure = {
			title: "Digest failed",
			body: "The calendar could not be read.",
			tag: `routine:${failedRun}`,
			path: `/${workspaceSlug}/activity/${podSlug}/${failedRun}?threadPage=${failedRun}`,
			conversationId: failedRun,
		};
		expect(await deliveredTo(people.bob.id)).toEqual([failure]);
		expect(await deliveredTo(people.ada.id)).toEqual([failure]);
		expect(sentTo(people.cy.id)).toEqual([]);
	});

	it("tells somebody of every run of their routine when they chose to", async () => {
		const run = await routineRunElsewhere({ state: "completed" }, people.bob.id);
		await as(
			people.bob.id,
			Effect.flatMap(Notifications.Service, (service) =>
				service.updatePreferences(preferences({ routineRuns: "all" })),
			),
		);

		await emit(runSettled(run));

		expect(await deliveredTo(people.bob.id)).toEqual([
			expect.objectContaining({ title: "Digest finished", body: "Scout finished the run." }),
		]);
		expect(sentTo(people.ada.id)).toEqual([]);
	});

	it("tells the person a bot was answering that its reply failed, unless they turned that off", async () => {
		const conversation = await conversationWithBot([people.ada.id, people.bob.id]);
		const failedTurn = async (asker: { id: string }) => {
			const asked = crypto.randomUUID();
			await onDatabase((db) =>
				db.insert(message).values({
					id: asked,
					threadId: conversation,
					authorUserId: asker.id,
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
					threadId: conversation,
					agentId: botId,
					triggerMessageId: asked,
					status: "failed",
					model: "test/model",
					startedAt: new Date(),
				}),
			);
			return ConversationEvent.TurnFailed({
				threadId: conversation,
				workspaceId,
				podId,
				turnId,
				agentId: botId,
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

	it("asks the people who may decide a bot's tool call to approve it", async () => {
		// A routine run elsewhere must not make this call one raised during a run.
		await routineRunElsewhere();
		const conversation = await conversationWithBot([people.ada.id]);
		const triggerId = crypto.randomUUID();
		const replyId = crypto.randomUUID();
		const turnId = crypto.randomUUID();
		const callId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values({
				id: triggerId,
				threadId: conversation,
				authorUserId: people.ada.id,
				kind: "text",
				status: "complete",
				parts: [],
				content: "Post the notes",
			}),
		);
		await onDatabase((db) =>
			db.insert(turn).values({
				id: turnId,
				threadId: conversation,
				agentId: botId,
				triggerMessageId: triggerId,
				status: "waiting",
				model: "test/model",
				startedAt: new Date(),
			}),
		);
		await onDatabase((db) =>
			db.insert(message).values({
				id: replyId,
				threadId: conversation,
				authorAgentId: botId,
				kind: "text",
				status: "complete",
				parts: [],
				content: "",
				turnId,
			}),
		);
		await onDatabase((db) =>
			db.insert(toolCall).values({
				id: callId,
				threadId: conversation,
				messageId: replyId,
				turnId,
				tool: "post_message",
				approvalStatus: "pending",
				input: {},
				atOffset: 0,
			}),
		);

		await emit(
			ConversationEvent.TurnSuspended({ threadId: conversation, workspaceId, podId, turnId }),
		);

		expect(await deliveredTo(people.ada.id)).toEqual([
			{
				title: "Scout needs your approval",
				body: "To run post_message in Release notes",
				tag: `approval:${turnId}`,
				path: `/${workspaceSlug}/approvals/${callId}`,
				conversationId: conversation,
			},
		]);
		// Outside the pod, so nobody asks them.
		expect(sentTo(people.outsider.id)).toEqual([]);
	});
});

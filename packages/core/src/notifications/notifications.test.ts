import {
	chatNotificationTag,
	type EventStream,
	HOST_REQUEST_TOOL,
	handleFromName,
	type Message,
	memberStream,
	type NotificationLevel,
	type NotificationPreferences,
	type NotificationSettings,
	type Presence,
	type StreamEvent,
	streamEvent,
} from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, Metric, Scope } from "effect";
import { afterAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { askerColumns } from "../authentication/turn-facts.ts";
import { ChatEvent } from "../chats/events.ts";
import { seedChat } from "../chats/seed.test-support.ts";
import { query, transaction } from "../database/database.ts";
import { Audience } from "../database/events/audience.ts";
import { EventBus } from "../database/events/bus.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { EventStore } from "../database/events/store.ts";
import {
	automation,
	automationRun,
	bot as botTable,
	chatParticipant,
	membership,
	message,
	notificationDelivery,
	pendingNotification,
	project,
	projectBot,
	projectMember,
	toolCall,
	turn,
} from "../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	runOnPostgres,
	type TestInfrastructure,
	waitUntilWaitingOnLocks,
} from "../database/testing.ts";
import { createWorkspaceFixture } from "../database/workspace.test-support.ts";
import { servedOperations } from "../operations/testing.ts";
import { authenticators, principals } from "../proofs/world.test-support.ts";
import { unimplemented } from "../testing.ts";
import { seedProject } from "../workspaces/projects/seed.test-support.ts";
import { Notifications } from "./notifications.ts";

/** The preferences a member has before choosing, with `chosen` in their place. */
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

/** `minutes` after midnight, wrapped round the day, as `HH:MM`. */
function clockTime(minutes: number): string {
	const wrapped = minutes % (24 * 60);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/** What the service published on the bus, for every test in the file. */
const published: { stream: EventStream; event: StreamEvent }[] = [];

/** A bus that hands each event published on it, stored or not, to `publishOne`. */
const busPublishing = (publishOne: (stream: EventStream, event: StreamEvent) => Promise<void>) =>
	unimplemented(EventBus.Service, {
		publish: publishOne,
		publishCommitted: async (committed) => {
			for (const { stream, event } of committed) await publishOne(stream, event);
		},
	});

/** A bus that keeps what is published in `published`. */
const capturingBus = busPublishing(async (stream, event) => {
	published.push({ stream, event });
});

/**
 * `handled`, and a promise that settles once every fiber it started has
 * ended: among them the batch of notifications it starts sending in the
 * background once it commits, which `handled` itself does not wait for. A
 * fiber inherits what records fiber lifecycles from the one that started it.
 * The promise rejects with the first of them that failed other than by being
 * interrupted, as a losing racer is.
 */
function joiningWhatItStarts<A, E, R>(handled: Effect.Effect<A, E, R>) {
	const allEnded = Promise.withResolvers<void>();
	let running = 0;
	let returned = false;
	let failure: { readonly cause: unknown } | undefined;
	const settleOnceIdle = () => {
		if (!returned || running > 0) return;
		if (failure) allEnded.reject(failure.cause);
		else allEnded.resolve();
	};
	const lifecycles: Metric.FiberRuntimeMetricsService = {
		recordFiberStart: () => {
			running++;
		},
		recordFiberEnd: (_context, exit) => {
			running--;
			if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
				failure ??= { cause: Cause.squash(exit.cause) };
			}
			settleOnceIdle();
		},
	};
	return {
		handled: Effect.provideService(handled, Metric.FiberRuntimeMetrics, lifecycles).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					returned = true;
					settleOnceIdle();
				}),
			),
		),
		allEnded: allEnded.promise,
	};
}

/** The notifications operations for one member signed in, by the names these cases use. */
interface NotificationsAs {
	readonly settings: Promise<NotificationSettings>;
	updatePreferences(preferences: NotificationPreferences): Promise<NotificationSettings>;
	setLevel(place: Notifications.Place, level: NotificationLevel): Promise<void>;
	mute(place: Notifications.Place, until: Date): Promise<void>;
	reportPresence(presence: Presence): Promise<void>;
}

/**
 * The service over the test database's own pool, publishing to `published`,
 * with `run` to call it and `close` to stop what it is still sending.
 */
async function served(
	bus = capturingBus,
	outbox: Layer.Layer<EventOutbox.Service, never, EventBus.Service> = EventOutbox.layer,
) {
	const scope = Scope.makeUnsafe();
	const context = await runOnPostgres(
		Layer.buildWithScope(
			Notifications.layer.pipe(Layer.provide(outbox), Layer.provide(bus)),
			scope,
		),
	);
	return {
		run: <A, E>(effect: Effect.Effect<A, E, Notifications.Service | TestInfrastructure>) =>
			runOnPostgres(Effect.provide(effect, context)),
		close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
	};
}

describe.skipIf(!process.env.DATABASE_URL)("notifications, against Postgres", () => {
	const service = served();
	const run = async <A, E>(
		effect: Effect.Effect<A, E, Notifications.Service | TestInfrastructure>,
	) => (await service).run(effect);
	const notifications = () => run(Notifications.Service);
	/**
	 * The notifications operations, called through the registry for a member
	 * signed in, publishing to the same bus as `service`.
	 */
	const operations = (async () => {
		const callOperation = await servedOperations({ bus: capturingBus });
		const signedIn = principals(await authenticators());
		return { callOperation, signedIn };
	})();
	/** What `use` comes to with the notifications operations called for `memberId` signed in. */
	const as = async <A>(memberId: string, use: (service: NotificationsAs) => Promise<A>) => {
		const { callOperation, signedIn } = await operations;
		const principal = await signedIn.member(memberId);
		return use({
			get settings() {
				return callOperation(principal, "notifications.settings", {});
			},
			updatePreferences: (chosen) =>
				callOperation(principal, "notifications.updatePreferences", chosen),
			setLevel: (place, level) =>
				callOperation(principal, "notifications.setLevel", { ...place, level }),
			mute: (place, until) =>
				callOperation(principal, "notifications.mute", { ...place, until: until.toISOString() }),
			reportPresence: (presence) =>
				callOperation(principal, "notifications.reportPresence", presence),
		});
	};
	/**
	 * Commits `events` as their handler. Returns the end of the batch of
	 * notifications they start sending in the background.
	 */
	const emitting = async (...events: ChatEvent[]) => {
		const { handler } = await notifications();
		const { handled, allEnded } = joiningWhatItStarts(transaction(handler(events)));
		await run(handled);
		return { batchEnded: allEnded };
	};
	/** Commits `events` as their handler, and waits for everything they notify to be sent. */
	const emit = async (...events: ChatEvent[]) => {
		await (await emitting(...events)).batchEnded;
	};
	/** The notifications published for `memberId`, as their stream sends them. */
	const sentTo = (memberId: string) =>
		published
			.filter(
				({ stream, event }) => stream === memberStream(memberId) && event.type === "notification",
			)
			.map(({ event }) => {
				const { type: _type, v: _version, ...notification } = Audience.read(event).event;
				return notification;
			});

	let workspaceId: string;
	let workspaceSlug: string;
	let projectId: string;
	let projectSlug: string;
	let botId: string;
	let members: Record<"ada" | "bob" | "cy" | "outsider", { id: string; name: string }>;

	afterAll(async () => {
		await (await service).close();
		await closeDatabase();
	});

	beforeEach(async () => {
		published.length = 0;
		const suffix = crypto.randomUUID().slice(0, 8);
		workspaceSlug = `notify-${suffix}`;
		const { workspace: space, members: seeded } = await createWorkspaceFixture(
			{ name: "Notify", slug: workspaceSlug },
			{
				ada: { name: `Ada ${suffix}`, role: "editor" },
				bob: { name: `Bob ${suffix}`, role: "editor" },
				cy: { name: `Cy ${suffix}`, role: "editor" },
				outsider: { name: `Outsider ${suffix}`, role: "editor" },
			},
		);
		members = seeded;
		const { ada, bob, cy } = members;
		workspaceId = space.id;
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
				.values([ada, bob, cy].map((member) => ({ workspaceId, projectId, memberId: member.id }))),
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
				startedById: members.ada.id,
			}),
		);
		await onDatabase((db) =>
			db
				.insert(chatParticipant)
				.values([
					{ chatId: id, botId: botId },
					...participants.map((memberId) => ({ chatId: id, memberId })),
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
				startedById: members.ada.id,
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
		askerId: { id: string } = members.outsider,
	) => {
		const asked = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values({
				id: asked,
				chatId,
				authorMemberId: askerId.id,
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
				...askerColumns({ chatId: chatId, botId: botId, triggerMessageId: asked }),
			}),
		);
		return ChatEvent.TurnCompleted({
			chatId,
			workspaceId,
			turnId,
			botId: botId,
			messageId: crypto.randomUUID(),
			execution: 1,
			content,
			finishedAt: new Date(),
			contextTokens: undefined,
			contextCapacity: 0,
			readKeptFrom: null,
		});
	};

	const memberPosted = (
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
					kind: "member",
					id: author.id,
					name: author.name,
					email: `${handleFromName(author.name)}@example.com`,
					handle: handleFromName(author.name),
					image: null,
				},
			} as Message,
		});

	const chooseLevel = (memberId: string, level: "all" | "mentions" | "nothing") =>
		as(memberId, (service) => service.updatePreferences(preferences({ level })));

	it("tells a member they were mentioned in a project, linking to the message", async () => {
		const chat = await projectChat();
		const posted = memberPosted(
			chat,
			members.ada,
			`@${handleFromName(members.bob.name)} can you look at the launch checklist?`,
		);

		await emit(posted);

		expect(sentTo(members.bob.id)).toEqual([
			{
				title: `${members.ada.name} mentioned you in Launch`,
				body: `@${handleFromName(members.bob.name)} can you look at the launch checklist?`,
				tag: `chat:${chat}`,
				path: `/${workspaceSlug}/projects/${projectSlug}/${chat}?message=${posted.message.id}`,
				chatId: chat,
			},
		]);
		// Not the author, nor somebody who was only in the project.
		expect(sentTo(members.ada.id)).toEqual([]);
		expect(sentTo(members.cy.id)).toEqual([]);
	});

	it.each(["@here the launch moved to Friday", "@channel the launch moved to Friday"])(
		"tells everyone in the project of a member's %s, but not the author or an outsider",
		async (text) => {
			const chat = await projectChat();

			await emit(memberPosted(chat, members.ada, text));

			expect(sentTo(members.bob.id)).toEqual([
				expect.objectContaining({
					title: `${members.ada.name} mentioned you in Launch`,
					body: text,
				}),
			]);
			expect(sentTo(members.cy.id)).toHaveLength(1);
			expect(sentTo(members.ada.id)).toEqual([]);
			expect(sentTo(members.outsider.id)).toEqual([]);
		},
	);

	it("tells nobody who has stopped reaching the chat by the time it is sent", async () => {
		const chat = await projectChat();
		await onDatabase((db) =>
			db
				.delete(projectMember)
				.where(
					and(eq(projectMember.projectId, projectId), eq(projectMember.memberId, members.bob.id)),
				),
		);

		await emit(
			memberPosted(
				chat,
				members.ada,
				`@${handleFromName(members.bob.name)} @${handleFromName(members.cy.name)} the launch moved`,
			),
		);

		expect(sentTo(members.cy.id)).toHaveLength(1);
		expect(sentTo(members.bob.id)).toEqual([]);
	});

	it("replays one committed notification while its live delivery is paused and another handler runs", async () => {
		const chat = await projectChat();
		const mention = `@${handleFromName(members.bob.name)}`;
		const nextMention = `@${handleFromName(members.cy.name)}`;
		const event = memberPosted(chat, members.ada, `${mention} look`);
		const next = memberPosted(chat, members.ada, `${nextMention} next`);
		const stream = memberStream(members.bob.id);
		const store = await runOnPostgres(EventStore.make);
		const freshBus = EventBus.inProcess({ store });
		const marker = () => streamEvent("approvals.changed", { toolCallId: crypto.randomUUID() });
		const commit = (event: ReturnType<typeof marker>) =>
			runOnPostgres(
				Effect.flatMap(EventOutbox.make, (outbox) => outbox.publish([{ stream, event }])).pipe(
					Effect.provideService(EventBus.Service, freshBus),
				),
			);
		await commit(marker());
		const since = await store.latest(stream);

		const publishing = Promise.withResolvers<void>();
		const unblock = Promise.withResolvers<void>();
		const sent: unknown[] = [];
		const bus = EventBus.inProcess({
			store,
			relay: {
				listen: async () => async () => {},
				broadcast: async (_stream, { event }) => {
					sent.push(event.body);
					if (sent.length === 1) {
						publishing.resolve();
						await unblock.promise;
					}
				},
			},
		});
		const service = await served(Layer.succeed(EventBus.Service, bus));
		const notifications = await service.run(Notifications.Service);
		const handle = (events: ChatEvent[]) => {
			const work = joiningWhatItStarts(transaction(notifications.handler(events)));
			return service.run(work.handled).then(() => work.allEnded);
		};
		const first = handle([event]);
		let second: Promise<void> | undefined;
		const close = async () => {
			unblock.resolve();
			await Promise.allSettled([first, second]);
			await Promise.all([service.close(), bus.close(), freshBus.close()]);
		};
		onTestFinished(close);
		try {
			await Promise.race([
				publishing.promise,
				first.then(() => {
					throw new Error("The first handler sent no notification");
				}),
			]);

			const sentinel = marker();
			await commit(sentinel);
			const replayed = [];
			for await (const delivery of freshBus.subscribe(stream, { since })) {
				if (delivery.event.toolCallId === sentinel.toolCallId) break;
				replayed.push(delivery);
			}
			expect(replayed).toEqual([
				{
					seq: expect.any(Number),
					event: expect.objectContaining({ type: "notification", body: `${mention} look` }),
				},
			]);

			second = handle([event, next]);
			await second;
			expect(sent).toEqual([`${mention} look`, `${nextMention} next`]);
		} finally {
			await close();
		}
	});

	it("records a notification sent once it is published, in a Postgres session of its own", async () => {
		const chat = await projectChat();
		let other: ReturnType<typeof holdTransaction> | undefined;
		const bus = busPublishing(async (stream, event) => {
			published.push({ stream, event });
			// Another transaction takes the Postgres session the recording one let go
			// of, and is rolled back.
			other = holdTransaction(Effect.void, Effect.die("rolled back"));
			await other.held;
		});
		const sending = await served(bus);
		try {
			const { handler } = await sending.run(Notifications.Service);
			const handled = joiningWhatItStarts(
				transaction(
					handler([memberPosted(chat, members.ada, `@${handleFromName(members.bob.name)} look`)]),
				),
			);
			await sending.run(handled.handled);
			await handled.allEnded;
		} finally {
			await sending.close();
		}
		await other?.release().catch(() => undefined);

		expect(sentTo(members.bob.id)).toHaveLength(1);
		expect(
			await onDatabase((db) =>
				db
					.select({ sentAt: notificationDelivery.sentAt })
					.from(notificationDelivery)
					.where(eq(notificationDelivery.chatId, chat)),
			),
		).toEqual([{ sentAt: expect.any(Date) }]);
	});

	describe("after the process sending them stops", () => {
		/** Makes everything left unsent look old enough for the sweep, as if its process stopped a while ago. */
		const aWhileLater = async () => {
			const before = new Date(Date.now() - 60_000);
			await onDatabase((db) => db.update(pendingNotification).set({ dueAt: before }));
			await onDatabase((db) =>
				db
					.update(notificationDelivery)
					.set({ createdAt: before, claimedUntil: before })
					.where(isNull(notificationDelivery.sentAt)),
			);
		};

		/** Records `events`' notifications without sending them, as a process that stopped before sending. */
		const recordedUnsent = async (...events: ChatEvent[]) => {
			const failing = await served(
				capturingBus,
				unimplemented(EventOutbox.Service, {
					publish: () => Effect.die(new Error("The process stopped")),
				}),
			);
			try {
				const { handler } = await failing.run(Notifications.Service);
				const handled = joiningWhatItStarts(transaction(handler(events)));
				await failing.run(handled.handled);
				await handled.allEnded;
			} finally {
				await failing.close();
			}
		};

		it("records each notification it sends again sent, and sends again one it failed to", async () => {
			const chat = await projectChat();
			const bob = `@${handleFromName(members.bob.name)}`;
			const cy = `@${handleFromName(members.cy.name)}`;
			const mention = `${bob} ${cy} look`;
			await recordedUnsent(memberPosted(chat, members.ada, mention));
			await aWhileLater();
			let sends = 0;
			const failingOnce = await served(
				capturingBus,
				Layer.effect(
					EventOutbox.Service,
					Effect.map(EventOutbox.make, (outbox) => ({
						publish: (pending) => {
							sends += 1;
							return sends === 1
								? Effect.die(new Error("Sending failed"))
								: outbox.publish(pending);
						},
					})),
				),
			);
			try {
				await failingOnce.run(Effect.flatMap(Notifications.Service, (n) => n.sendLeftBehind));
			} finally {
				await failingOnce.close();
			}
			const sentByTheFirstSweep = sentTo(members.bob.id).length + sentTo(members.cy.id).length;

			await aWhileLater();
			const { sendLeftBehind } = await notifications();
			await run(sendLeftBehind);
			await run(sendLeftBehind);

			expect(sentByTheFirstSweep).toBe(1);
			expect(sentTo(members.bob.id)).toEqual([expect.objectContaining({ body: mention })]);
			expect(sentTo(members.cy.id)).toEqual([expect.objectContaining({ body: mention })]);
		});

		it("sends again only to those who still reach the chat", async () => {
			const chat = await projectChat();
			await recordedUnsent(
				memberPosted(
					chat,
					members.ada,
					`@${handleFromName(members.bob.name)} @${handleFromName(members.cy.name)} look`,
				),
			);
			await onDatabase((db) =>
				db
					.delete(projectMember)
					.where(
						and(eq(projectMember.projectId, projectId), eq(projectMember.memberId, members.bob.id)),
					),
			);

			await aWhileLater();
			const { sendLeftBehind } = await notifications();
			await run(sendLeftBehind);

			expect(sentTo(members.cy.id)).toHaveLength(1);
			expect(sentTo(members.bob.id)).toEqual([]);
		});

		it.each([
			{
				change: "has lost the standing to decide it",
				set: { role: "viewer" as const },
			},
			{ change: "is leaving the workspace", set: { leaving: true } },
		])("sends an approval again to nobody who $change", async ({ set }) => {
			// Bob administers the workspace, so he may decide the personal bot's
			// computer request, though he doesn't reach its chat.
			await onDatabase((db) =>
				db.update(botTable).set({ visibility: "personal" }).where(eq(botTable.id, botId)),
			);
			await onDatabase((db) =>
				db.update(membership).set({ role: "admin" }).where(eq(membership.memberId, members.bob.id)),
			);
			const chat = await chatWithBot([members.ada.id]);
			const { turnId, callIds } = await turnWaitingOn(chat, [HOST_REQUEST_TOOL]);
			await recordedUnsent(
				ChatEvent.TurnSuspended({ chatId: chat, workspaceId, turnId, approvalCallIds: callIds }),
			);
			await onDatabase((db) =>
				db.update(membership).set(set).where(eq(membership.memberId, members.bob.id)),
			);

			await aWhileLater();
			const { sendLeftBehind } = await notifications();
			await run(sendLeftBehind);

			expect(sentTo(members.bob.id)).toEqual([]);
		});

		it.each<{ change: string; set: () => Partial<typeof toolCall.$inferInsert> }>([
			{ change: "decided", set: () => ({ approvalStatus: "allowed" }) },
			{
				change: "decided and asked about again",
				set: () => ({ approvalId: crypto.randomUUID(), approvalStatus: "pending" }),
			},
		])("sends an approval again to nobody once its call is $change", async ({ set }) => {
			// Only Ada, who made it, reaches a personal bot, so only she may decide its calls.
			await onDatabase((db) =>
				db.update(botTable).set({ visibility: "personal" }).where(eq(botTable.id, botId)),
			);
			const chat = await chatWithBot([members.ada.id]);
			const { turnId, callIds } = await turnWaitingOn(chat, ["post_message"]);
			await recordedUnsent(
				ChatEvent.TurnSuspended({ chatId: chat, workspaceId, turnId, approvalCallIds: callIds }),
			);
			const [callId] = callIds;
			if (!callId) throw new Error("No call");
			await onDatabase((db) => db.update(toolCall).set(set()).where(eq(toolCall.id, callId)));

			await aWhileLater();
			const { sendLeftBehind } = await notifications();
			await run(sendLeftBehind);

			expect(sentTo(members.ada.id)).toEqual([]);
		});

		it("lets only the current sweep send a delivery once its earlier claim expires", async () => {
			const chat = await projectChat();
			await onDatabase((db) =>
				db.insert(projectMember).values({
					workspaceId,
					projectId,
					memberId: members.outsider.id,
				}),
			);
			const recipients = [members.bob, members.cy, members.outsider];
			const mentions = recipients.map(({ name }) => `@${handleFromName(name)}`).join(" ");
			await recordedUnsent(memberPosted(chat, members.ada, `${mentions} look`));
			await aWhileLater();

			const startSweep = async () => {
				const sent: EventStream[] = [];
				const publishing = Promise.withResolvers<void>();
				const resume = Promise.withResolvers<void>();
				onTestFinished(() => resume.resolve());
				const service = await served(
					busPublishing(async (stream) => {
						sent.push(stream);
						if (sent.length === 1) {
							publishing.resolve();
							await resume.promise;
						}
					}),
				);
				const finished = service.run(
					Effect.flatMap(Notifications.Service, (n) => n.sendLeftBehind),
				);
				return {
					sent,
					finished,
					publishing: Promise.race([
						publishing.promise,
						finished.then(() => {
							throw new Error("The sweep sent no notification");
						}),
					]),
					resume: resume.resolve,
					close: service.close,
				};
			};

			const first = await startSweep();
			let second: Awaited<ReturnType<typeof startSweep>> | undefined;
			try {
				await first.publishing;
				await aWhileLater();
				second = await startSweep();
				await second.publishing;

				first.resume();
				await first.finished;
				expect(first.sent).toHaveLength(1);

				second.resume();
				await second.finished;
				expect(second.sent).toHaveLength(2);
				expect([...first.sent, ...second.sent].sort()).toEqual(
					recipients.map(({ id }) => memberStream(id)).sort(),
				);
			} finally {
				first.resume();
				second?.resume();
				await Promise.allSettled([first.finished, second?.finished]);
				await Promise.all([first.close(), second?.close()]);
			}
		});

		it("sends an event's notifications it stopped before working out", async () => {
			const chat = await projectChat();
			const mention = `@${handleFromName(members.bob.name)} look`;
			const stopped = await served();
			const { handler } = await stopped.run(Notifications.Service);
			// Recording whom to tell waits for another transaction that locks the deliveries' table.
			const lockingDeliveries = holdTransaction(
				query((db) => db.execute(sql`lock table ${notificationDelivery} in exclusive mode`)),
			);
			await lockingDeliveries.held;
			await stopped.run(transaction(handler([memberPosted(chat, members.ada, mention)])));
			await waitUntilWaitingOnLocks(1);
			const stopping = stopped.close();
			await lockingDeliveries.release();
			await stopping;
			const sentBeforeStopping = sentTo(members.bob.id).length;

			await aWhileLater();
			const { sendLeftBehind } = await notifications();
			await run(sendLeftBehind);

			expect(sentBeforeStopping).toBe(0);
			expect(sentTo(members.bob.id)).toEqual([expect.objectContaining({ body: mention })]);
		});
	});

	it("does not let a bot reach everyone with @channel", async () => {
		const chat = await chatWithBot([members.ada.id]);
		await chooseLevel(members.ada.id, "all");

		await emit(await botReplied(chat, "@channel I am done."));

		expect(sentTo(members.ada.id)).toEqual([
			expect.objectContaining({ title: "Scout in Release notes" }),
		]);
		expect(sentTo(members.bob.id)).toEqual([]);
	});

	it("tells a member of a reply to their message in a project, and names a file shared without text", async () => {
		const chat = await projectChat();
		const asked = memberPosted(chat, members.bob, "Who has the launch checklist?");

		await emit(
			memberPosted(chat, members.ada, "", {
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

		expect(sentTo(members.bob.id)).toEqual([
			expect.objectContaining({
				title: `${members.ada.name} in Launch`,
				body: "Shared checklist.pdf",
			}),
		]);
	});

	it("names the files an automation's result shares without text in a project", async () => {
		const chat = await projectChat();
		await chooseLevel(members.bob.id, "all");
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

		// Each result is notified in its own time, so they may arrive in either order.
		const delivered = sentTo(members.bob.id);
		expect(delivered).toHaveLength(2);
		expect(delivered).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ body: "Shared Weekly traction" }),
				expect.objectContaining({ body: "Shared 2 files" }),
			]),
		);
	});

	it("tells the members in a bot's chat of the bot's reply, linking to the chat, and those who chose everything", async () => {
		const chat = await chatWithBot([members.ada.id]);
		await chooseLevel(members.cy.id, "all");

		const reply = await botReplied(chat, "The release notes are drafted.", members.ada);
		await emit(reply);

		expect(sentTo(members.ada.id)).toEqual([
			{
				title: "Scout in Release notes",
				body: "The release notes are drafted.",
				tag: `chat:${chat}`,
				path: `/${workspaceSlug}/chats/${chat}?message=${reply.messageId}`,
				chatId: chat,
			},
		]);
		expect(sentTo(members.cy.id)).toHaveLength(1);
		expect(sentTo(members.bob.id)).toEqual([]);
		expect(sentTo(members.outsider.id)).toEqual([]);
	});

	it("tells the members taking part in a project's chat of a bot's reply there, as in a bot's chat", async () => {
		const chat = await projectChat();
		await onDatabase((db) =>
			db.insert(chatParticipant).values({ chatId: chat, memberId: members.ada.id }),
		);

		await emit(await botReplied(chat, "The checklist is done."));

		expect(sentTo(members.ada.id)).toEqual([
			expect.objectContaining({ title: "Scout in Launch", body: "The checklist is done." }),
		]);
		expect(sentTo(members.bob.id)).toEqual([]);
	});

	it("leaves out somebody who muted the bot or paused", async () => {
		const chat = await chatWithBot([members.ada.id, members.bob.id, members.cy.id]);
		await as(members.bob.id, (service) => service.setLevel({ kind: "bot", id: botId }, "nothing"));
		await as(members.cy.id, (service) =>
			service.updatePreferences(
				preferences({ pausedUntil: new Date(Date.now() + 60_000).toISOString() }),
			),
		);

		await emit(await botReplied(chat, "Done."));

		expect(sentTo(members.ada.id)).toHaveLength(1);
		expect(sentTo(members.bob.id)).toEqual([]);
		expect(sentTo(members.cy.id)).toEqual([]);
	});

	it("leaves out somebody in their quiet hours, which may span midnight", async () => {
		const chat = await chatWithBot([members.ada.id, members.cy.id]);
		// Twenty-two hours that end an hour from now, so they hold now
		// whichever side of midnight they start and end.
		const now = new Date();
		const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
		await as(members.cy.id, (service) =>
			service.updatePreferences(
				preferences({
					quietHours: {
						from: clockTime(minutes + 120),
						to: clockTime(minutes + 60),
						timeZone: "UTC",
					},
				}),
			),
		);

		await emit(await botReplied(chat, "Done."));

		expect(sentTo(members.ada.id)).toHaveLength(1);
		expect(sentTo(members.cy.id)).toEqual([]);
	});

	it("passes what one of a member's tabs is looking at to their other tabs, and nobody else", async () => {
		const looking = {
			clientId: crypto.randomUUID(),
			chatId: crypto.randomUUID(),
			sequence: 1,
		};

		await as(members.ada.id, (service) => service.reportPresence(looking));

		expect(published.filter(({ event }) => event.type === "presence")).toEqual([
			{
				stream: memberStream(members.ada.id),
				event: expect.objectContaining({ type: "presence", ...looking }),
			},
		]);
	});

	it("lets a project's level quiet its bots, and a bot's level win over it", async () => {
		const chat = await projectChat();
		for (const member of [members.ada, members.bob]) {
			await as(member.id, (service) =>
				service.setLevel({ kind: "project", id: projectId }, "nothing"),
			);
		}
		await as(members.bob.id, (service) => service.setLevel({ kind: "bot", id: botId }, "all"));

		await emit(await botReplied(chat, "Shipped."));

		expect(sentTo(members.bob.id)).toHaveLength(1);
		expect(sentTo(members.ada.id)).toEqual([]);
	});

	it("quiets a muted bot's replies in a project, and not what members post there", async () => {
		const chat = await projectChat();
		await chooseLevel(members.bob.id, "all");
		await as(members.bob.id, (service) => service.setLevel({ kind: "bot", id: botId }, "nothing"));

		await emit(await botReplied(chat, "Here is the checklist."));
		await emit(memberPosted(chat, members.ada, "Thanks, Scout."));

		expect(sentTo(members.bob.id)).toEqual([
			expect.objectContaining({ title: `${members.ada.name} in Launch` }),
		]);
	});

	it("quiets a bot muted for a while until the mute ends, then keeps its level", async () => {
		const chat = await chatWithBot([members.ada.id, members.bob.id]);
		const muteUntil = (member: { id: string }, until: Date) =>
			as(member.id, (service) => service.mute({ kind: "bot", id: botId }, until));
		await as(members.bob.id, (service) => service.setLevel({ kind: "bot", id: botId }, "all"));
		await muteUntil(members.ada, new Date(Date.now() + 60_000));
		await muteUntil(members.bob, new Date(Date.now() - 60_000));

		await emit(await botReplied(chat, "Shipped."));

		expect(sentTo(members.bob.id)).toHaveLength(1);
		expect(sentTo(members.ada.id)).toEqual([]);
		const settings = await as(members.bob.id, (service) => service.settings);
		expect(settings.bots).toEqual({ [botId]: "all" });
		expect(settings.mutedUntil.bots).toEqual({});
	});

	it("quiets every bot in a project muted for a while, even one with a level of its own", async () => {
		const chat = await projectChat();
		for (const member of [members.ada, members.bob]) {
			await as(member.id, (service) => service.setLevel({ kind: "bot", id: botId }, "all"));
		}
		await as(members.bob.id, (service) =>
			service.mute({ kind: "project", id: projectId }, new Date(Date.now() + 60_000)),
		);

		await emit(await botReplied(chat, "Shipped."));

		expect(sentTo(members.ada.id)).toHaveLength(1);
		expect(sentTo(members.bob.id)).toEqual([]);
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
		const feed = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "automation_feed",
				automationId: defined.id,
				title: defined.name,
			}),
		);
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
						requestedByMemberId: members.ada.id,
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
		return { chatId: run.id, rootChatId: feed.id, automationId: defined.id };
	};

	const runSettled = ({ chatId, rootChatId }: { chatId: string; rootChatId: string }) =>
		ChatEvent.RunSettled({ workspaceId, chatId, rootChatId });

	it.each(["bot", "project"] as const)(
		"links a failed %s run to its feed for the members who made and ran it",
		async (owner) => {
			const inProjectId = owner === "project" ? projectId : undefined;
			const failedRun = await automationRunElsewhere(
				{ state: "failed", error: userText`The calendar could not be read.` },
				members.bob.id,
				"Digest",
				inProjectId,
			);
			const finishedRun = await automationRunElsewhere(
				{ state: "completed" },
				members.bob.id,
				"Briefing",
				inProjectId,
			);

			await emit(runSettled(failedRun), runSettled(finishedRun));

			const { chatId: runChat, rootChatId: feed } = failedRun;
			const failure = {
				title: "Digest failed",
				body: "The calendar could not be read.",
				tag: `automation:${runChat}`,
				path:
					owner === "project"
						? `/${workspaceSlug}/projects/${projectSlug}/${feed}?runChat=${runChat}`
						: `/${workspaceSlug}/chats/${feed}?runChat=${runChat}`,
				chatId: feed,
			};
			expect(sentTo(members.bob.id)).toEqual([failure]);
			expect(sentTo(members.ada.id)).toEqual([failure]);
			expect(sentTo(members.cy.id)).toEqual([]);
		},
	);

	it("tells somebody of every run of their automation when they chose to", async () => {
		const run = await automationRunElsewhere({ state: "completed" }, members.bob.id);
		await as(members.bob.id, (service) =>
			service.updatePreferences(preferences({ automationRuns: "all" })),
		);

		await emit(runSettled(run));

		expect(sentTo(members.bob.id)).toEqual([
			expect.objectContaining({ title: "Digest finished", body: "Scout finished the run." }),
		]);
		expect(sentTo(members.ada.id)).toEqual([]);
	});

	it("tells those an automation's result mentions in its automation's feed", async () => {
		const {
			chatId: runChat,
			rootChatId: feed,
			automationId,
		} = await automationRunElsewhere({ state: "completed" }, members.bob.id);
		const [run] = await onDatabase((db) =>
			db
				.select({ id: automationRun.id, automationId: automationRun.automationId })
				.from(automationRun)
				.where(eq(automationRun.chatId, runChat)),
		);
		if (!run) throw new Error("fixture");
		await chooseLevel(members.cy.id, "all");
		const content = `@${handleFromName(members.ada.name)} the calendar needs reconnecting.`;
		const resultPosted = async (chatId: string) => {
			const id = crypto.randomUUID();
			await onDatabase((db) =>
				db.insert(message).values({
					id,
					chatId,
					authorBotId: botId,
					runId: run.id,
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
						automationId,
						automationName: "Digest",
					},
				} as Message,
			});
		};

		const inFeed = await resultPosted(feed);
		await emit(inFeed);

		expect(sentTo(members.ada.id)).toEqual([
			{
				title: "Scout mentioned you in Digest",
				body: content,
				tag: chatNotificationTag(feed),
				path: `/${workspaceSlug}/chats/${feed}?runChat=${runChat}`,
				chatId: feed,
			},
		]);
		// Everything is what is said in chats; an automation's feed speaks up only for those it mentions.
		expect(sentTo(members.cy.id)).toEqual([]);
	});

	it("tells the member a bot was answering that its reply failed, unless they turned that off", async () => {
		const chat = await chatWithBot([members.ada.id, members.bob.id]);
		const failedTurn = async (asker: { id: string }) => {
			const asked = crypto.randomUUID();
			await onDatabase((db) =>
				db.insert(message).values({
					id: asked,
					chatId: chat,
					authorMemberId: asker.id,
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
					error: userText`The model could not be reached.`,
					model: "test/model",
					startedAt: new Date(),
					...askerColumns({ chatId: chat, botId: botId, triggerMessageId: asked }),
				}),
			);
			return ChatEvent.TurnFailed({
				chatId: chat,
				workspaceId,
				turnId,
				botId: botId,
				messageId: crypto.randomUUID(),
				execution: 1,
				userMessage: userText`The model is unavailable.`,
				willRetry: false,
			});
		};
		await as(members.bob.id, (service) =>
			service.updatePreferences(preferences({ turnFailures: false })),
		);

		await emit(await failedTurn(members.ada), await failedTurn(members.bob));

		expect(sentTo(members.ada.id)).toEqual([
			expect.objectContaining({
				title: "Scout couldn't finish its reply",
				body: "The model is unavailable.",
			}),
		]);
		expect(sentTo(members.bob.id)).toEqual([]);
	});

	/**
	 * A turn of the bot, asked by Ada in `chat`, waiting for approval
	 * of a call to each of `tools`, raised in that order.
	 */
	/**
	 * A turn in `chat` waiting on calls to `tools`, answering a message by
	 * `askedBy`: a member, Ada unless said, or the trigger of the run `run`.
	 */
	const turnWaitingOn = async (
		chat: string,
		tools: readonly string[],
		askedBy: { member: string } | { run: string } = { member: members.ada.id },
	) => {
		const triggerId = crypto.randomUUID();
		const replyId = crypto.randomUUID();
		const turnId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values({
				id: triggerId,
				chatId: chat,
				...("member" in askedBy
					? { authorMemberId: askedBy.member }
					: {
							automationTrigger: {
								kind: "automation_trigger" as const,
								runId: askedBy.run,
								automationName: "Digest",
								triggerKind: "manual" as const,
							},
						}),
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
				...askerColumns({ chatId: chat, botId: botId, triggerMessageId: triggerId }),
			}),
		);
		await onDatabase((db) =>
			db.insert(message).values({
				id: replyId,
				chatId: chat,
				authorBotId: botId,
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
					approvalComputerProjectId: tool === HOST_REQUEST_TOOL ? projectId : null,
					approvalId: crypto.randomUUID(),
					approvalStatus: "pending" as const,
					input: {},
					atOffset: index,
					startedAt: new Date(startedAt + index),
				})),
			),
		);
		return { turnId, callIds };
	};

	it("asks the members who may decide a bot's tool call to approve it", async () => {
		// Only Ada, who made it, reaches a personal bot, so only she may decide its calls.
		await onDatabase((db) =>
			db.update(botTable).set({ visibility: "personal" }).where(eq(botTable.id, botId)),
		);
		// An automation run elsewhere must not make this call one raised during a run.
		await automationRunElsewhere();
		const chat = await chatWithBot([members.ada.id]);
		const { turnId, callIds } = await turnWaitingOn(chat, ["post_message"]);
		const [callId] = callIds;

		await emit(
			ChatEvent.TurnSuspended({ chatId: chat, workspaceId, turnId, approvalCallIds: callIds }),
		);

		expect(sentTo(members.ada.id)).toEqual([
			{
				title: "Scout needs your approval",
				body: "To run post_message in Release notes",
				tag: `approval:${turnId}`,
				path: `/${workspaceSlug}/approvals/${callId}`,
				chatId: chat,
			},
		]);
		expect(sentTo(members.bob.id)).toEqual([]);
		expect(sentTo(members.outsider.id)).toEqual([]);
	});

	it("links each member to the approvals they may decide: a computer request to its project's managers, any other call to its asker", async () => {
		// Ada administers the workspace, so she manages the project's computer; Bob, who asked, is only an editor.
		await onDatabase((db) =>
			db.update(membership).set({ role: "admin" }).where(eq(membership.memberId, members.ada.id)),
		);
		const chat = await projectChat();
		const { turnId, callIds } = await turnWaitingOn(chat, [HOST_REQUEST_TOOL, "post_message"], {
			member: members.bob.id,
		});
		const [networkCallId, postCallId] = callIds;

		await emit(
			ChatEvent.TurnSuspended({ chatId: chat, workspaceId, turnId, approvalCallIds: callIds }),
		);

		expect(sentTo(members.ada.id)).toEqual([
			{
				title: "Scout needs your approval",
				body: `To run ${HOST_REQUEST_TOOL} in Launch`,
				tag: `approval:${turnId}`,
				path: `/${workspaceSlug}/approvals/${networkCallId}`,
				chatId: chat,
			},
		]);
		expect(sentTo(members.bob.id)).toEqual([
			{
				title: "Scout needs your approval",
				body: "To run post_message in Launch",
				tag: `approval:${turnId}`,
				path: `/${workspaceSlug}/approvals/${postCallId}`,
				chatId: chat,
			},
		]);
	});

	it("notifies the bound computer project’s manager without disclosing the private chat", async () => {
		await onDatabase((db) =>
			db.update(botTable).set({ visibility: "personal" }).where(eq(botTable.id, botId)),
		);
		await onDatabase((db) =>
			db.update(membership).set({ role: "admin" }).where(eq(membership.memberId, members.bob.id)),
		);
		const chat = await chatWithBot([members.ada.id]);
		const { turnId, callIds } = await turnWaitingOn(chat, [HOST_REQUEST_TOOL]);
		const [callId] = callIds;
		if (!callId) throw new Error("No host request");
		await onDatabase((db) =>
			db
				.update(toolCall)
				.set({
					executionInput: { host: "docs.example", explanation: "private model text" },
				})
				.where(eq(toolCall.id, callId)),
		);

		await emit(
			ChatEvent.TurnSuspended({ chatId: chat, workspaceId, turnId, approvalCallIds: callIds }),
		);

		expect(sentTo(members.bob.id)).toEqual([
			{
				title: "Scout needs your approval",
				body: "To let its computer reach docs.example",
				tag: `approval:${turnId}`,
				path: `/${workspaceSlug}/approvals/${callId}`,
				chatId: null,
			},
		]);
	});

	it("asks the lead bot's creator and admins to approve what a project's run asks, and no other editor", async () => {
		// Scout, which Ada made, leads the project; Cy administers the workspace; Bob is only an editor.
		await onDatabase((db) =>
			db.update(project).set({ leadBotId: botId }).where(eq(project.id, projectId)),
		);
		await onDatabase((db) =>
			db.update(membership).set({ role: "admin" }).where(eq(membership.memberId, members.cy.id)),
		);
		const { chatId: runChat } = await automationRunElsewhere(
			undefined,
			members.bob.id,
			"Digest",
			projectId,
		);
		const [run] = await onDatabase((db) =>
			db
				.select({ id: automationRun.id })
				.from(automationRun)
				.where(eq(automationRun.chatId, runChat)),
		);
		if (!run) throw new Error("The run has no row");
		// The run's turn answers its trigger, so it asks for no member.
		const { turnId, callIds } = await turnWaitingOn(runChat, ["post_message"], { run: run.id });
		const [callId] = callIds;

		await emit(
			ChatEvent.TurnSuspended({ chatId: runChat, workspaceId, turnId, approvalCallIds: callIds }),
		);

		const asked = {
			title: "Scout needs your approval",
			body: "To run post_message in Digest",
			tag: `approval:${turnId}`,
			path: `/${workspaceSlug}/approvals/${callId}`,
			chatId: expect.any(String),
		};
		expect(sentTo(members.ada.id)).toEqual([asked]);
		expect(sentTo(members.cy.id)).toEqual([asked]);
		expect(sentTo(members.bob.id)).toEqual([]);
	});
});

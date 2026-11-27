import { randomUUID } from "node:crypto";
import {
	chatStream,
	type DurableEventType,
	type EventStream,
	memberStream,
	type StreamEvent,
	streamEvent,
	workspaceStream,
} from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { Delivery } from "@sugabots/contracts/operations/events";
import { and, eq, gt, sql } from "drizzle-orm";
import {
	Clock,
	ConfigProvider,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	ManagedRuntime,
	Queue,
	Scope,
	Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import {
	addMembership,
	seedBot,
	seedComputer,
	seedMember,
	seedProject,
	seedProjectChat,
	seedWorkspace,
} from "../authentication/seed.test-support.ts";
import { chatServicesForTests } from "../chats/testing.ts";
import { runningTurns } from "../chats/turns/testing.ts";
import { Database, effectRunner, query, transaction } from "../database/database.ts";
import { Audience } from "../database/events/audience.ts";
import { EventBus } from "../database/events/bus.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { EventStore } from "../database/events/store.ts";
import { bot, event, projectMember, session } from "../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	runOnPostgres,
	testInfrastructure,
} from "../database/testing.ts";
import type { Operations } from "../operations/registry.ts";
import {
	type CallOperation,
	type Following,
	type FollowOperation,
	servedRegistry,
} from "../operations/testing.ts";
import type { MemberSession } from "../principal.ts";
import { authenticators, principals } from "../proofs/world.test-support.ts";
import { Streams } from "./streams.ts";

async function observeWatcherSleeps(clock: Clock.Clock, catchUp: Duration.Input) {
	const checkInterval = Duration.toMillis(catchUp) / 2;
	const sleeps = await Effect.runPromise(Queue.unbounded<void>());
	return {
		clock: {
			...clock,
			sleep: (duration) =>
				Duration.toMillis(duration) === checkInterval
					? Effect.forkChild(clock.sleep(duration), { startImmediately: true }).pipe(
							Effect.tap(() => Queue.offer(sleeps, undefined)),
							Effect.flatMap(Fiber.join),
						)
					: clock.sleep(duration),
		} satisfies Clock.Clock,
		clear: () => Effect.runPromise(Queue.clear(sleeps)),
		// Session expiry and reach catch-up each schedule a sleep when the watcher starts.
		waitForInitialSleeps: () =>
			Effect.runPromise(
				Queue.take(sleeps).pipe(
					Effect.tap(() => Queue.take(sleeps)),
					Effect.timeoutOrElse({
						duration: "4 seconds",
						orElse: () =>
							Effect.die(new Error("Timed out waiting for the stream watcher's first two sleeps")),
					}),
				),
			),
	};
}

/**
 * Following streams, the registry's long-running kind of operation, against
 * Postgres: each proves what its member reaches when it starts, sends an event
 * only to those its last proof says may hear it, proves again on each change
 * of who reaches what that operations record, and ends once what it follows
 * is hidden from its member, or their session ends or expires.
 */
describe.skipIf(!process.env.DATABASE_URL)("following streams, which prove again", () => {
	/** How many subscriptions to each stream the bus holds. */
	const subscribed = new Map<EventStream, number>();
	/** What waits for a stream's last subscription to end. */
	const awaitingNone = new Map<EventStream, Array<() => void>>();
	const inProcess = EventBus.inProcess();
	const bus: EventBus.Interface = {
		...inProcess,
		async *subscribe(stream, options) {
			subscribed.set(stream, (subscribed.get(stream) ?? 0) + 1);
			try {
				yield* inProcess.subscribe(stream, options);
			} finally {
				const left = (subscribed.get(stream) ?? 0) - 1;
				subscribed.set(stream, left);
				if (left === 0) for (const wake of awaitingNone.get(stream) ?? []) wake();
			}
		},
	};
	/** Resolves once the bus holds no subscription to `stream`. */
	const noneSubscribed = (stream: EventStream) =>
		new Promise<void>((resolve) => {
			if ((subscribed.get(stream) ?? 0) === 0) return resolve();
			awaitingNone.set(stream, [...(awaitingNone.get(stream) ?? []), resolve]);
		});
	let call: CallOperation;
	let follow: FollowOperation;
	let longRunning: Operations.LongRunningInterface;
	const clockScope = Scope.makeUnsafe();
	let clock: TestClock.TestClock;
	let watcherSleeps: Awaited<ReturnType<typeof observeWatcherSleeps>>;
	let followOnTestClock: FollowOperation;
	const catchUp = "1 second";
	let signedIn: ReturnType<typeof principals>;
	let outbox: EventOutbox.Interface;
	/** An outbox whose deliveries reach no bus this process listens to, as another's can fail to. */
	let unheard: EventOutbox.Interface;
	let stored: EventStore.Interface;

	beforeAll(async () => {
		const chats = await chatServicesForTests(bus);
		({ call, follow, longRunning } = await servedRegistry({
			chats,
			bus: Layer.succeed(EventBus.Service, bus),
			streamsTiming: { catchUp },
		}));
		clock = await Effect.runPromise(Scope.provide(TestClock.make(), clockScope));
		await Effect.runPromise(clock.setTime(Date.UTC(2000, 0, 1)));
		watcherSleeps = await observeWatcherSleeps(clock, catchUp);
		({ follow: followOnTestClock } = await servedRegistry({
			chats,
			bus: Layer.succeed(EventBus.Service, bus),
			streamsTiming: { catchUp },
			clock: watcherSleeps.clock,
		}));
		signedIn = principals(await authenticators());
		const outboxOver = (over: EventBus.Interface) =>
			runOnPostgres(
				Effect.provide(
					EventOutbox.Service,
					EventOutbox.layer.pipe(Layer.provide(Layer.succeed(EventBus.Service, over))),
				),
			);
		outbox = await outboxOver(bus);
		unheard = await outboxOver(EventBus.inProcess());
		stored = await runOnPostgres(EventStore.make);
	});

	afterAll(async () => {
		await Effect.runPromise(Scope.close(clockScope, Exit.void));
		await closeDatabase();
	});

	/**
	 * Starts following, closed when the case finishes, past the `ready` a
	 * stream that resumes from nowhere starts with.
	 */
	const pastReady =
		(start: FollowOperation): FollowOperation =>
		async (principal, name, input) => {
			const started = await start(principal, name, input);
			onTestFinished(() => started.close());
			if ("since" in input && input.since !== undefined) return started;
			const first = await started.next();
			if (first !== "ended" && (first as Delivery).event.type === "ready") return started;
			let held: typeof first | undefined = first;
			const takeHeld = () => {
				const taken = held;
				held = undefined;
				return taken;
			};
			return {
				...started,
				next: async (within) => takeHeld() ?? started.next(within),
				quiet: async (within) => takeHeld() ?? started.quiet(within),
			};
		};
	const following: FollowOperation = (...args) => pastReady(follow)(...args);
	const followingOnTestClock: FollowOperation = async (...args) => {
		await watcherSleeps.clear();
		return pastReady(followOnTestClock)(...args);
	};

	/** Stores `event` on `stream` and delivers it, as the outbox does once its transaction commits. */
	const commit = (stream: EventStream, event: StreamEvent & { type: DurableEventType }) =>
		runOnPostgres(transaction(outbox.publish([{ stream, event }])));

	/** Stores `event` on `stream`, but its delivery never reaches this process's bus. */
	const commitUnheard = (stream: EventStream, event: StreamEvent & { type: DurableEventType }) =>
		runOnPostgres(transaction(unheard.publish([{ stream, event }])));

	/** The type of the next event `stream` sends, or `ended`. */
	const nextType = async (stream: Following<Delivery>) => {
		const next = await stream.next();
		return next === "ended" ? next : next.event.type;
	};

	/**
	 * A workspace of its own: an owner, an admin, editors Ed and Erin and the
	 * viewer Vi. The public bot Pub leads the private project J, which Ed and
	 * Vi are in and Erin isn't, with a chat in it; Ed also made the personal
	 * bot Mine and the public bot Spare, which leads nothing, with a chat of
	 * Erin's.
	 */
	const staffed = async () => {
		const workspace = await seedWorkspace();
		const owner = await seedMember(workspace, "owner");
		const admin = await seedMember(workspace, "admin");
		const ed = await seedMember(workspace, "editor");
		const erin = await seedMember(workspace, "editor");
		const vi = await seedMember(workspace, "viewer");
		const pub = await seedBot(workspace, { createdById: ed });
		const mine = await seedBot(workspace, { createdById: ed, visibility: "personal" });
		const spare = await seedBot(workspace, { createdById: ed });
		const project = await seedProject(workspace, { leadBotId: pub.id, members: [ed, vi] });
		const chat = await seedProjectChat(workspace, project, ed);
		const spareChat = await seedProjectChat(workspace, spare.defaultProject, erin);
		return { workspace, owner, admin, ed, erin, vi, pub, mine, spare, project, chat, spareChat };
	};

	/** `memberId`'s membership of the workspace, which the workspace operations name. */
	const membershipOf = async (workspace: string, memberId: string, as: MemberSession) => {
		const memberships = await call(as, "workspaces.memberships", { workspace });
		const found = memberships.find((membership) => membership.member.id === memberId);
		if (!found) throw new Error("No such membership");
		return found.id;
	};

	/** Takes Ed out of J, as a removal does, without telling anybody. */
	const takeEdOut = (world: Awaited<ReturnType<typeof staffed>>) =>
		onDatabase((db) =>
			db
				.delete(projectMember)
				.where(
					and(eq(projectMember.projectId, world.project), eq(projectMember.memberId, world.ed)),
				),
		);
	const jChanged = (world: Awaited<ReturnType<typeof staffed>>) =>
		Audience.forProject(
			world.project,
			streamEvent("reach.changed", { about: { kind: "project", projectId: world.project } }),
		);

	it("starts a stream that resumes from nowhere with ready, before what changes after it", async () => {
		const world = await staffed();
		const chat = await follow(await signedIn.member(world.ed), "events.followChat", {
			chatId: world.chat,
		});
		onTestFinished(() => chat.close());

		expect(await chat.next()).toEqual({
			seq: (await stored.latest([chatStream(world.chat)])).get(chatStream(world.chat)),
			event: streamEvent("ready"),
		});
		const changed = streamEvent("chat.changed", { chatId: world.chat });
		await commit(chatStream(world.chat), changed);
		const next = await chat.next();
		expect(next !== "ended" && next.event).toEqual(changed);
	});

	it("resumes from ready when the event table was empty", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		await stored.prune(new Date(Date.now() + 60_000));
		const first = await follow(ed, "events.followChat", { chatId: world.chat });
		const ready = await first.next();
		await first.close();
		const changed = streamEvent("chat.changed", { chatId: world.chat });
		await commit(chatStream(world.chat), changed);

		const since = ready === "ended" ? undefined : ready.seq;
		const resumed = await follow(ed, "events.followChat", { chatId: world.chat, since });
		onTestFinished(() => resumed.close());

		expect(since).toBeDefined();
		const next = await resumed.next();
		expect(next !== "ended" && next.event).toEqual(changed);
	});

	it("resets a stream that started empty once what was stored on it while away is pruned", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		await commit(workspaceStream(world.workspace), jChanged(world));
		const first = await follow(ed, "events.followChat", { chatId: world.chat });
		const ready = await first.next();
		await first.close();
		await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));
		await stored.prune(new Date(Date.now() + 60_000));

		const since = ready === "ended" ? undefined : ready.seq;
		const resumed = await follow(ed, "events.followChat", { chatId: world.chat, since });
		onTestFinished(() => resumed.close());

		const next = await resumed.next();
		expect(next !== "ended" && next.event).toEqual(streamEvent("reset"));
	});

	const holdStreamWriter = (stream: EventStream) =>
		holdTransaction(
			query((db) =>
				db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${stream}, 0))`, "objects"),
			),
		);

	const observeStartupSnapshot = async (requested: () => void) =>
		(
			await servedRegistry({
				bus: Layer.succeed(EventBus.Service, bus),
				eventStore: {
					...stored,
					latest(streams, signal) {
						requested();
						return stored.latest(streams, signal);
					},
				},
			})
		).follow;

	it("resets when the first missed event is pruned during startup", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		const stream = chatStream(world.chat);
		const since = (await stored.latest([stream])).get(stream);
		if (since === undefined) throw new Error("The stream has no cursor");
		await commit(stream, streamEvent("chat.changed", { chatId: world.chat }));
		const writer = holdStreamWriter(stream);
		await writer.held;

		const requestedSnapshot = Promise.withResolvers<void>();
		const followDuringStartup = await observeStartupSnapshot(() => requestedSnapshot.resolve());
		const starting = followDuringStartup(ed, "events.followChat", { chatId: world.chat, since });
		await requestedSnapshot.promise;
		await stored.prune(new Date(Date.now() + 60_000));
		await writer.release();
		const resumed = await starting;
		onTestFinished(() => resumed.close());

		expect(await nextType(resumed)).toBe("reset");
	});

	it("resets when a later sequence is pruned but the cursor survives", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		const stream = chatStream(world.chat);
		const changed = streamEvent("chat.changed", { chatId: world.chat });
		await commit(stream, changed);
		const since = (await stored.latest([stream])).get(stream);
		if (since === undefined) throw new Error("The stream has no cursor");
		await commit(stream, changed);
		await onDatabase((db) =>
			db
				.update(event)
				.set({ createdAt: new Date(0) })
				.where(and(eq(event.stream, stream), gt(event.seq, EventStore.afterCursor(since)))),
		);
		await stored.prune(new Date(1));
		const resumed = await follow(ed, "events.followChat", { chatId: world.chat, since });
		onTestFinished(() => resumed.close());

		const reset = await resumed.next();
		if (reset === "ended") throw new Error("The stream ended before reset");
		expect(reset.event.type).toBe("reset");
		expect(reset.seq).toBeDefined();
		await resumed.close();
		await commit(stream, changed);
		const reconnected = await follow(ed, "events.followChat", {
			chatId: world.chat,
			since: reset.seq,
		});
		onTestFinished(() => reconnected.close());
		expect(await nextType(reconnected)).toBe("chat.changed");
	});

	it("refuses a stream the member cannot reach before requesting cursors", async () => {
		const world = await staffed();
		await takeEdOut(world);
		let snapshots = 0;
		const followWithSnapshot = await observeStartupSnapshot(() => {
			snapshots += 1;
		});
		const principal = await signedIn.member(world.ed);
		await expect(
			followWithSnapshot(principal, "events.followChat", { chatId: world.chat }),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
		expect(snapshots).toBe(0);
	});

	it("ends a reconnect while the writer still holds the stream lock", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		const stream = chatStream(world.chat);
		const since = (await stored.latest([stream])).get(stream);
		const writer = holdStreamWriter(stream);
		try {
			await writer.held;
			const outcome = await Promise.race([
				follow(ed, "events.followChat", { chatId: world.chat, since }).then(async (opened) => {
					try {
						return await opened.next();
					} finally {
						await opened.close();
					}
				}),
				new Promise((resolve) => {
					const timer = setTimeout(() => resolve("still waiting"), 3_000);
					onTestFinished(() => clearTimeout(timer));
				}),
			]);
			expect(outcome).toBe("ended");
		} finally {
			await writer.release();
		}
	});

	it("leaves the only pool slot available while stream startup waits for a writer", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		const settings = ConfigProvider.fromEnv({ env: { ...process.env, DATABASE_POOL_SIZE: "1" } });
		const runtime = ManagedRuntime.make(
			testInfrastructure.pipe(Layer.provide(ConfigProvider.layer(settings))),
		);
		const runOn = effectRunner(runtime);
		const writer = holdStreamWriter(chatStream(world.chat));
		const abort = new AbortController();
		try {
			await writer.held;
			const transactionStarted = Promise.withResolvers<void>();
			const eventStore = await runOn(
				Effect.flatMap(Database, (database) =>
					EventStore.make.pipe(
						Effect.provideService(Database, {
							...database,
							transaction: (use) =>
								database.transaction(
									Effect.sync(() => transactionStarted.resolve()).pipe(Effect.andThen(use)),
								),
						}),
					),
				),
			);
			const { longRunning: isolated } = await servedRegistry({ runOn, eventStore });
			const starting = runOn(
				Effect.scoped(
					isolated["events.followChat"](ed, { chatId: world.chat }, { kind: "request" }),
				),
				{ signal: abort.signal },
			);
			const interrupted = expect(starting).rejects.toBeDefined();
			await transactionStarted.promise;
			try {
				await runOn(
					query((db) => db.execute(sql`select 1`, "objects")).pipe(Effect.timeout("2 seconds")),
				);
			} finally {
				abort.abort();
				await interrupted;
			}
		} finally {
			abort.abort();
			await writer.release();
			await runtime.dispose();
		}
	});

	it("releases the only pool slot when reconnect is interrupted during replay", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		const stream = chatStream(world.chat);
		const since = (await stored.latest([stream])).get(stream);
		if (since === undefined) throw new Error("The stream has no cursor");
		const settings = ConfigProvider.fromEnv({ env: { ...process.env, DATABASE_POOL_SIZE: "1" } });
		const runtime = ManagedRuntime.make(
			testInfrastructure.pipe(Layer.provide(ConfigProvider.layer(settings))),
		);
		const runOn = effectRunner(runtime);
		const replayRequested = Promise.withResolvers<void>();
		const startReplay = Promise.withResolvers<void>();
		const abort = new AbortController();
		const store = await runOn(EventStore.make);
		const streams = await runOn(
			Streams.make.pipe(
				Effect.provideService(EventBus.Service, bus),
				Effect.provideService(EventStore.Service, {
					...store,
					async replayPage(page, limit, signal) {
						replayRequested.resolve();
						await startReplay.promise;
						return store.replayPage(page, limit, signal);
					},
				}),
			),
		);
		const starting = runOn(
			Effect.scoped(
				streams.follow({
					principal: ed,
					stream,
					since,
					workspace: world.workspace,
					prove: Effect.succeed({ kind: "chat", workspace: world.workspace, chat: world.chat }),
				}),
			),
			{ signal: abort.signal },
		);
		const interrupted = expect(starting).rejects.toBeDefined();
		try {
			await replayRequested.promise;
			const holder = holdTransaction(
				query((db) =>
					db.execute(sql`lock table event_retention in access exclusive mode`, "objects"),
				),
			);
			try {
				await holder.held;
				startReplay.resolve();
				await holder.waitForWaiters(1);

				abort.abort();
				await interrupted;
				await runOn(
					query((db) => db.execute(sql`select 1`, "objects")).pipe(Effect.timeout("2 seconds")),
				);
			} finally {
				await holder.release();
			}
		} finally {
			abort.abort();
			startReplay.resolve();
			await runtime.dispose();
		}
	});

	it("replays all missed pages once, including a commit during startup, then goes live", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		const stream = chatStream(world.chat);
		const changed = (name: string) => streamEvent("chat.changed", { chatId: name });
		await commit(stream, changed("anchor"));
		const since = (await stored.latest([stream])).get(stream);
		if (since === undefined) throw new Error("The stream has no cursor");
		const missed = Array.from({ length: 200 }, (_, index) => changed(`missed ${index + 1}`));
		await runOnPostgres(transaction(outbox.publish(missed.map((event) => ({ stream, event })))));
		await bus.publish(
			stream,
			streamEvent("message.delta", {
				chatId: world.chat,
				messageId: randomUUID(),
				text: "while away",
				offset: 0,
				execution: 1,
			}),
		);

		const concurrent = changed("during startup");
		const writer = holdTransaction(
			query((db) =>
				db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${stream}, 0))`, "objects"),
			),
			outbox.publish([{ stream, event: concurrent }]),
		);
		await writer.held;
		const requestedSnapshot = Promise.withResolvers<void>();
		const followDuringStartup = await observeStartupSnapshot(() => requestedSnapshot.resolve());
		const starting = pastReady(followDuringStartup)(ed, "events.followChat", {
			chatId: world.chat,
			since,
		});
		await requestedSnapshot.promise;
		await writer.release();
		const resumed = await starting;
		for (const expected of [...missed, concurrent]) {
			expect(await resumed.next()).toEqual({ seq: expect.any(Number), event: expected });
		}
		const live = changed("after replay");
		await commit(stream, live);
		expect(await resumed.next()).toEqual({ seq: expect.any(Number), event: live });
	});

	it("checkpoints filtered replay pages at startup before sending live events", async () => {
		const world = await staffed();
		const erin = await signedIn.member(world.erin);
		const stream = workspaceStream(world.workspace);
		const live = Audience.forWorkspace(streamEvent("chat.changed", { chatId: world.spareChat }));
		await commit(stream, live);
		const since = (await stored.latest([stream])).get(stream);
		if (since === undefined) throw new Error("The stream has no cursor");
		const hidden = Audience.forProject(
			world.project,
			streamEvent("chat.changed", { chatId: world.chat }),
		);
		await runOnPostgres(
			transaction(outbox.publish(Array.from({ length: 225 }, () => ({ stream, event: hidden })))),
		);
		const start = (await stored.latest([stream])).get(stream);
		const { follow: followWithLiveEvent } = await servedRegistry({
			bus: Layer.succeed(EventBus.Service, bus),
			eventStore: {
				...stored,
				async replayPage(page, limit, signal) {
					const rows = await stored.replayPage(page, limit, signal);
					if ("cursor" in page) await commit(stream, live);
					return rows;
				},
			},
		});
		const resumed = await pastReady(followWithLiveEvent)(erin, "events.followWorkspace", {
			workspace: world.workspace,
			since,
		});
		const checkpoint = await resumed.next();
		if (checkpoint === "ended" || checkpoint.seq === undefined) {
			throw new Error("The replay checkpoint has no cursor");
		}
		expect(checkpoint).toEqual({ seq: start, event: streamEvent("ready") });
		const received = await resumed.next();
		expect(received).toEqual({
			seq: expect.any(Number),
			event: streamEvent("chat.changed", { chatId: world.spareChat }),
		});
		await resumed.close();

		const reconnected = await following(erin, "events.followWorkspace", {
			workspace: world.workspace,
			since: checkpoint.seq,
		});
		expect(await reconnected.next()).toEqual(received);
	});

	it("resets at the startup cursor after replaying at most 5,000 missed events", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		const stream = chatStream(world.chat);
		const changed = streamEvent("chat.changed", { chatId: world.chat });
		await commit(stream, changed);
		const since = (await stored.latest([stream])).get(stream);
		if (since === undefined) throw new Error("The stream has no cursor");
		await runOnPostgres(
			transaction(
				outbox.publish(Array.from({ length: 5_001 }, () => ({ stream, event: changed }))),
			),
		);
		const start = (await stored.latest([stream])).get(stream);
		const resumed = await following(ed, "events.followChat", { chatId: world.chat, since });
		for (let replayed = 0; replayed < 5_000; replayed += 1) {
			expect(await nextType(resumed)).toBe("chat.changed");
		}
		expect(await resumed.next()).toEqual({ seq: start, event: streamEvent("reset") });

		const live = streamEvent("chat.changed", { chatId: "after replay" });
		await commit(stream, live);
		expect(await resumed.next()).toEqual({ seq: expect.any(Number), event: live });
	});

	it("resets when pruning removes an event beyond the first replay page", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		const stream = chatStream(world.chat);
		const changed = streamEvent("chat.changed", { chatId: world.chat });
		await commit(stream, changed);
		const since = (await stored.latest([stream])).get(stream);
		if (since === undefined) throw new Error("The stream has no cursor");
		await runOnPostgres(
			transaction(outbox.publish(Array.from({ length: 102 }, () => ({ stream, event: changed })))),
		);

		const replayed: Delivery[] = [];
		let retained: number | undefined;
		const { follow: followWithPruning } = await servedRegistry({
			bus: Layer.succeed(EventBus.Service, bus),
			eventStore: {
				...stored,
				async replayPage(page, limit, signal) {
					if ("cursor" in page) {
						const first = await stored.replayPage(page, limit, signal);
						for (const { seq, event } of first ?? []) replayed.push({ seq, event });
						return first;
					}

					const [pruned, kept] = await stored.replay(stream, page.feed.since, 2, signal);
					if (!pruned || !kept) throw new Error("Expected two events beyond the first page");
					retained = kept.seq;
					await onDatabase((db) =>
						db
							.update(event)
							.set({ createdAt: new Date(0) })
							.where(eq(event.seq, pruned.seq)),
					);
					await stored.prune(new Date(1));
					return stored.replayPage(page, limit, signal);
				},
			},
		});
		const resumed = await followWithPruning(ed, "events.followChat", { chatId: world.chat, since });
		onTestFinished(() => resumed.close());

		expect(replayed.length).toBeGreaterThan(0);
		for (const expected of replayed) expect(await resumed.next()).toEqual(expected);
		const reset = await resumed.next();
		expect(retained).toBeDefined();
		expect(reset).toEqual({ seq: retained, event: streamEvent("reset") });

		await commit(stream, changed);
		expect(await resumed.next()).toEqual({ seq: expect.any(Number), event: changed });
	});

	it("resets a cursor from another stream even when this stream was empty", async () => {
		const world = await staffed();
		const stream = workspaceStream(world.workspace);
		await commit(stream, jChanged(world));
		const since = (await stored.latest([stream])).get(stream);
		if (since === undefined) throw new Error("The workspace stream has no cursor");
		await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));

		const resumed = await following(await signedIn.member(world.ed), "events.followChat", {
			chatId: world.chat,
			since,
		});

		expect(await nextType(resumed)).toBe("reset");
	});

	it("says where a reset stream starts, so a reconnect after it misses nothing", async () => {
		const world = await staffed();
		const ed = await signedIn.member(world.ed);
		const stream = chatStream(world.chat);
		await commit(stream, streamEvent("chat.changed", { chatId: world.chat }));
		const latest = (await stored.latest([stream])).get(stream);
		if (typeof latest !== "number") throw new Error("The stream has no stored event");
		const chat = await follow(ed, "events.followChat", { chatId: world.chat, since: latest + 1 });
		onTestFinished(() => chat.close());

		expect(await chat.next()).toEqual({ seq: latest, event: streamEvent("reset") });
		const changed = streamEvent("chat.changed", { chatId: world.chat });
		await commit(stream, changed);
		expect(await chat.next()).toEqual({ seq: expect.any(Number), event: changed });
	});

	it("sends a live message delta with its execution and without an event id", async () => {
		const world = await staffed();
		const chat = await following(await signedIn.member(world.ed), "events.followChat", {
			chatId: world.chat,
		});
		onTestFinished(() => chat.close());
		const event = streamEvent("message.delta", {
			chatId: world.chat,
			messageId: randomUUID(),
			offset: 5,
			text: "reply",
			execution: 2,
		});

		await bus.publish(chatStream(world.chat), event);

		expect(await chat.next()).toEqual({ event });
	});

	describe("who hears what on a workspace's stream", () => {
		it("sends an event about a chat only to those who reach it, without its audience", async () => {
			const world = await staffed();
			const ed = await following(await signedIn.member(world.ed), "events.followWorkspace", {
				workspace: world.workspace,
			});
			const erin = await following(await signedIn.member(world.erin), "events.followWorkspace", {
				workspace: world.workspace,
			});

			const stream = workspaceStream(world.workspace);
			await commit(
				stream,
				Audience.forChat(world.chat, streamEvent("chat.changed", { chatId: world.chat })),
			);
			// Everyone hears this, so had Erin heard the first she would hear it before.
			const sentinel = streamEvent("chat.changed", { chatId: "sentinel" });
			await commit(stream, Audience.forWorkspace(sentinel));

			const heard = await ed.next();
			expect(heard !== "ended" && heard.event).toEqual(
				streamEvent("chat.changed", { chatId: world.chat }),
			);
			const erinHeard = await erin.next();
			expect(erinHeard !== "ended" && erinHeard.event).toEqual(sentinel);
		});

		it("sends an event about no chat to those who reach its project, and one about a bot or a membership to those who reach it", async () => {
			const world = await staffed();
			const ed = await following(await signedIn.member(world.ed), "events.followWorkspace", {
				workspace: world.workspace,
			});
			const erin = await following(await signedIn.member(world.erin), "events.followWorkspace", {
				workspace: world.workspace,
			});
			const stream = workspaceStream(world.workspace);
			/** An event each follower tells apart by the audience it was sent to. */
			const changed = (audience: string) => streamEvent("chat.changed", { chatId: audience });

			await commit(stream, Audience.forProject(world.project, changed("J")));
			await commit(stream, Audience.forBot(world.mine.id, changed("Mine")));
			await commit(stream, Audience.forBot(world.spare.id, changed("Spare")));
			await commit(stream, Audience.forWorkspace(changed("workspace")));
			// Nobody is named, so nobody hears it.
			await commit(stream, changed("nobody"));
			await commit(stream, Audience.forWorkspace(changed("last")));

			/** The audiences of what `heard` sends, up to the last. */
			const heardBy = async (heard: Following<Delivery>) => {
				const audiences: unknown[] = [];
				for (;;) {
					const next = await heard.next();
					if (next === "ended") break;
					audiences.push(next.event.chatId);
					if (next.event.chatId === "last") break;
				}
				return audiences;
			};
			// Ed reaches J, his personal bot, and Spare; Erin only Spare.
			expect(await heardBy(ed)).toEqual(["J", "Mine", "Spare", "workspace", "last"]);
			expect(await heardBy(erin)).toEqual(["Spare", "workspace", "last"]);
		});

		it("hears about a bot made after it started, once it has proved again", async () => {
			const world = await staffed();
			const erin = await following(await signedIn.member(world.erin), "events.followWorkspace", {
				workspace: world.workspace,
			});
			const made = await seedBot(world.workspace, { createdById: world.erin });

			await commit(
				workspaceStream(world.workspace),
				Audience.forBot(made.id, streamEvent("chat.changed", { chatId: world.chat })),
			);

			expect(await nextType(erin)).toBe("chat.changed");
		});

		it("tells the member of a project they made, and then sends its events", async () => {
			const world = await staffed();
			const erin = await following(await signedIn.member(world.erin), "events.followWorkspace", {
				workspace: world.workspace,
			});
			const made = await call(await signedIn.member(world.erin), "projects.create", {
				workspace: world.workspace,
				name: "Fresh",
				leadBotId: world.pub.id,
			});

			await commit(
				workspaceStream(world.workspace),
				Audience.forProject(made.id, streamEvent("chat.changed", { chatId: world.chat })),
			);

			expect(await nextType(erin)).toBe("reach.changed");
			expect(await nextType(erin)).toBe("chat.changed");
		});

		it("tells the member when they make a Personal Assistant", async () => {
			const world = await staffed();
			const ed = await signedIn.member(world.ed);
			const roster = await following(ed, "events.followWorkspace", { workspace: world.workspace });
			const made = await call(ed, "bots.createAssistant", { workspace: world.workspace });
			const sentinel = streamEvent("chat.changed", { chatId: world.chat });
			await commit(workspaceStream(world.workspace), Audience.forWorkspace(sentinel));

			const heard = await roster.next();
			expect(heard !== "ended" && heard.event).toEqual(
				streamEvent("reach.changed", { about: { kind: "bot", botId: made.id } }),
			);
		});

		it("tells a member when their Personal Assistant is deleted, though they no longer reach it, and nobody who never reached it", async () => {
			const world = await staffed();
			const ed = await signedIn.member(world.ed);
			const made = await call(ed, "bots.createAssistant", { workspace: world.workspace });
			const roster = await following(ed, "events.followWorkspace", { workspace: world.workspace });
			const erin = await following(await signedIn.member(world.erin), "events.followWorkspace", {
				workspace: world.workspace,
			});
			await call(await signedIn.member(world.admin), "bots.remove", { botId: made.id });
			const sentinel = streamEvent("chat.changed", { chatId: world.chat });
			await commit(workspaceStream(world.workspace), Audience.forWorkspace(sentinel));

			const heard = await roster.next();
			expect(heard !== "ended" && heard.event).toEqual(
				streamEvent("reach.changed", { about: { kind: "bot", botId: made.id } }),
			);
			const erinHeard = await erin.next();
			expect(erinHeard !== "ended" && erinHeard.event).toEqual(sentinel);
		});

		it("closes the private bot’s own chat to a removed member who can still talk to it in a private project", async () => {
			const world = await staffed();
			const secret = await seedBot(world.workspace, {
				createdById: world.ed,
				visibility: "private",
				members: [world.ed, world.vi],
			});

			const shared = await seedProject(world.workspace, {
				leadBotId: secret.id,
				members: [world.vi],
			});
			await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, secret.id)));
			const erin = await following(await signedIn.member(world.erin), "events.followWorkspace", {
				workspace: world.workspace,
			});
			const viewer = await signedIn.member(world.vi);
			const vi = await following(viewer, "events.followWorkspace", { workspace: world.workspace });
			const chatId = await seedProjectChat(world.workspace, secret.defaultProject, world.ed);
			const ownChat = await following(viewer, "events.followChat", { chatId });

			await call(await signedIn.member(world.ed), "bots.removeMember", {
				botId: secret.id,
				memberId: world.vi,
			});

			const unnamed = streamEvent("reach.changed", { about: { kind: "workspace" } });
			for (const follower of [erin, vi]) {
				const heard = await follower.next();
				expect(heard !== "ended" && heard.event).toEqual(unnamed);
			}
			await expect.soft(ownChat.next()).resolves.toBe("ended");
			await expect(call(viewer, "chats.get", { chatId, limit: 1 })).rejects.toBeInstanceOf(
				ResourceHidden,
			);
			const started = await call(viewer, "chats.startProjectChat", {
				projectId: shared,
				retryKey: randomUUID(),
				message: "How is the launch going?",
			});
			expect(started.chat).toMatchObject({ projectId: shared });
			expect(await runOnPostgres(runningTurns(started.chat.id))).toMatchObject([
				{ request: { botId: secret.id } },
			]);
		});

		it("tells everyone that a project was made private, naming it to nobody", async () => {
			const world = await staffed();
			const open = await seedProject(world.workspace, {
				leadBotId: world.pub.id,
				visibility: "public",
			});
			const erin = await following(await signedIn.member(world.erin), "events.followWorkspace", {
				workspace: world.workspace,
			});

			await call(await signedIn.member(world.admin), "projects.update", {
				projectId: open,
				changes: { visibility: "private" },
			});

			const heard = await erin.next();
			expect(heard !== "ended" && heard.event).toEqual(
				streamEvent("reach.changed", { about: { kind: "workspace" } }),
			);
		});

		it("proves again when a role changes, and sends what the new role reaches", async () => {
			const world = await staffed();
			const erin = await following(await signedIn.member(world.erin), "events.followWorkspace", {
				workspace: world.workspace,
			});
			const owner = await signedIn.member(world.owner);

			await call(owner, "workspaces.changeRole", {
				workspace: world.workspace,
				membershipId: await membershipOf(world.workspace, world.erin, owner),
				role: "admin",
			});
			// The change itself, about a membership, which everyone in the workspace sees.
			expect(await nextType(erin)).toBe("reach.changed");
			await commit(
				workspaceStream(world.workspace),
				Audience.forChat(world.chat, streamEvent("chat.changed", { chatId: world.chat })),
			);

			// An admin is in every project members made.
			expect(await nextType(erin)).toBe("chat.changed");
		});
	});

	describe("a member's name", () => {
		it("tells everyone in each workspace a member is in when they change their name, and lets no bot change it", async () => {
			const world = await staffed();
			const other = await seedWorkspace();
			await addMembership(other, world.ed, "editor");
			const erin = await following(await signedIn.member(world.erin), "events.followWorkspace", {
				workspace: world.workspace,
			});
			const ed = await signedIn.member(world.ed);
			const elsewhere = await following(ed, "events.followWorkspace", { workspace: other });

			const renamed = await call(ed, "system.rename", { name: "Edmund" });

			expect(renamed.name).toBe("Edmund");
			const heard = await erin.next();
			expect(heard !== "ended" && heard.event).toEqual(
				streamEvent("member.changed", { memberId: world.ed }),
			);
			expect(await nextType(elsewhere)).toBe("member.changed");
			const asBot = await call(
				await signedIn.botFor(world.ed, world.pub.id, world.chat),
				"system.rename",
				{ name: "Bot's idea" },
			).then(
				() => "ok",
				(failure: { readonly _tag: string }) => failure._tag,
			);
			expect(asBot).toBe("ActionForbidden");
		});
	});

	describe("losing what it follows", () => {
		const followWith = async (
			world: Awaited<ReturnType<typeof staffed>>,
			prove: Effect.Effect<Streams.Hearing, ResourceHidden>,
			catchUp: Duration.Input,
			{
				clockOverride,
				followed = workspaceStream(world.workspace),
			}: { readonly clockOverride?: Clock.Clock; readonly followed?: EventStream } = {},
		) => {
			const principal = await signedIn.member(world.ed);
			const scope = Scope.makeUnsafe();
			onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
			const start = Scope.provide(scope)(
				Effect.flatMap(Streams.Service, (streams) =>
					streams.follow({
						principal,
						stream: followed,
						since: undefined,
						workspace: world.workspace,
						prove,
					}),
				).pipe(
					Effect.provide(
						Streams.layer.pipe(
							Layer.provide(
								Layer.mergeAll(
									Layer.succeed(EventBus.Service, bus),
									Layer.succeed(EventStore.Service, stored),
									Layer.succeed(Streams.Timing, { catchUp }),
								),
							),
						),
					),
				),
			);
			const running = await runOnPostgres(
				clockOverride ? Effect.provideService(start, Clock.Clock, clockOverride) : start,
			);
			// What these cases are about comes after the `ready` the stream starts with.
			const stream = running.stream.pipe(Stream.filter(({ event }) => event.type !== "ready"));
			return { ...running, stream, principal };
		};

		it("shares a proof for a control event and checks a later change again", async () => {
			const world = await staffed();
			let proofs = 0;
			const running = await followWith(
				world,
				Effect.sync((): Streams.Hearing => {
					proofs += 1;
					return {
						kind: "workspace",
						workspace: world.workspace,
						projects: { reached: new Set([world.project]), unreached: new Set() },
						bots: { reached: new Set(), unreached: new Set() },
					};
				}),
				"10 seconds",
			);
			const feed = workspaceStream(world.workspace);
			const reader = Stream.toReadableStream(running.stream).getReader();
			onTestFinished(() => reader.cancel());
			const changed = streamEvent("reach.changed", { about: { kind: "workspace" } });

			await commit(feed, Audience.forWorkspace(changed));
			expect((await reader.read()).value?.event).toEqual(changed);
			await commit(feed, Audience.forWorkspace(changed));
			expect((await reader.read()).value?.event).toEqual(changed);
			expect(proofs).toBe(4);
		});

		it("keeps ordered reach after an older watcher proof finishes", async () => {
			const world = await staffed();
			const watching = Promise.withResolvers<void>();
			const finishWatching = Promise.withResolvers<void>();
			const watcherReturned = Promise.withResolvers<void>();
			const hearing = (reached: boolean): Streams.Hearing => ({
				kind: "workspace",
				workspace: world.workspace,
				projects: {
					reached: new Set(reached ? [world.project] : []),
					unreached: new Set(reached ? [] : [world.project]),
				},
				bots: { reached: new Set(), unreached: new Set() },
			});
			let proofs = 0;
			const running = await followWith(
				world,
				Effect.promise(async () => {
					proofs += 1;
					if (proofs <= 2) return hearing(true);
					if (proofs === 3) {
						watching.resolve();
						await finishWatching.promise;
						watcherReturned.resolve();
						return hearing(true);
					}
					return hearing(false);
				}),
				"10 seconds",
			);
			const feed = workspaceStream(world.workspace);
			const reader = Stream.toReadableStream(running.stream).getReader();
			onTestFinished(() => reader.cancel());
			try {
				// Wakes the watcher while the sender has no new durable event to read.
				await bus.publishCommitted([{ stream: feed, event: jChanged(world), seq: 1 }]);
				await watching.promise;
				await takeEdOut(world);
				await commitUnheard(feed, jChanged(world));
				await commit(
					feed,
					Audience.forWorkspace(streamEvent("chat.changed", { chatId: world.chat })),
				);
				expect((await reader.read()).value?.event.type).toBe("chat.changed");
				finishWatching.resolve();
				await watcherReturned.promise;

				await commitUnheard(
					feed,
					Audience.forProject(world.project, streamEvent("chat.changed", { chatId: world.chat })),
				);
				await commit(
					feed,
					Audience.forWorkspace(streamEvent("chat.changed", { chatId: world.spareChat })),
				);
				expect((await reader.read()).value?.event.chatId).toBe(world.spareChat);
			} finally {
				finishWatching.resolve();
			}
		});

		it("sends no reply text after a change of reach it has heard of until it has proved again", async () => {
			const world = await staffed();
			const provingAgain = Promise.withResolvers<void>();
			const refuse = Promise.withResolvers<void>();
			let proofs = 0;
			const running = await followWith(
				world,
				Effect.flatMap(
					Effect.promise(async () => {
						proofs += 1;
						if (proofs <= 2) return true;
						provingAgain.resolve();
						await refuse.promise;
						return false;
					}),
					(reached) =>
						reached
							? Effect.succeed<Streams.Hearing>({
									kind: "chat",
									workspace: world.workspace,
									chat: world.chat,
								})
							: Effect.fail(new ResourceHidden({ resource: "chat" })),
				),
				"10 seconds",
				{ followed: chatStream(world.chat) },
			);
			const reader = Stream.toReadableStream(running.stream).getReader();
			onTestFinished(() => reader.cancel());
			await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));
			expect((await reader.read()).value?.event.type).toBe("chat.changed");

			await takeEdOut(world);
			await commit(workspaceStream(world.workspace), jChanged(world));
			await bus.publish(
				chatStream(world.chat),
				streamEvent("message.delta", {
					chatId: world.chat,
					messageId: randomUUID(),
					offset: 0,
					text: "secret",
					execution: 1,
				}),
			);
			const read = reader.read();
			try {
				expect(
					await Promise.race([
						provingAgain.promise.then(() => "proving again"),
						read.then((next) => next.value?.event.type),
					]),
				).toBe("proving again");
			} finally {
				refuse.resolve();
			}
			expect((await read).done).toBe(true);
		});

		it("ends the operation by its deadline when a session read is stalled", async () => {
			const world = await staffed();
			const interval = "400 millis";
			const scope = Scope.makeUnsafe();
			onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
			const sessionClock = await Effect.runPromise(Scope.provide(TestClock.make(), scope));
			const sleeps = await observeWatcherSleeps(sessionClock, interval);
			const running = await followWith(
				world,
				Effect.succeed({
					kind: "workspace",
					workspace: world.workspace,
					projects: { reached: new Set([world.project]), unreached: new Set() },
					bots: { reached: new Set(), unreached: new Set() },
				}),
				interval,
				{ clockOverride: sleeps.clock },
			);
			const stalled = holdTransaction(
				query((db) => db.execute(sql`lock table session in access exclusive mode`)),
			);
			await stalled.held;
			const checkDelay = Duration.toMillis(interval) / 2;
			await sleeps.waitForInitialSleeps();
			await Effect.runPromise(sessionClock.adjust(checkDelay));
			await stalled.waitForWaiters(1);
			await Effect.runPromise(sessionClock.adjust(checkDelay));

			await Effect.runPromise(running.ended);
			await stalled.release();
		});

		it("ends a chat's stream when its member is removed from the chat's project, and stops sending its events on the workspace's", async () => {
			const world = await staffed();
			const ed = await signedIn.member(world.ed);
			const chat = await following(ed, "events.followChat", { chatId: world.chat });
			const workspace = await following(ed, "events.followWorkspace", {
				workspace: world.workspace,
			});
			const vi = await following(await signedIn.member(world.vi), "events.followWorkspace", {
				workspace: world.workspace,
			});
			await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));
			expect(await nextType(chat)).toBe("chat.changed");

			await call(await signedIn.member(world.admin), "projects.removeMember", {
				projectId: world.project,
				memberId: world.ed,
			});

			expect(await nextType(chat)).toBe("ended");
			// Both are told, naming no project, so Ed's lists drop J too.
			const unnamed = streamEvent("reach.changed", { about: { kind: "workspace" } });
			for (const follower of [vi, workspace]) {
				const heard = await follower.next();
				expect(heard !== "ended" && heard.event).toEqual(unnamed);
			}
			await commit(
				workspaceStream(world.workspace),
				Audience.forChat(world.chat, streamEvent("chat.changed", { chatId: world.chat })),
			);
			await commit(
				workspaceStream(world.workspace),
				Audience.forWorkspace(streamEvent("chat.changed", { chatId: "after" })),
			);
			const next = await workspace.next();
			expect(next !== "ended" && next.event.chatId).toBe("after");
		});

		it("ends only the departing workspace's streams while computer cleanup is pending", async () => {
			const world = await staffed();
			const assistant = await seedBot(world.workspace, {
				assistantOf: world.ed,
				visibility: "personal",
			});
			await seedComputer(world.workspace, assistant.defaultProject);
			const otherWorkspace = await seedWorkspace();
			await addMembership(otherWorkspace, world.ed, "editor");
			const member = await signedIn.member(world.ed);
			const otherSession = await signedIn.member(world.ed);
			const workspace = await following(member, "events.followWorkspace", {
				workspace: world.workspace,
			});
			const chat = await following(member, "events.followChat", { chatId: world.chat });
			const elsewhere = await following(otherSession, "events.followWorkspace", {
				workspace: otherWorkspace,
			});
			const admin = await signedIn.member(world.admin);

			await expect(
				call(admin, "workspaces.removeMembership", {
					workspace: world.workspace,
					membershipId: await membershipOf(world.workspace, world.ed, admin),
				}),
			).resolves.toEqual({ cleanupPending: true });

			expect(await nextType(workspace)).toBe("ended");
			expect(await nextType(chat)).toBe("ended");
			await commit(
				workspaceStream(otherWorkspace),
				Audience.forWorkspace(streamEvent("member.changed", { memberId: world.ed })),
			);
			expect(await nextType(elsewhere)).toBe("member.changed");
		});
	});

	describe("its session", () => {
		it("ends every stream opened with a session when the session ends, and none opened with another", async () => {
			const world = await staffed();
			const signedOut = await signedIn.member(world.ed);
			const stillIn = await signedIn.member(world.ed);
			const own = await following(signedOut, "events.followOwn", {});
			const chat = await following(signedOut, "events.followChat", { chatId: world.chat });
			const other = await following(stillIn, "events.followChat", { chatId: world.chat });

			await commit(
				memberStream(world.ed),
				streamEvent("session.ended", { sessionId: signedOut.session }),
			);

			expect(await nextType(own)).toBe("ended");
			expect(await nextType(chat)).toBe("ended");
			await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));
			expect(await nextType(other)).toBe("chat.changed");
		});

		it("ends itself when its session expires", async () => {
			const world = await staffed();
			const expiring = await signedIn.member(world.ed);
			const expiresAt = (await Effect.runPromise(clock.currentTimeMillis)) + 750;
			await onDatabase((db) =>
				db
					.update(session)
					.set({ expiresAt: new Date(expiresAt) })
					.where(eq(session.id, expiring.session)),
			);
			const stream = await followingOnTestClock(expiring, "events.followChat", {
				chatId: world.chat,
			});
			await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));
			expect(await nextType(stream)).toBe("chat.changed");

			await watcherSleeps.waitForInitialSleeps();
			await Effect.runPromise(clock.setTime(expiresAt));

			expect(await nextType(stream)).toBe("ended");
		});

		it("never sends a session's end to a client", async () => {
			const world = await staffed();
			const own = await following(await signedIn.member(world.ed), "events.followOwn", {});

			await commit(memberStream(world.ed), streamEvent("session.ended", { sessionId: "another" }));
			const sentinel = streamEvent("approvals.changed", { toolCallId: randomUUID() });
			await commit(memberStream(world.ed), sentinel);

			expect(await nextType(own)).toBe(sentinel.type);
		});
	});

	describe("what the bus misses, and a client that doesn't keep up", () => {
		it("ends a chat's stream when its member loses the chat, though the change never reached this process's bus", async () => {
			const world = await staffed();
			const ed = await followingOnTestClock(await signedIn.member(world.ed), "events.followChat", {
				chatId: world.chat,
			});

			await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));
			expect(await nextType(ed)).toBe("chat.changed");

			await takeEdOut(world);
			await commitUnheard(workspaceStream(world.workspace), jChanged(world));

			await watcherSleeps.waitForInitialSleeps();
			await Effect.runPromise(clock.adjust(Duration.toMillis(catchUp) / 2));

			expect(await nextType(ed)).toBe("ended");
		});

		it("ends when its session is deleted though no event says so", async () => {
			const world = await staffed();
			const signedOut = await signedIn.member(world.ed);
			const own = await followingOnTestClock(signedOut, "events.followOwn", {});

			await runOnPostgres(
				transaction(
					Effect.gen(function* () {
						yield* query((db) => db.delete(session).where(eq(session.id, signedOut.session)));
						const deleted = yield* query((db) =>
							db
								.delete(event)
								.where(
									and(
										eq(event.stream, memberStream(signedOut.member)),
										eq(event.type, "session.ended"),
										sql`${event.payload}->>'sessionId' = ${signedOut.session}`,
									),
								)
								.returning({ seq: event.seq }),
						);
						expect(deleted).toHaveLength(1);
					}),
				),
			);

			await watcherSleeps.waitForInitialSleeps();
			await Effect.runPromise(clock.adjust(Duration.toMillis(catchUp) / 2));

			expect(await nextType(own)).toBe("ended");
		});

		it("decides an event stored after a change of reach by the proof that change makes, though the event arrived first", async () => {
			const world = await staffed();
			const ed = await following(await signedIn.member(world.ed), "events.followChat", {
				chatId: world.chat,
			});

			await takeEdOut(world);
			await commitUnheard(workspaceStream(world.workspace), jChanged(world));
			await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));

			expect(await nextType(ed)).toBe("ended");
		});

		it("sends none of what waited for a client that wasn't taking it, once its member loses the chat", async () => {
			const world = await staffed();
			const scope = await Effect.runPromise(Scope.make());
			onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
			const stream = await runOnPostgres(
				Scope.provide(scope)(
					longRunning["events.followChat"](
						await signedIn.member(world.ed),
						{ chatId: world.chat },
						{ kind: "request" },
					),
				),
			);
			for (let sent = 0; sent < 24; sent++) {
				await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));
			}

			await call(await signedIn.member(world.admin), "projects.removeMember", {
				projectId: world.project,
				memberId: world.ed,
			});
			// Its watcher proves again as the change is delivered, apart from the client.
			await runOnPostgres(stream.ended);

			expect(await runOnPostgres(Stream.runCollect(stream.stream))).toEqual([]);
		});

		it("leaves no subscription behind when its client leaves while events wait for it", async () => {
			const world = await staffed();
			const scope = await Effect.runPromise(Scope.make());
			await runOnPostgres(
				Scope.provide(scope)(
					longRunning["events.followChat"](
						await signedIn.member(world.ed),
						{ chatId: world.chat },
						{ kind: "request" },
					),
				).pipe(Effect.asVoid),
			);
			for (let sent = 0; sent < 24; sent++) {
				await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));
			}
			expect(subscribed.get(chatStream(world.chat))).toBe(1);

			await Effect.runPromise(Scope.close(scope, Exit.void));

			await noneSubscribed(chatStream(world.chat));
		});
	});

	describe("starting", () => {
		it("refuses a chat id that isn't one as hidden, and follows a chat however its id is written", async () => {
			const world = await staffed();
			const ed = await signedIn.member(world.ed);
			const refused = await follow(ed, "events.followChat", { chatId: "not-a-chat" }).then(
				() => "ok",
				(failure: { readonly _tag: string }) => failure._tag,
			);
			expect(refused).toBe("ResourceHidden");

			const shouted = await following(ed, "events.followChat", {
				chatId: world.chat.toUpperCase(),
			});
			await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));

			expect(await nextType(shouted)).toBe("chat.changed");
		});

		it("refuses a chat the member doesn't reach as hidden, and anyone but a member signed in", async () => {
			const world = await staffed();
			const refusal = (started: Promise<unknown>) =>
				started.then(
					() => "ok",
					(failure: { readonly _tag: string }) => failure._tag,
				);

			expect(
				await refusal(
					follow(await signedIn.member(world.erin), "events.followChat", { chatId: world.chat }),
				),
			).toBe("ResourceHidden");
			expect(
				await refusal(
					follow(await signedIn.member(world.erin), "events.followWorkspace", {
						workspace: await seedWorkspace(),
					}),
				),
			).toBe("ResourceHidden");
			expect(
				await refusal(
					follow(await signedIn.botFor(world.ed, world.pub.id, world.chat), "events.followOwn", {}),
				),
			).toBe("ActionForbidden");
		});

		it("replays a member's notification when pruning only removed another stream's event", async () => {
			const world = await staffed();
			const stream = memberStream(world.ed);
			await commit(stream, streamEvent("approvals.changed", { toolCallId: randomUUID() }));
			const since = (await stored.latest([stream])).get(stream);
			if (since === undefined) throw new Error("The member's stream has no cursor");
			const notification = streamEvent("notification", {
				title: "Release notes",
				body: "The draft is ready.",
				tag: "release-notes",
				path: "/",
				chatId: null,
			});
			await commit(stream, notification);
			const unrelated = memberStream(world.vi);
			await commit(unrelated, streamEvent("approvals.changed", { toolCallId: randomUUID() }));
			await onDatabase((db) =>
				db
					.update(event)
					.set({ createdAt: new Date(0) })
					.where(eq(event.stream, unrelated)),
			);
			await stored.prune(new Date(1));

			const resumed = await follow(await signedIn.member(world.ed), "events.followOwn", { since });
			onTestFinished(() => resumed.close());
			expect(await resumed.next()).toEqual({ seq: expect.any(Number), event: notification });
		});

		it("replays a notification only to a member who still reaches its chat or can still decide its approval", async () => {
			const world = await staffed();
			const notification = (title: string, chatId: string | null) =>
				streamEvent("notification", { title, body: "", tag: title, path: "/", chatId });
			const edsStream = memberStream(world.ed);
			const visStream = memberStream(world.vi);
			await commit(edsStream, streamEvent("approvals.changed", { toolCallId: randomUUID() }));
			await commit(visStream, streamEvent("approvals.changed", { toolCallId: randomUUID() }));
			const starts = await stored.latest([edsStream, visStream]);
			const edsFirst = starts.get(edsStream);
			const visFirst = starts.get(visStream);
			const inJ = Audience.forChat(world.chat, notification("In J", world.chat));
			await commit(edsStream, inJ);
			await commit(visStream, inJ);
			await commit(
				edsStream,
				Audience.addressedTo(
					{ kind: "approval", toolCall: randomUUID(), approval: randomUUID(), showsChat: false },
					notification("Not Ed's to decide", null),
				),
			);
			await commit(edsStream, notification("For anyone", null));
			await takeEdOut(world);

			const ed = await following(await signedIn.member(world.ed), "events.followOwn", {
				since: edsFirst,
			});
			const vi = await following(await signedIn.member(world.vi), "events.followOwn", {
				since: visFirst,
			});

			const edHeard = await ed.next();
			expect(edHeard !== "ended" && edHeard.event.title).toBe("For anyone");
			const viHeard = await vi.next();
			expect(viHeard !== "ended" && viHeard.event).toEqual(notification("In J", world.chat));
		});

		it("resumes after the client's last event, and proves what it replays", async () => {
			const world = await staffed();
			const stream = workspaceStream(world.workspace);
			await commit(stream, Audience.forWorkspace(streamEvent("chat.changed", { chatId: "first" })));
			const first = (await stored.latest([stream])).get(stream);
			await commit(
				stream,
				Audience.forChat(world.chat, streamEvent("chat.changed", { chatId: world.chat })),
			);
			await commit(stream, Audience.forWorkspace(streamEvent("chat.changed", { chatId: "third" })));

			const erin = await following(await signedIn.member(world.erin), "events.followWorkspace", {
				workspace: world.workspace,
				since: first,
			});

			const next = await erin.next();
			expect(next !== "ended" && next.event.chatId).toBe("third");
		});
	});
});

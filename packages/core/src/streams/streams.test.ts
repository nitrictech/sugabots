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
import type { Delivery } from "@sugabots/contracts/operations/events";
import { and, eq, sql } from "drizzle-orm";
import { type Duration, Effect, Exit, Layer, Scope, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	addMembership,
	seedBot,
	seedComputer,
	seedMember,
	seedProject,
	seedProjectChat,
	seedWorkspace,
} from "../authentication/seed.test-support.ts";
import { recordEnded } from "../authentication/session.ts";
import { chatServicesForTests } from "../chats/testing.ts";
import { query, transaction } from "../database/database.ts";
import { Audience } from "../database/events/audience.ts";
import { EventBus } from "../database/events/bus.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { EventStore } from "../database/events/store.ts";
import { projectMember, session } from "../database/schema.ts";
import { closeDatabase, holdTransaction, onDatabase, runOnPostgres } from "../database/testing.ts";
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
	const inProcess = EventBus.inProcess({ store: EventStore.inMemory() });
	const bus: EventBus.Interface = {
		...inProcess,
		async *subscribe(stream, options) {
			subscribed.set(stream, (subscribed.get(stream) ?? 0) + 1);
			try {
				yield* inProcess.subscribe(stream, options);
			} finally {
				subscribed.set(stream, (subscribed.get(stream) ?? 0) - 1);
			}
		},
	};
	let call: CallOperation;
	let follow: FollowOperation;
	let longRunning: Operations.LongRunningInterface;
	let signedIn: ReturnType<typeof principals>;
	let outbox: EventOutbox.Interface;
	/** An outbox whose deliveries reach no bus this process listens to, as another's can fail to. */
	let unheard: EventOutbox.Interface;
	let stored: EventStore.Interface;
	const open: Following<Delivery>[] = [];

	beforeAll(async () => {
		const chats = await chatServicesForTests(bus);
		({ call, follow, longRunning } = await servedRegistry({
			chats,
			bus: Layer.succeed(EventBus.Service, bus),
			streamsTiming: { catchUp: "1 second" },
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
		unheard = await outboxOver(EventBus.inProcess({ store: EventStore.inMemory() }));
		stored = await runOnPostgres(EventStore.make);
	});

	afterAll(async () => {
		await Promise.all(open.map((following) => following.close()));
		await closeDatabase();
	});

	/** Starts following, closed when the file ends. */
	const following: FollowOperation = async (principal, name, input) => {
		const started = await follow(principal, name, input);
		open.push(started as Following<Delivery>);
		return started;
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

	/** What `stream` sends next before it goes quiet: an event's type, `ended`, or `quiet`. */
	const sendsNext = async (stream: Following<Delivery>) => {
		const next = await stream.quiet();
		return typeof next === "string" ? next : next.event.type;
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

			await commit(
				workspaceStream(world.workspace),
				Audience.forChat(world.chat, streamEvent("chat.changed", { chatId: world.chat })),
			);

			const heard = await ed.next();
			expect(heard !== "ended" && heard.event).toEqual(
				streamEvent("chat.changed", { chatId: world.chat }),
			);
			expect(await sendsNext(erin)).toBe("quiet");
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
			const changed = streamEvent("chat.changed", { chatId: world.chat });

			await commit(stream, Audience.forProject(world.project, changed));
			await commit(stream, Audience.forBot(world.mine.id, changed));
			await commit(stream, Audience.forBot(world.spare.id, changed));
			await commit(stream, Audience.forWorkspace(changed));
			// Nobody is named, so nobody hears it.
			await commit(stream, changed);
			await commit(stream, Audience.forWorkspace(streamEvent("chat.changed", { chatId: "last" })));

			const heardBy = async (heard: Following<Delivery>) => {
				const audiences: unknown[] = [];
				for (;;) {
					const next = await heard.next();
					if (next === "ended") break;
					audiences.push(next.seq);
					if (next.event.chatId === "last") break;
				}
				return audiences.length;
			};
			// Ed reaches J, his personal bot, and Spare; Erin only Spare.
			expect(await heardBy(ed)).toBe(5);
			expect(await heardBy(erin)).toBe(3);
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
		const followWorkspaceWith = async (
			world: Awaited<ReturnType<typeof staffed>>,
			prove: Effect.Effect<Streams.Hearing>,
			catchUp: Duration.Input,
		) => {
			const principal = await signedIn.member(world.ed);
			const scope = Scope.makeUnsafe();
			onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
			const running = await runOnPostgres(
				Scope.provide(scope)(
					Effect.flatMap(Streams.Service, (streams) =>
						streams.follow({
							principal,
							stream: workspaceStream(world.workspace),
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
				),
			);
			return { ...running, principal };
		};

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
			const running = await followWorkspaceWith(
				world,
				Effect.promise(async () => {
					proofs += 1;
					if (proofs === 1) return hearing(true);
					if (proofs === 2) {
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

		it("ends the operation by its deadline when a session read is stalled", async () => {
			const world = await staffed();
			const running = await followWorkspaceWith(
				world,
				Effect.succeed({
					kind: "workspace",
					workspace: world.workspace,
					projects: { reached: new Set([world.project]), unreached: new Set() },
					bots: { reached: new Set(), unreached: new Set() },
				}),
				"400 millis",
			);
			const stalled = holdTransaction(
				query((db) => db.execute(sql`lock table session in access exclusive mode`)),
			);
			await stalled.held;
			try {
				await expect(
					Effect.runPromise(running.ended.pipe(Effect.timeout("1 second"))),
				).resolves.toBeUndefined();
			} finally {
				await stalled.release();
			}
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
			// Vi, still in J, is told its members changed; Ed, who no longer reaches it, isn't.
			expect(await nextType(vi)).toBe("reach.changed");
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

		it("ends a bot's chat's stream when the bot stops being public", async () => {
			const world = await staffed();
			const erin = await following(await signedIn.member(world.erin), "events.followChat", {
				chatId: world.spareChat,
			});

			await call(await signedIn.member(world.ed), "bots.update", {
				botId: world.spare.id,
				changes: { visibility: "personal" },
			});

			expect(await nextType(erin)).toBe("ended");
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

			await runOnPostgres(
				recordEnded({ session: signedOut.session, member: world.ed }).pipe(
					Effect.provide(
						EventOutbox.layer.pipe(Layer.provide(Layer.succeed(EventBus.Service, bus))),
					),
				),
			);

			expect(await nextType(own)).toBe("ended");
			expect(await nextType(chat)).toBe("ended");
			await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));
			expect(await nextType(other)).toBe("chat.changed");
		});

		it("ends itself when its session expires", async () => {
			const world = await staffed();
			const expiring = await signedIn.member(world.ed, 1);
			const stream = await following(expiring, "events.followChat", { chatId: world.chat });

			expect(await stream.next("5 seconds")).toBe("ended");
		});

		it("never sends a session's end to a client", async () => {
			const world = await staffed();
			const own = await following(await signedIn.member(world.ed), "events.followOwn", {});

			await commit(memberStream(world.ed), streamEvent("session.ended", { sessionId: "another" }));

			expect(await sendsNext(own)).toBe("quiet");
		});
	});

	describe("what the bus misses, and a client that doesn't keep up", () => {
		it("ends a chat's stream when its member loses the chat, though the change never reached this process's bus", async () => {
			const world = await staffed();
			const ed = await following(await signedIn.member(world.ed), "events.followChat", {
				chatId: world.chat,
			});

			await takeEdOut(world);
			await commitUnheard(workspaceStream(world.workspace), jChanged(world));

			expect(await nextType(ed)).toBe("ended");
		});

		it("ends when its session is deleted though no event says so", async () => {
			const world = await staffed();
			const signedOut = await signedIn.member(world.ed);
			const own = await following(signedOut, "events.followOwn", {});

			await onDatabase((db) => db.delete(session).where(eq(session.id, signedOut.session)));

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
						{ kind: "request", request: randomUUID() },
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
			await new Promise((resolve) => setTimeout(resolve, 1_000));

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
						{ kind: "request", request: randomUUID() },
					),
				).pipe(Effect.asVoid),
			);
			for (let sent = 0; sent < 24; sent++) {
				await commit(chatStream(world.chat), streamEvent("chat.changed", { chatId: world.chat }));
			}
			expect(subscribed.get(chatStream(world.chat))).toBe(1);

			await Effect.runPromise(Scope.close(scope, Exit.void));

			await vi.waitFor(() => expect(subscribed.get(chatStream(world.chat))).toBe(0));
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

		it("resumes after the client's last event, and proves what it replays", async () => {
			const world = await staffed();
			const stream = workspaceStream(world.workspace);
			await commit(stream, Audience.forWorkspace(streamEvent("chat.changed", { chatId: "first" })));
			const first = await stored.latest(stream);
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

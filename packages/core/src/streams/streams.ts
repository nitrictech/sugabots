export * as Streams from "./streams.ts";

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
import { eq } from "drizzle-orm";
import {
	Cause,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Layer,
	Queue,
	type Scope,
	Stream,
} from "effect";
import { expiryOf } from "../authentication/session.ts";
import { namedMemberColumns, toMember } from "../chats/store/participants.ts";
import { type Database, query, serviceOperations } from "../database/database.ts";
import { Audience } from "../database/events/audience.ts";
import { EventBus } from "../database/events/bus.ts";
import { EventStore } from "../database/events/store.ts";
import { bot, member, placedChat, project } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Running } from "../operations/operation.ts";
import type { MemberSession } from "../principal.ts";
import type { IsMember } from "../proofs/is-member.ts";
import type { CanTakePart } from "../proofs/project-permissions.ts";
import type { ReachSet } from "../proofs/reach-set.ts";
import type { ReachesChat } from "../proofs/reaches-chat.ts";
import { processLayer, Tier } from "../tiers.ts";

/**
 * Following a stream, and keeping the desktop viewer open: the long-running
 * operations' half that outlives any one proof.
 *
 * A long-running operation proves access when it starts, then keeps only ids.
 * It proves again, naming its values afresh, on each change of who reaches
 * what in its workspace (a `reach.changed` event), and ends once a proof is
 * refused, its session ends (a `session.ended` event) or its session expires.
 * What it sends is decided by its last proof alone: the entrypoint decides
 * nothing about who hears what.
 *
 * Two things keep it honest, apart from each other:
 *
 * - A watcher decides when it must end. It hears changes of reach and its
 *   session's end as they are published, and every `catchUp` also reads its
 *   session's row and the stored changes since it last looked, so one the bus
 *   never delivered, or a session deleted with no event, still ends it. It
 *   never waits for the client, and once it ends nothing more is sent, even
 *   what was ready to go.
 * - A stream reads the events it sends from the event store, in `seq` order
 *   with the stored changes of reach and session ends, each from where it
 *   last read: the bus only wakes it, and brings what isn't stored, such as a
 *   reply's text as it is written. So an event stored after a change of reach
 *   is decided by the proof made on that change, whichever arrived first, and
 *   one that isn't stored is decided only once what was stored before it
 *   arrived has been read.
 */
export interface Interface {
	/**
	 * What `reach`'s principal hears on its workspace's stream: the projects
	 * and bots of the workspace they reach, and those they don't.
	 */
	readonly hearingIn: <P, W>(reach: ReachSet<P, W>) => Effect.Effect<Hearing>;
	/** What `reach`'s principal hears on the chat's own stream: everything on it. */
	readonly hearingChat: <P, C>(reach: ReachesChat<P, C>) => Hearing;
	/** What the member hears on their own stream: everything on it. */
	readonly hearingOwn: <P>(isMember: IsMember<P>) => Hearing;
	/**
	 * The chat `chatId` names, by the id it is stored under, and its
	 * workspace: where a stream or viewer about the chat listens for changes
	 * of reach before it proves it reaches the chat. None for an id that isn't
	 * one, or that names no chat.
	 */
	readonly chatOf: (
		chatId: string,
	) => Effect.Effect<{ readonly id: string; readonly workspace: string } | undefined>;
	/**
	 * Follows `following.stream` from `following.since`, for as long as the
	 * scope is open and the follower may (see {@link Following}). Listens before
	 * it first proves, so no change of reach slips between; a first refusal
	 * fails it. The stream it returns ends once it must, dropping whatever it
	 * hadn't sent; a resume point that is gone gets a `reset` first.
	 */
	readonly follow: <E>(following: Following<E>) => Effect.Effect<Running<Delivery>, E, Scope.Scope>;
	/**
	 * Keeps a long-running operation that sends no events, such as the desktop
	 * viewer, for as long as the scope is open and `keeping.prove` succeeds.
	 * Proves once it is listening, failing with the refusal if that fails, so
	 * nothing slips between the operation's own proof and this. The effect it
	 * returns completes once the operation must end.
	 */
	readonly keep: <E>(keeping: Keeping<E>) => Effect.Effect<Effect.Effect<void>, E, Scope.Scope>;
	/**
	 * Tells the chat's other watchers the member is typing in it, as
	 * `member.typing`, an ephemeral event nobody resumes from.
	 */
	readonly reportTyping: <P, C>(
		canTakePart: CanTakePart<P, C>,
		isMember: IsMember<P>,
	) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Streams") {
	declare readonly [Tier]: "process";
}

/** How often a long-running operation catches up, which a test may shorten. */
export interface TimingInterface {
	/**
	 * How often its watcher reads its session's row and the stored changes of
	 * reach it listens for, and its stream reads what is stored for it: how
	 * long a change the bus never delivered, or a session deleted with no
	 * event, goes unnoticed at most.
	 */
	readonly catchUp: Duration.Input;
}

export const Timing = Context.Reference<TimingInterface>("@sugabots/core/Streams/Timing", {
	defaultValue: () => ({ catchUp: Duration.seconds(15) }),
});

/**
 * What one proof found a member may hear on a stream: ids, which outlive the
 * proof, kept until the stream proves again. Made only from proofs, by
 * {@link Interface.hearingIn}, {@link Interface.hearingChat} and
 * {@link Interface.hearingOwn}.
 */
export type Hearing =
	| {
			readonly kind: "workspace";
			readonly workspace: string;
			readonly projects: Reached;
			readonly bots: Reached;
	  }
	| { readonly kind: "chat"; readonly workspace: string; readonly chat: string }
	| { readonly kind: "own"; readonly member: string };

/**
 * Which of a workspace's projects, or bots, the member reaches, and which
 * they don't, as one proof found them. One in neither was made since.
 */
export interface Reached {
	readonly reached: ReadonlySet<string>;
	readonly unreached: ReadonlySet<string>;
}

/** A stream to follow, for a member, and how to prove again what they hear on it. */
export interface Following<E> {
	/** Who follows it: the end or expiry of their session ends it. */
	readonly principal: MemberSession;
	readonly stream: EventStream;
	/** The client's resume point: the `seq` of the last durable event it heard. */
	readonly since: number | undefined;
	/**
	 * The workspace whose changes of reach make it prove again, found before it
	 * first proves; none for a member's own stream, which every proof lets
	 * them hear.
	 */
	readonly workspace: string | undefined;
	/**
	 * Proves what the member hears, naming its values afresh each time: when it
	 * starts, and again on each change of reach. A refusal ends it.
	 */
	readonly prove: Effect.Effect<Hearing, E, Database>;
}

/** A long-running operation that sends nothing, for a member, and how to prove it again. */
export interface Keeping<E> {
	readonly principal: MemberSession;
	/** The workspace whose changes of reach make it prove again. */
	readonly workspace: string;
	/** Proves it may go on, naming its values afresh each time. A refusal ends it. */
	readonly prove: Effect.Effect<unknown, E, Database>;
}

/**
 * How many events a stream holds ready for its client before it waits for the
 * client to take them. What comes meanwhile stays in the event store.
 */
const READ_AHEAD = 16;

/** How many stored events a stream, or a watcher, reads at a time. */
const BATCH = 100;

/**
 * How many events that aren't stored, such as a reply's text as it is written,
 * a stream holds for a client that isn't taking them; past that they are
 * dropped, and the client reads the reply from its message instead.
 */
const UNSTORED_HELD = 256;

/** The events that change what a long-running operation may do: it proves again, or ends. */
const CONTROL_TYPES: ReadonlyArray<DurableEventType> = ["reach.changed", "session.ended"];

/** What wakes a stream: something stored to read, or an event that isn't stored. */
type Woken =
	| { readonly kind: "stored" }
	| { readonly kind: "unstored"; readonly delivery: EventBus.Delivery };

/** What a stream does with an event: send it, skip it, or end. */
type Outcome =
	| { readonly kind: "send"; readonly delivery: Delivery }
	| { readonly kind: "skip" }
	| { readonly kind: "end" };

const SKIP: Outcome = { kind: "skip" };
const END: Outcome = { kind: "end" };

/** Whether one proof lets a member hear an event: yes, no, or it can't say, for something made since. */
type Heard = "heard" | "unheard" | "unknown";

export const make = Effect.gen(function* () {
	const bus = yield* EventBus.Service;
	const store = yield* EventStore.Service;
	const { catchUp } = yield* Timing;
	const checkInterval = Duration.toMillis(catchUp) / 2;
	const operation = yield* serviceOperations<Interface>("Streams");

	/**
	 * Hands each delivery on `stream` to `heard` as the bus makes it, never
	 * waiting, until the scope closes, then unsubscribes; `stopped` once the
	 * bus stops delivering. The bus registers the subscriber when it is first
	 * read, which is before this returns, so nothing published afterwards is
	 * missed.
	 */
	const listen = (
		stream: EventStream,
		heard: (delivery: EventBus.Delivery) => void,
		stopped: () => void,
	) =>
		Effect.gen(function* () {
			const leaving = new AbortController();
			const deliveries = bus.subscribe(stream, { signal: leaving.signal })[Symbol.asyncIterator]();
			let next = deliveries.next();
			yield* Effect.addFinalizer(() =>
				Effect.promise(async () => {
					leaving.abort();
					// Runs the subscription's own clean-up, which unregisters it, wherever it stopped.
					await deliveries.return?.(undefined);
				}),
			);
			const pump = Effect.gen(function* () {
				while (true) {
					const read = yield* Effect.promise(() => next);
					if (read.done) return;
					heard(read.value);
					next = deliveries.next();
				}
			});
			yield* Effect.forkScoped(
				pump.pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: Effect.logError(`Listening to ${stream} failed`, cause),
					),
					Effect.ensuring(Effect.sync(stopped)),
				),
			);
		});

	/** The `seq` of the newest event on each of `streams`, from which reading them begins. */
	const latestOn = (streams: ReadonlyArray<EventStream>) =>
		Effect.forEach(streams, (stream) =>
			Effect.map(
				Effect.promise(() => store.latest(stream)),
				(since) => [stream, since] as const,
			),
		).pipe(Effect.map((entries) => new Map<EventStream, number>(entries)));

	/** Events stored on `feeds` since each one's `since`, in `seq` order, moving each `since` on. */
	const readOn = (
		feeds: Map<EventStream, number>,
		types: (stream: EventStream) => ReadonlyArray<DurableEventType> | undefined,
	) =>
		Effect.map(
			Effect.promise(() =>
				store.following(
					[...feeds].map(([stream, since]) => ({ stream, since, types: types(stream) })),
					BATCH,
				),
			),
			(rows) => {
				for (const row of rows) feeds.set(row.stream, row.seq);
				return rows;
			},
		);

	const lifeOf = Effect.fnUntraced(function* <Proven, E>(
		principal: MemberSession,
		prove: Effect.Effect<Proven, E, Database>,
	) {
		const ended = Deferred.makeUnsafe<void>();
		const end = Effect.asVoid(Deferred.succeed(ended, undefined));
		const reachChanged = yield* Queue.sliding<void>(1);
		const onEvent = (event: StreamEvent) => {
			if (event.type === "session.ended" && endsSession(event, principal)) stop();
			if (event.type === "reach.changed") Queue.offerUnsafe(reachChanged, undefined);
		};
		const stop = () => void Deferred.doneUnsafe(ended, Effect.void);
		const proveAgain = operation("follow", Effect.exit(prove)).pipe(
			Effect.tap((exit) => {
				if (Exit.isSuccess(exit)) return Effect.void;
				return Effect.andThen(
					end,
					Cause.hasFails(exit.cause)
						? Effect.void
						: Effect.logError("Proving a long-running operation again failed", exit.cause),
				);
			}),
		);
		return { ended, end, stop, reachChanged, onEvent, proveAgain };
	});

	const watch = <Proven, E>(
		principal: MemberSession,
		life: Effect.Success<ReturnType<typeof lifeOf<Proven, E>>>,
		controls: Map<EventStream, number>,
		expiresAt: Date,
		caughtUp: () => void,
	) =>
		Effect.gen(function* () {
			const session = Effect.gen(function* () {
				let expiry = expiresAt.getTime();
				let nextCheckAt = (yield* Clock.currentTimeMillis) + checkInterval;
				while (true) {
					const now = yield* Clock.currentTimeMillis;
					yield* Effect.sleep(Math.max(0, Math.min(nextCheckAt, expiry) - now));
					const checkedAt = yield* Clock.currentTimeMillis;
					if (checkedAt >= expiry) return;
					nextCheckAt = checkedAt + checkInterval;
					const refreshed = yield* Effect.raceFirst(
						operation("follow", expiryOf(principal)),
						Effect.sleep(Math.min(checkInterval, expiry - checkedAt)).pipe(
							Effect.andThen(life.end),
							Effect.as(undefined),
						),
					);
					if (refreshed === undefined) return;
					expiry = refreshed.getTime();
				}
			}).pipe(Effect.ensuring(life.end));
			yield* Effect.forkScoped(session);

			const checkReach = (changed: boolean) =>
				Effect.gen(function* () {
					while (true) {
						const rows = yield* readOn(controls, () => CONTROL_TYPES);
						for (const { event } of rows) {
							if (event.type === "session.ended" && endsSession(event, principal)) return false;
							if (event.type === "reach.changed") changed = true;
						}
						if (rows.length < BATCH) break;
					}
					caughtUp();
					return !changed || Exit.isSuccess(yield* life.proveAgain);
				});
			while (true) {
				const changed = yield* Effect.raceFirst(
					Queue.take(life.reachChanged).pipe(Effect.as(true)),
					Effect.sleep(checkInterval).pipe(Effect.as(false)),
				);
				const holds = yield* Effect.raceFirst(
					checkReach(changed),
					Effect.sleep(checkInterval).pipe(Effect.andThen(life.end), Effect.as(false)),
				);
				if (!holds) return;
			}
		}).pipe(Effect.ensuring(life.end), Effect.scoped, Effect.raceFirst(Deferred.await(life.ended)));

	/** The project the chat `chatId` is in, if it is in one. */
	const projectOfChat = (chatId: string) =>
		operation(
			"follow",
			query((db) =>
				db
					.select({ project: placedChat.projectId })
					.from(placedChat)
					.where(eq(placedChat.id, chatId))
					.limit(1),
			),
		).pipe(Effect.map(([row]) => row?.project ?? undefined));

	/**
	 * What `hearing` says of an event for `audience`, resolving a chat to its
	 * project, which never changes, through `projects`.
	 */
	const heardBy = (
		hearing: Hearing,
		audience: Audience.Group | undefined,
		projects: Map<string, string | undefined>,
	) =>
		Effect.gen(function* () {
			if (hearing.kind !== "workspace") return "heard" satisfies Heard;
			if (audience?.kind !== "chat") return hears(hearing, audience);
			if (!projects.has(audience.chat)) {
				projects.set(audience.chat, yield* projectOfChat(audience.chat));
			}
			const chatsProject = projects.get(audience.chat);
			return chatsProject === undefined
				? ("unheard" satisfies Heard)
				: hears(hearing, { kind: "project", project: chatsProject });
		});

	return Service.of({
		hearingIn: (reach) =>
			operation(
				"hearingIn",
				Effect.gen(function* () {
					const workspace = reach.workspace.value;
					const projects = yield* query((db) =>
						db
							.select({ id: project.id, reached: reach.reachesProject(project.id) })
							.from(project)
							.where(eq(project.workspaceId, workspace)),
					);
					const bots = yield* query((db) =>
						db
							.select({ id: bot.id, reached: reach.hearsAboutBot(bot.id) })
							.from(bot)
							.where(eq(bot.workspaceId, workspace)),
					);
					return {
						kind: "workspace",
						workspace,
						projects: reachedOf(projects),
						bots: reachedOf(bots),
					} satisfies Hearing;
				}),
			),

		hearingChat: (reach) => ({ kind: "chat", workspace: reach.workspace, chat: reach.chat.value }),

		hearingOwn: (isMember) => ({ kind: "own", member: isMember.member }),

		chatOf: (chatId) =>
			isUuid(chatId)
				? operation(
						"chatOf",
						query((db) =>
							db
								.select({ id: placedChat.id, workspace: placedChat.workspaceId })
								.from(placedChat)
								.where(eq(placedChat.id, chatId))
								.limit(1),
						).pipe(Effect.map(([row]) => row)),
					)
				: Effect.succeed(undefined),

		follow: ({ principal, stream, since, workspace, prove }) =>
			Effect.gen(function* () {
				const own = memberStream(principal.member);
				const reach = workspace === undefined ? undefined : workspaceStream(workspace);
				const controlStreams = [...new Set([...(reach ? [reach] : []), own])];
				const life = yield* lifeOf(principal, prove);
				const woken = yield* Queue.unbounded<Woken>();
				let storedPending = false;
				let unstoredHeld = 0;
				const wakeToRead = () => {
					if (storedPending) return;
					storedPending = true;
					Queue.offerUnsafe(woken, { kind: "stored" });
				};

				for (const listened of new Set([stream, ...controlStreams])) {
					yield* listen(
						listened,
						(delivery) => {
							const { event } = delivery;
							const controls =
								(listened === reach && event.type === "reach.changed") ||
								(listened === own && event.type === "session.ended");
							if (controls) life.onEvent(event);
							if (delivery.seq !== undefined) {
								wakeToRead();
							} else if (listened === stream && unstoredHeld < UNSTORED_HELD) {
								unstoredHeld += 1;
								Queue.offerUnsafe(woken, { kind: "unstored", delivery });
							}
						},
						life.stop,
					);
				}
				// Read from where the client left off, or what is stored next, and the
				// control streams from now: listening began first, so nothing between is missed.
				// 0 is the start `ready` or `reset` gave a stream with nothing stored:
				// everything stored on it since is what the client missed. Unlike a
				// stored `seq`, it can't show that some of that was pruned, which
				// only a client away longer than events are kept could miss.
				const resumes =
					since !== undefined &&
					(since === 0 || (yield* Effect.promise(() => store.has(stream, since))));
				const feeds = yield* latestOn([stream, ...controlStreams]);
				if (resumes) feeds.set(stream, since);
				const watcherControls = yield* latestOn(controlStreams);
				const first = yield* operation("follow", prove);
				const outbox = yield* Queue.bounded<Delivery, Cause.Done>(READ_AHEAD);
				const expiresAt = yield* operation("follow", expiryOf(principal));
				if (expiresAt === undefined || !listensWhereProved(first, workspace)) {
					yield* life.end;
					return { stream: Stream.empty, ended: Deferred.await(life.ended) };
				}
				// Both carry where the stream starts, so a client cut off before
				// anything else arrives resumes from there.
				const start = feeds.get(stream);
				if (since === undefined) {
					// Where the stream starts is known: whatever the client fetched before
					// this, it fetches again, and what changes after arrives here.
					yield* Queue.offer(outbox, { seq: start, event: streamEvent("ready") });
				} else if (!resumes) {
					// The resume point is gone, or was never this stream's: start again.
					yield* Queue.offer(outbox, { seq: start, event: streamEvent("reset") });
				}
				let current = first;
				const proveForSending = Effect.map(life.proveAgain, (exit) => {
					if (Exit.isFailure(exit)) return false;
					current = exit.value;
					return true;
				});
				const projects = new Map<string, string | undefined>();
				/** Projects and bots still unknown after proving again: made and gone since. */
				const gone = new Set<string>();
				/** What the last proof says of `delivery`, on the stream followed. */
				const decide = (delivery: EventBus.Delivery) =>
					Effect.gen(function* () {
						const { audience, event } = Audience.read(delivery.event);
						const sent: Outcome = { kind: "send", delivery: deliveryOf(delivery.seq, event) };
						if (event.type === "session.ended") {
							return endsSession(event, principal) ? END : SKIP;
						}
						if (event.type === "reach.changed" && !(yield* proveForSending)) return END;
						const heard = yield* heardBy(current, audience, projects);
						if (heard === "heard") return sent;
						if (heard === "unheard" || (audience && gone.has(idOf(audience)))) return SKIP;
						if (!(yield* proveForSending)) return END;
						const heardNow = yield* heardBy(current, audience, projects);
						if (heardNow === "heard") return sent;
						if (heardNow === "unknown" && audience) gone.add(idOf(audience));
						return SKIP;
					});
				/** What a stored event on a control stream other than the one followed does. */
				const control = (event: StreamEvent) =>
					Effect.gen(function* () {
						if (event.type === "session.ended") {
							return endsSession(event, principal) ? END : SKIP;
						}
						if (event.type === "reach.changed" && !(yield* proveForSending)) return END;
						return SKIP;
					});
				const send = (outcome: Outcome) =>
					Effect.gen(function* () {
						if (outcome.kind === "send") yield* Queue.offer(outbox, outcome.delivery);
						return outcome.kind !== "end";
					});
				/** Reads what is stored since it last read, in `seq` order, until none is left. */
				const readStored = Effect.gen(function* () {
					while (true) {
						const rows = yield* readOn(feeds, (feed) =>
							feed === stream ? undefined : CONTROL_TYPES,
						);
						for (const row of rows) {
							const outcome =
								row.stream === stream ? yield* decide(row) : yield* control(row.event);
							if (!(yield* send(outcome))) return false;
						}
						if (rows.length < BATCH) return true;
					}
				});
				const sending = Effect.gen(function* () {
					wakeToRead();
					while (true) {
						const next = yield* Queue.take(woken);
						if (next.kind === "unstored") {
							unstoredHeld -= 1;
							// A change of reach can be stored before its delivery reaches this
							// process, so what is stored is read first: someone taken out of a
							// chat gets none of its reply text from then on.
							if (!(yield* readStored)) return;
							if (!(yield* send(yield* decide(next.delivery)))) return;
							continue;
						}
						storedPending = false;
						if (!(yield* readStored)) return;
					}
				}).pipe(Effect.ensuring(life.end));
				yield* Effect.forkScoped(watch(principal, life, watcherControls, expiresAt, wakeToRead));
				yield* Effect.forkScoped(sending);
				// Nothing more goes once it has ended, even what was ready for a client slow to take it.
				const ended = Deferred.await(life.ended);
				return {
					stream: Stream.fromQueue(outbox).pipe(
						Stream.takeWhile(() => !Deferred.isDoneUnsafe(life.ended)),
						Stream.interruptWhen(ended),
					),
					ended,
				};
			}),

		keep: ({ principal, workspace, prove }) =>
			Effect.gen(function* () {
				const reach = workspaceStream(workspace);
				const own = memberStream(principal.member);
				const life = yield* lifeOf(principal, prove);

				yield* listen(
					reach,
					({ event }) => {
						if (event.type === "reach.changed") life.onEvent(event);
					},
					life.stop,
				);
				yield* listen(
					own,
					({ event }) => {
						if (event.type === "session.ended") life.onEvent(event);
					},
					life.stop,
				);
				const controls = yield* latestOn([reach, own]);
				yield* operation("keep", prove);
				const expiresAt = yield* operation("keep", expiryOf(principal));
				if (expiresAt === undefined) return Effect.void;
				yield* Effect.forkScoped(watch(principal, life, controls, expiresAt, () => {}));
				return Deferred.await(life.ended);
			}),

		reportTyping: (canTakePart, isMember) =>
			operation(
				"reportTyping",
				Effect.gen(function* () {
					const [typing] = yield* query((db) =>
						db.select(namedMemberColumns).from(member).where(eq(member.id, isMember.member)),
					);
					if (!typing) return;
					const chatId = canTakePart.reach.chat.value;
					const event = streamEvent("member.typing", { chatId, member: toMember(typing) });
					yield* Effect.promise(() => bus.publish(chatStream(chatId), event));
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps;

/** The ids of `rows` split by whether they are reached. */
function reachedOf(
	rows: ReadonlyArray<{ readonly id: string; readonly reached: boolean }>,
): Reached {
	return {
		reached: new Set(rows.filter((row) => row.reached).map((row) => row.id)),
		unreached: new Set(rows.filter((row) => !row.reached).map((row) => row.id)),
	};
}

/** Whether a workspace's `hearing` lets its member hear an event for `audience`, which names no chat. */
function hears(
	hearing: Extract<Hearing, { kind: "workspace" }>,
	audience: Exclude<Audience.Group, { kind: "chat" }> | undefined,
): Heard {
	if (audience === undefined) return "unheard";
	switch (audience.kind) {
		case "workspace":
			return "heard";
		case "project":
			return among(hearing.projects, audience.project);
		case "bot":
			return among(hearing.bots, audience.bot);
	}
}

function among(known: Reached, id: string): Heard {
	if (known.reached.has(id)) return "heard";
	return known.unreached.has(id) ? "unheard" : "unknown";
}

/** The id an audience names, other than the whole workspace. */
function idOf(audience: Audience.Group): string {
	switch (audience.kind) {
		case "chat":
			return audience.chat;
		case "project":
			return audience.project;
		case "bot":
			return audience.bot;
		case "workspace":
			return "";
	}
}

/** Whether `event`, a `session.ended`, ends `principal`'s session. */
function endsSession(event: StreamEvent, principal: MemberSession): boolean {
	return event.sessionId === principal.session;
}

/**
 * Whether the stream listens for changes of reach where its proof found
 * what it follows: a chat's own workspace, or the workspace followed.
 */
function listensWhereProved(hearing: Hearing, workspace: string | undefined): boolean {
	return hearing.kind === "own" || hearing.workspace === workspace;
}

/** An event as a stream sends it: with its `seq` when it is durable. */
function deliveryOf(seq: number | undefined, event: StreamEvent): Delivery {
	return seq === undefined ? { event } : { seq, event };
}

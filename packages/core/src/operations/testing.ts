import { randomUUID } from "node:crypto";
import type {
	FailureOf,
	InputOf,
	LongRunningOperationName,
	OutputOf,
	RequestOperationName,
} from "@sugabots/contracts/operations";
import { Cause, Clock, Context, Duration, Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import { Accounts } from "../accounts/accounts.ts";
import { chatServicesForTests } from "../chats/testing.ts";
import { noComputers } from "../computers/testing.ts";
import { EventBus } from "../database/events/bus.ts";
import { EventStore } from "../database/events/store.ts";
import { inMemoryEventStore } from "../database/events/testing.ts";
import { runOnPostgres, type TestInfrastructure } from "../database/testing.ts";
import { Email } from "../email/email.ts";
import type { Principal } from "../principal.ts";
import { Models } from "../providers/models/models.ts";
import { unusedModel } from "../providers/models/testing.ts";
import type { Egress } from "../providers/network/egress.ts";
import { ServerSettings } from "../server-settings/server-settings.ts";
import { Streams } from "../streams/streams.ts";
import { unimplemented } from "../testing.ts";
import { layer } from "./layer.ts";
import { Operations } from "./registry.ts";

/** Calls the operation `name` with `input` for `principal`, as one request, against the test database. */
export type CallOperation = <Name extends RequestOperationName>(
	principal: Principal,
	name: Name,
	input: InputOf<Name>,
) => Promise<OutputOf<Name>>;

export function operationOutcome<Name extends RequestOperationName>(
	call: CallOperation,
	principal: Principal,
	name: Name,
	input: InputOf<Name>,
): Promise<string> {
	return requestOutcome(call(principal, name, input));
}

export async function requestOutcome(request: Promise<unknown>): Promise<string> {
	try {
		await request;
		return "ok";
	} catch (failure) {
		if (
			typeof failure === "object" &&
			failure !== null &&
			"_tag" in failure &&
			typeof failure._tag === "string"
		) {
			return failure._tag;
		}
		throw failure;
	}
}

/** The chat services the operations are built over, as `chatServicesForTests` composes them. */
export type ChatServicesForTests = Awaited<ReturnType<typeof chatServicesForTests>>;

/**
 * What `servedOperations` builds the operations over, beyond the test
 * infrastructure: what `index.ts` provides them. Each has a default for cases
 * about none of it.
 */
export interface ServedOver {
	/**
	 * The chat services, which the registry also takes `WorkspaceTimeZone`
	 * from; by default ones whose events go nowhere a case reads.
	 */
	readonly chats?: ChatServicesForTests;
	/** The internet, as operations reach it; by default nothing, so any request dies. */
	readonly egress?: Layer.Layer<Egress.Service>;
	/**
	 * Stands in for the test infrastructure's server settings: for a server with
	 * a content origin, or served at another address, which GitHub apps are made with.
	 */
	readonly serverSettings?: ServerSettings.Interface;
	/** How the operations send email; by default to nobody. */
	readonly email?: Email.Interface;
	/**
	 * Who may have an account, built over the test infrastructure; by default
	 * accounts that need no verified email, as a server's don't unless it is set
	 * to require one, and whose every method dies.
	 */
	readonly accounts?: Layer.Layer<Accounts.Service, never, TestInfrastructure>;
	/**
	 * The bus the operations publish to; by default one in memory, which the
	 * default chat services publish to as well.
	 */
	readonly bus?: Layer.Layer<EventBus.Service>;
	/** The models a turn's model request asks; by default none, so any request fails. */
	readonly models?: Models.Interface;
	/**
	 * How often streams and the desktop viewer catch up on what the bus may
	 * have missed; by default as a server does.
	 */
	readonly streamsTiming?: Streams.TimingInterface;
	readonly clock?: Clock.Clock;
}

/** Email that goes nowhere, for cases that send some but read none. */
const unsentEmail = Email.Service.of({ send: () => Effect.void });

/**
 * The operation registry with every domain's services under it, over the test
 * infrastructure, computers nobody makes and what `over` gives, as an
 * entrypoint calls it. Call it from `beforeAll`, so a file whose cases skip
 * without a database never connects. A failure rejects with the operation's
 * own error. Its services stay built for the rest of the file.
 */
export async function servedOperations(over: ServedOver = {}): Promise<CallOperation> {
	return (await servedRegistry(over)).call;
}

/**
 * Starts the long-running operation `name` with `input` for `principal`, as
 * its entrypoint does, against the test database. Rejects with its refusal
 * as it starts; otherwise answers what it yields, until it ends or the case
 * closes it.
 */
export type FollowOperation = <Name extends LongRunningOperationName>(
	principal: Principal,
	name: Name,
	input: InputOf<Name>,
) => Promise<Following<OutputOf<Name>>>;

/** A long-running operation a case follows. */
export interface Following<Output> {
	/**
	 * What it yields next, or `ended` once it has ended. Rejects when nothing
	 * comes within `within`.
	 */
	readonly next: (within?: Duration.Input) => Promise<Output | "ended">;
	/**
	 * Whether it yields nothing more for `within`: anything it yields
	 * meanwhile is taken, and answered.
	 */
	readonly quiet: (within?: Duration.Input) => Promise<Output | "ended" | "quiet">;
	/** Leaves it, as its caller hanging up does. */
	readonly close: () => Promise<void>;
}

/** How long a case waits for a long-running operation to yield, by default. */
const FOLLOW_WAIT = Duration.seconds(5);

/** How long a case watches a long-running operation yield nothing, by default. */
const QUIET_WAIT = Duration.millis(300);

/**
 * The registry, as {@link servedOperations} builds it, with its long-running
 * operations as well: `follow` starts one on the same services, so it hears
 * what `call`'s operations change, and takes what it yields as it comes;
 * `longRunning` is the registry's own, for a case that reads at its own pace.
 */
export async function servedRegistry(over: ServedOver = {}): Promise<{
	call: CallOperation;
	follow: FollowOperation;
	longRunning: Operations.LongRunningInterface;
}> {
	const withClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		over.clock ? Effect.provideService(effect, Clock.Clock, over.clock) : effect;
	const built = await buildOperationRegistries(over);
	const operations = Context.get(built, Operations.Service);
	const longRunning = Context.get(built, Operations.LongRunning);
	return {
		longRunning,
		call: (principal, name, input) =>
			runOnPostgres(
				withClock(operations[name](principal, input, { kind: "request", request: randomUUID() })),
			),
		follow: (principal, name, input) =>
			runOnPostgres(
				Effect.gen(function* () {
					const scope = yield* Scope.make();
					const started = yield* Effect.exit(
						Scope.provide(scope)(
							longRunning[name](principal, input, { kind: "request", request: randomUUID() }),
						),
					);
					if (Exit.isFailure(started)) {
						yield* Scope.close(scope, Exit.void);
						return yield* Effect.failCause(started.cause as Cause.Cause<FailureOf<typeof name>>);
					}
					const yielded = yield* Queue.unbounded<OutputOf<typeof name>, Cause.Done>();
					yield* Stream.runForEach(started.value.stream, (value) =>
						Queue.offer(yielded, value),
					).pipe(Effect.ensuring(Queue.end(yielded)), Effect.forkIn(scope));
					/** What it yields next, `ended` once it has, or `quiet` after `within`. */
					const take = (within: Duration.Input) =>
						Queue.take(yielded).pipe(
							Effect.catchIf(Cause.isDone, () => Effect.succeed("ended" as const)),
							Effect.timeoutOrElse({
								duration: within,
								orElse: () => Effect.succeed("quiet" as const),
							}),
						);
					const following: Following<OutputOf<typeof name>> = {
						next: async (within = FOLLOW_WAIT) => {
							const taken = await Effect.runPromise(withClock(take(within)));
							if (taken === "quiet") throw new Error(`${name} yielded nothing in time`);
							return taken;
						},
						quiet: (within = QUIET_WAIT) => Effect.runPromise(withClock(take(within))),
						close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
					};
					return following;
				}).pipe(withClock),
			),
	};
}

export async function operationsForTests(over: ServedOver = {}): Promise<Operations.Interface> {
	return Context.get(await buildOperationRegistries(over), Operations.Service);
}

async function buildOperationRegistries(over: ServedOver) {
	const bus = EventBus.inProcess({ store: inMemoryEventStore() });
	const chats = over.chats ?? (await chatServicesForTests(bus));
	const outside = Layer.mergeAll(
		noComputers,
		Layer.succeedContext(chats),
		over.egress ?? Layer.empty,
		over.serverSettings ? Layer.succeed(ServerSettings.Service, over.serverSettings) : Layer.empty,
		Layer.succeed(Email.Service, over.email ?? unsentEmail),
		over.accounts ?? unimplemented(Accounts.Service, { requireEmailVerification: false }),
		over.bus ?? Layer.succeed(EventBus.Service, bus),
		Layer.succeed(Models.Service, over.models ?? unusedModel()),
		// Streams read what they send from the events stored in the test database.
		EventStore.layer,
		over.streamsTiming ? Layer.succeed(Streams.Timing, over.streamsTiming) : Layer.empty,
	);
	return runOnPostgres(
		Effect.gen(function* () {
			return yield* Layer.buildWithScope(layer.pipe(Layer.provide(outside)), yield* Scope.make());
		}),
	);
}

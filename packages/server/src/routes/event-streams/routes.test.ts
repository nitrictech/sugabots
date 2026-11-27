import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { EVENT_VERSION, type EventType, type StreamEvent } from "@sugabots/contracts";
import { BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { LongRunningOperationName } from "@sugabots/contracts/operations";
import type { Delivery } from "@sugabots/contracts/operations/events";
import { Operations } from "@sugabots/core/operations/registry";
import type { MemberSession } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { type Cause, Context, Deferred, Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	createTestApp,
	identifiedBy,
	type MemberResolver,
	sessionTokenIn,
	signedInWith,
	type TestApp,
	testRoutes,
} from "../../http/app.test-support.ts";
import { StreamTiming, type Timing } from "./routes.ts";

/**
 * The event stream entrypoint, driven through `createTestApp`: no socket, no
 * database, but a real Response whose body is parsed the way a client parses
 * it. Each stream is a stand-in for the long-running operation it follows,
 * whose events a case hands it; who hears what is the operation's, and
 * `core/src/streams/` tests it.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-00000000000a";
const CHAT = "0199a3a0-0000-7000-8000-00000000000b";

function rawEvent<const T extends EventType>(
	type: T,
	data: Record<string, unknown> = {},
): StreamEvent & { type: T } {
	return { ...data, v: EVENT_VERSION, type };
}

const signedIn = {
	id: "0199a3a0-0000-7000-8000-0000000000ff",
	email: "sam@example.com",
	name: "Sam",
	image: null,
};

const resolveMember: MemberResolver = async (headers) =>
	sessionTokenIn(headers) === "good-token" ? signedIn : null;

/** One call of a follow operation, as the stand-in saw it. */
interface Followed {
	readonly name: LongRunningOperationName;
	readonly principal: MemberSession;
	readonly input: unknown;
	/** Hands the stream an event, as the operation yields one. */
	readonly yields: (delivery: Delivery) => Promise<void>;
	/** Ends the stream, as the operation does once it must. */
	readonly ends: () => Promise<void>;
	/** Whether the scope the operation was given is still open. */
	readonly open: () => boolean;
}

/**
 * The app over stand-in follow operations, which record each call in
 * `followed`.
 */
function server({
	startup = Effect.void,
	timing = {},
}: {
	startup?: Effect.Effect<void, never, Scope.Scope>;
	timing?: Partial<Timing>;
} = {}) {
	const followed: Followed[] = [];
	const follow = (name: LongRunningOperationName) => (principal: unknown, input: unknown) =>
		Effect.gen(function* () {
			const queue = yield* Queue.bounded<Delivery, Cause.Done>(16);
			const ended = yield* Deferred.make<void>();
			let open = true;
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					open = false;
				}),
			);
			followed.push({
				name,
				principal: principal as MemberSession,
				input,
				yields: (delivery) => Effect.runPromise(Queue.offer(queue, delivery)).then(() => {}),
				ends: () => Effect.runPromise(Deferred.succeed(ended, undefined)).then(() => {}),
				open: () => open,
			});
			yield* startup;
			return { stream: Stream.fromQueue(queue), ended: Deferred.await(ended) };
		});
	const services = Layer.mergeAll(
		identifiedBy(resolveMember),
		unimplemented(Operations.LongRunning, {
			"events.followWorkspace": follow("events.followWorkspace"),
			"events.followChat": follow("events.followChat"),
			// A member's own stream refuses nobody behind `Session`.
			"events.followOwn": (principal, input) =>
				Effect.orDie(follow("events.followOwn")(principal, input)),
		}),
		unimplemented(Operations.Service, { "workspaces.list": () => Effect.succeed([]) }),
		Layer.succeed(StreamTiming, { ...StreamTiming.defaultValue(), ...timing }),
	);
	return { app: createTestApp(services), services, followed };
}

interface Frame {
	event?: string;
	id?: string;
	data?: unknown;
	comment?: string;
}

/**
 * Opens a stream and reads frames off it until `count` have arrived, then hangs
 * up — which is what a client closing a tab does, and what the next `open` with
 * a `Last-Event-ID` resumes from.
 */
async function open(
	app: TestApp,
	path: string,
	{ lastEventId, token = "good-token" }: { lastEventId?: string; token?: string } = {},
) {
	const response = await app.request(path, {
		headers: {
			...signedInWith(token),
			...(lastEventId ? { "last-event-id": lastEventId } : {}),
		},
	});

	const reader = response.body?.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	return {
		response,
		/** Reads until `count` frames have arrived. Rejects if the stream ends first. */
		async take(count: number): Promise<Frame[]> {
			const frames: Frame[] = [];

			while (frames.length < count) {
				const chunk = await reader?.read();
				if (!chunk || chunk.done) {
					throw new Error(`stream ended after ${frames.length} of ${count} frames`);
				}

				buffer += decoder.decode(chunk.value, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					frames.push(parseFrame(buffer.slice(0, boundary)));
					buffer = buffer.slice(boundary + 2);
					boundary = buffer.indexOf("\n\n");
				}
			}

			return frames;
		},
		close: () => reader?.cancel(),
	};
}

function parseFrame(raw: string): Frame {
	const frame: Frame = {};

	for (const line of raw.split("\n")) {
		if (line.startsWith(":")) {
			frame.comment = line.slice(1).trim();
		} else if (line.startsWith("event:")) {
			frame.event = line.slice(6).trim();
		} else if (line.startsWith("id:")) {
			frame.id = line.slice(3).trim();
		} else if (line.startsWith("data:")) {
			frame.data = JSON.parse(line.slice(5).trim());
		}
	}

	return frame;
}

describe("following", () => {
	it("follows each stream as its operation, for the member whose session the request carries", async () => {
		const { app, followed } = server();
		const streams = await Promise.all([
			open(app, `/workspaces/${WORKSPACE}/events`),
			open(app, `/chats/${CHAT}/events`),
			open(app, "/me/events"),
		]);

		expect(
			followed.map(({ name, principal, input }) => ({ name, member: principal.member, input })),
		).toEqual([
			{
				name: "events.followWorkspace",
				member: signedIn.id,
				input: { workspace: WORKSPACE, since: undefined },
			},
			{ name: "events.followChat", member: signedIn.id, input: { chatId: CHAT, since: undefined } },
			{ name: "events.followOwn", member: signedIn.id, input: { since: undefined } },
		]);
		await Promise.all(streams.map((stream) => stream.close()));
	});

	// A 403 would tell someone the chat or workspace exists, even though they cannot follow it.
	it.each([
		[`/workspaces/${WORKSPACE}/events`, new ResourceHidden({ resource: "workspace" })],
		[`/workspaces/${WORKSPACE}/events`, new BotCannotReach({ resource: "workspace" })],
		[`/chats/${CHAT}/events`, new ResourceHidden({ resource: "chat" })],
		[`/chats/${CHAT}/events`, new BotCannotReach({ resource: "chat" })],
	])("answers 404 from %s when following is refused with %o", async (path, refusal) => {
		const app = createTestApp(
			Layer.merge(
				identifiedBy(resolveMember),
				unimplemented(Operations.LongRunning, {
					"events.followWorkspace": () => Effect.fail(refusal),
					"events.followChat": () => Effect.fail(refusal),
				}),
			),
		);

		const response = await app.request(path, { headers: signedInWith("good-token") });

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			_tag: "NotFound",
			message: refusal.userMessage,
			error: { _tag: refusal._tag },
		});
	});

	it("answers 401 to somebody who isn't signed in, and follows nothing", async () => {
		const { app, followed } = server();

		expect(
			(await app.request(`/chats/${CHAT}/events`, { headers: signedInWith("bad") })).status,
		).toBe(401);
		expect(followed).toEqual([]);
	});

	it("passes the client's Last-Event-ID on as where to resume, and ignores one that isn't a sequence number", async () => {
		const { app, followed } = server();
		const resumed = await open(app, `/chats/${CHAT}/events`, { lastEventId: "41" });
		const fromEmpty = await open(app, `/chats/${CHAT}/events`, { lastEventId: "0" });
		const fresh = await open(app, `/chats/${CHAT}/events`, { lastEventId: "nonsense" });

		expect(followed.map(({ input }) => input)).toEqual([
			{ chatId: CHAT, since: 41 },
			{ chatId: CHAT, since: 0 },
			{ chatId: CHAT, since: undefined },
		]);
		await resumed.close();
		await fromEmpty.close();
		await fresh.close();
	});
});

describe("the stream", () => {
	it("releases the subscription and its pump when the client hangs up during startup", async () => {
		const listening = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const pumpEnded = Promise.withResolvers<void>();
		const { services, followed } = server({
			startup: Effect.gen(function* () {
				yield* Effect.addFinalizer(() => Effect.sync(() => released.resolve()));
				yield* Effect.never.pipe(
					Effect.ensuring(Effect.sync(() => pumpEnded.resolve())),
					Effect.forkScoped({ startImmediately: true }),
				);
				listening.resolve();
				return yield* Effect.never;
			}),
		});
		const scope = Scope.makeUnsafe();
		onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
		const context = await Effect.runPromise(
			Layer.buildWithScope(
				HttpRouter.serve(testRoutes(services), {
					disableLogger: true,
					disableListenLog: true,
				}).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 }))),
				scope,
			),
		);
		const address = Context.get(context, HttpServer.HttpServer).address;
		if (!("port" in address)) throw new Error("Expected a TCP server");
		const client = new AbortController();
		onTestFinished(() => client.abort());
		const response = fetch(`http://127.0.0.1:${address.port}/api/workspaces/${WORKSPACE}/events`, {
			headers: signedInWith("good-token"),
			signal: client.signal,
		}).catch((cause: unknown) => cause);
		await listening.promise;
		client.abort();
		expect(await response).toMatchObject({ name: "AbortError" });
		await Promise.all([released.promise, pumpEnded.promise]);
		expect(followed[0]?.open()).toBe(false);
	});

	it("declares itself as events and asks every hop not to buffer it", async () => {
		const { app } = server();
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);

		expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
		expect(stream.response.headers.get("cache-control")).toBe("no-store");
		expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
		await stream.close();
	});

	it("carries the event name, the payload and the id", async () => {
		const { app, followed } = server();
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);
		const event = rawEvent("chat.changed", { chatId: "c1" });
		await followed[0]?.yields({ seq: 7, event });

		expect((await stream.take(1))[0]).toEqual({ event: "chat.changed", id: "7", data: event });
		await stream.close();
	});

	it("sends an ephemeral event without an id, so it cannot become a resume point", async () => {
		const { app, followed } = server();
		const stream = await open(app, `/chats/${CHAT}/events`);
		await followed[0]?.yields({ event: rawEvent("message.delta", { text: "Hel" }) });

		const [delta] = await stream.take(1);
		expect(delta?.event).toBe("message.delta");
		expect(delta?.id).toBeUndefined();
		await stream.close();
	});

	it("ends the response when the operation ends", async () => {
		const { app, followed } = server();
		const stream = await open(app, `/chats/${CHAT}/events`);
		await followed[0]?.yields({ seq: 1, event: rawEvent("message.created") });
		await stream.take(1);
		await followed[0]?.ends();

		await expect(stream.take(1)).rejects.toThrow(/stream ended/i);
		await vi.waitFor(() => expect(followed[0]?.open()).toBe(false));
	});

	it("closes what the operation holds open when the client hangs up", async () => {
		const { app, followed } = server();
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);
		await followed[0]?.yields({ seq: 1, event: rawEvent("chat.changed") });
		await stream.take(1);
		expect(followed[0]?.open()).toBe(true);

		// Awaited on purpose: an un-awaited cancel is why this went unnoticed.
		await stream.close();
		await vi.waitFor(() => expect(followed[0]?.open()).toBe(false));
	});

	it("pings so a proxy does not close an idle stream", async () => {
		const { app } = server({ timing: { ping: 5 } });
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);

		expect((await stream.take(2)).map((frame) => frame.comment)).toEqual(["ping", "ping"]);
		await stream.close();
	});

	it("hangs up eventually, so a client that went away cannot hold a stream open", async () => {
		const { app, followed } = server({ timing: { maxAge: "10 millis" } });
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);

		await expect(stream.take(1)).rejects.toThrow(/stream ended/i);
		await vi.waitFor(() => expect(followed[0]?.open()).toBe(false));
	});
});

import type { Channel } from "@sugabots/contracts";
import type { Delivery, EventBus } from "@sugabots/core/database/events/bus";
import { Duration, Effect, Queue, Schedule, Stream } from "effect";
import { type Context, Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";
import type { ChannelAccess } from "./access.ts";

/**
 * The HTTP end of a stream: one channel, held open, until the client leaves or
 * the clock turns out. Everything about *what* is on the channel belongs to the
 * bus; this file is the transport and its housekeeping (ADR 001).
 *
 * It is a `Stream` rather than a callback with its own bookkeeping. The client
 * hanging up cancels the web stream, which interrupts the fibre, which runs the
 * subscription's finaliser — so there is no abort controller to wire, no
 * interval to clear, and no `finally` that has to be right.
 */

/** A comment line often enough to keep an idle stream out of a proxy's timeout. */
const PING = Duration.seconds(15);

/**
 * The server hangs up after this and the client reconnects with
 * `Last-Event-ID`, missing nothing. Bounds connections leaked by clients that
 * went away without the socket noticing.
 */
const MAX_AGE = Duration.minutes(30);

const STREAM_HEADERS = {
	"content-type": "text/event-stream",
	// Private workspace events must not be written to an intermediary cache.
	"cache-control": "no-store",
	// nginx otherwise buffers proxied responses and delays event delivery.
	"x-accel-buffering": "no",
};

export interface StreamOptions {
	ping?: Duration.Input;
	maxAge?: Duration.Input;
}

export interface EventRoutesOptions {
	resolveSession: SessionResolver;
	bus: EventBus;
	access: ChannelAccess;
	/** Runs the stream's Effect on the process runtime, so cancelling the response interrupts it. */
	run: RunHandler;
	stream?: StreamOptions;
}

/** The workspace and thread streams, with authorization resolved before streaming. */
export function createEventRoutes({
	resolveSession,
	bus,
	access,
	run,
	stream,
}: EventRoutesOptions) {
	const session = requireSession(resolveSession);
	return new Hono<AuthEnv>()
		.get("/workspaces/:workspaceId/events", session, async (c) => {
			const identity = c.get("session");
			const workspaceId = c.req.param("workspaceId");
			const channel = await access.workspace(identity, workspaceId);
			if (c.req.method === "HEAD" && channel) {
				return new Response(null, { headers: STREAM_HEADERS });
			}
			return streamChannel({
				c,
				bus,
				channel,
				run,
				options: stream,
				stillAuthorized: async () => (await access.workspace(identity, workspaceId)) === channel,
			});
		})
		.get("/threads/:threadId/events", session, async (c) => {
			const identity = c.get("session");
			const threadId = c.req.param("threadId");
			const channel = await access.thread(identity, threadId);
			if (c.req.method === "HEAD" && channel) {
				return new Response(null, { headers: STREAM_HEADERS });
			}
			return streamChannel({
				c,
				bus,
				channel,
				run,
				options: stream,
				stillAuthorized: async () => (await access.thread(identity, threadId)) === channel,
			});
		});
}

/** One event, as the wire format. */
function frame({ seq, event }: Delivery): string {
	// An ephemeral event carries no id, so it does not move the client's resume
	// point past a state change it never saw.
	const id = seq === undefined ? "" : `id: ${seq}\n`;
	return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Streams a channel to the caller.
 *
 * `channel` is what the route's authorisation resolved to, and `undefined`
 * means the caller may not have it. That is answered with 404 rather than 403:
 * a stream for a thread you cannot see should not confirm the thread exists.
 */
async function streamChannel<E extends AuthEnv>({
	c,
	bus,
	channel,
	run,
	options: { ping = PING, maxAge = MAX_AGE } = {},
	stillAuthorized,
}: {
	c: Context<E>;
	bus: EventBus;
	channel: Channel | undefined;
	run: RunHandler;
	options?: StreamOptions;
	/**
	 * Re-asked before every event. It is the only thing that notices access
	 * being revoked mid-stream, which is why it is required.
	 */
	stillAuthorized: () => Promise<boolean>;
}): Promise<Response> {
	if (!channel) {
		throw new HttpError("not_found", "No such stream");
	}

	const since = resumeFrom(c.req.header("last-event-id"));
	const maxAgeMillis = Duration.toMillis(Duration.fromInputUnsafe(maxAge));
	const ready = Promise.withResolvers<void>();

	// Abort wakes a parked bus iterator before its cleanup waits for it to finish.
	const subscribed = Stream.callback<string>(
		(queue) =>
			Effect.gen(function* () {
				const leaving = new AbortController();
				const expiry = setTimeout(() => leaving.abort(), maxAgeMillis);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						clearTimeout(expiry);
						leaving.abort();
					}),
				);

				void (async () => {
					try {
						for await (const delivery of bus.subscribe(channel, {
							since,
							signal: leaving.signal,
						})) {
							if (!(await stillAuthorized()) || leaving.signal.aborted) {
								break;
							}
							if (
								!(await Effect.runPromise(Queue.offer(queue, frame(delivery)), {
									signal: leaving.signal,
								}))
							) {
								break;
							}
						}
					} catch (failure) {
						if (!leaving.signal.aborted) {
							console.error(`Streaming ${channel} failed`, failure);
						}
					} finally {
						clearTimeout(expiry);
						Queue.endUnsafe(queue);
					}
				})();
				ready.resolve();
			}),
		{ bufferSize: 16 },
	);

	// Merged rather than written from a timer, so a ping is its own chunk and can
	// never land inside an event. `haltStrategy: "left"` ends the response when
	// the events end rather than pinging an empty channel forever.
	const withPings = Stream.merge(
		subscribed,
		Stream.fromEffectRepeat(Effect.succeed(": ping\n\n")).pipe(
			Stream.schedule(Schedule.spaced(ping)),
		),
		{ haltStrategy: "left" },
	);

	const body = await run(withPings.pipe(Stream.encodeText, Stream.toReadableStreamEffect()));
	// The response must not precede subscription setup, or immediate live events are lost.
	await ready.promise;

	return new Response(body, { headers: STREAM_HEADERS });
}

/**
 * `Last-Event-ID` is whatever the client sent, including nothing at all. Only a
 * positive integer is a resume point; anything else starts a fresh stream,
 * which is the same thing a first connection gets.
 */
function resumeFrom(header: string | undefined): number | undefined {
	if (!header) {
		return undefined;
	}

	const seq = Number(header);
	return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

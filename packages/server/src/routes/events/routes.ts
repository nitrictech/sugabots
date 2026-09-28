import type { Channel } from "@sugabots/contracts";
import { NotFound } from "@sugabots/contracts/http";
import type { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { EventBus } from "@sugabots/core/database/events/bus";
import { Context, Deferred, Duration, Effect, Option, Queue, Schedule, Stream } from "effect";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { ChannelAccess } from "./access.ts";

/**
 * The HTTP end of a stream: one channel, held open, until the client leaves or
 * the clock turns out. Everything about *what* is on the channel belongs to the
 * bus; this file is the transport and its housekeeping.
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
	// Private workspace events must not be written to an intermediary cache.
	"cache-control": "no-store",
	// nginx otherwise buffers proxied responses and delays event delivery.
	"x-accel-buffering": "no",
};

const STREAM_CONTENT_TYPE = "text/event-stream";

/** How often a stream pings, and how long it lives. */
export interface Timing {
	readonly ping: Duration.Input;
	readonly maxAge: Duration.Input;
}

/** The streams' timing, which a test may shorten. */
export const StreamTiming = Context.Reference<Timing>("@sugabots/server/StreamTiming", {
	defaultValue: () => ({ ping: PING, maxAge: MAX_AGE }),
});

/** The workspace and thread streams, with authorization resolved before streaming. */
export const eventRoutes = HttpApiBuilder.group(ServerApi, "events", (handlers) =>
	Effect.gen(function* () {
		const bus = yield* EventBus.Service;
		const access = yield* ChannelAccess.Service;
		const timing = yield* StreamTiming;
		const streamFor = (
			request: HttpServerRequest.HttpServerRequest,
			channelFor: () => Effect.Effect<Channel | undefined, never, CurrentActor.Service>,
		) =>
			Effect.gen(function* () {
				const channel = yield* channelFor();
				if (!channel) {
					return yield* new NotFound({ message: "No such stream" });
				}
				if (request.method === "HEAD") {
					return HttpServerResponse.empty({
						status: 200,
						headers: { ...STREAM_HEADERS, "content-type": STREAM_CONTENT_TYPE },
					});
				}
				return yield* streamChannel({
					bus,
					channel,
					since: resumeFrom(request.headers["last-event-id"]),
					timing,
					stillAuthorized: Effect.map(Effect.suspend(channelFor), (current) => current === channel),
				});
			}).pipe(asSessionUser);

		return handlers
			.handle("workspace", ({ params, request }) =>
				streamFor(request, () => access.workspace(params.workspace)),
			)
			.handle("thread", ({ params, request }) =>
				streamFor(request, () => access.thread(params.threadId)),
			);
	}),
);

/** One event, as the wire format. */
function frame({ seq, event }: EventBus.Delivery): string {
	// An ephemeral event carries no id, so it does not move the client's resume
	// point past a state change it never saw.
	const id = seq === undefined ? "" : `id: ${seq}\n`;
	return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Streams a channel the caller's authorisation resolved to.
 *
 * A channel the caller may not have is answered with 404 before this, rather
 * than 403: a stream for a thread you cannot see should not confirm the thread
 * exists.
 */
const streamChannel = Effect.fnUntraced(function* ({
	bus,
	channel,
	since,
	timing: { ping, maxAge },
	stillAuthorized,
}: {
	bus: EventBus.Interface;
	channel: Channel;
	since: number | undefined;
	timing: Timing;
	/**
	 * Re-asked before every event, as the actor the stream was opened for. It
	 * is the only thing that notices access being revoked mid-stream, which is
	 * why it is required.
	 */
	stillAuthorized: Effect.Effect<boolean, never, CurrentActor.Service>;
}) {
	const maxAgeMillis = Duration.toMillis(Duration.fromInputUnsafe(maxAge));
	const ready = yield* Deferred.make<void>();
	const runPromise = Effect.runPromiseWith(yield* Effect.context<CurrentActor.Service>());
	// Each re-check is a trace of its own, linked to the stream's request. As a
	// child of the request it would sit under a span that is not exported until
	// the stream closes, up to `maxAge` later.
	const streamSpan = yield* Effect.option(Effect.currentParentSpan);
	const stillAuthorizedFor = ({ seq, event }: EventBus.Delivery) =>
		runPromise(
			stillAuthorized.pipe(
				Effect.withSpan("EventStream.recheckAccess", {
					root: true,
					links: Option.toArray(streamSpan).map((span) => ({ span, attributes: {} })),
					attributes: {
						"event.channel": channel,
						"event.type": event.type,
						...(seq === undefined ? {} : { "event.seq": seq }),
					},
				}),
			),
		);

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
							if (!(await stillAuthorizedFor(delivery)) || leaving.signal.aborted) {
								break;
							}
							if (
								!(await runPromise(Queue.offer(queue, frame(delivery)), {
									signal: leaving.signal,
								}))
							) {
								break;
							}
						}
					} catch (failure) {
						if (!leaving.signal.aborted) {
							await runPromise(Effect.logError(`Streaming ${channel} failed`, failure));
						}
					} finally {
						clearTimeout(expiry);
						Queue.endUnsafe(queue);
					}
				})();
				Deferred.doneUnsafe(ready, Effect.void);
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

	// Started here rather than when the response is written, and not answered
	// until the subscription is set up, or events published straight after the
	// response arrives are lost.
	const body = yield* withPings.pipe(Stream.encodeText, Stream.toReadableStreamEffect());
	yield* Deferred.await(ready);

	return HttpServerResponse.stream(
		Stream.fromReadableStream({ evaluate: () => body, onError: (cause) => cause }),
		{ headers: STREAM_HEADERS, contentType: STREAM_CONTENT_TYPE },
	);
});

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

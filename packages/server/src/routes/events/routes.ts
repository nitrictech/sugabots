import type { Channel } from "@sugabots/contracts";
import { CurrentUser, NotFound } from "@sugabots/contracts/http";
import type { Database } from "@sugabots/core/database/database";
import type { Delivery, EventBus } from "@sugabots/core/database/events/bus";
import { Deferred, Duration, Effect, Option, Queue, Schedule, Stream } from "effect";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
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
	// Private workspace events must not be written to an intermediary cache.
	"cache-control": "no-store",
	// nginx otherwise buffers proxied responses and delays event delivery.
	"x-accel-buffering": "no",
};

const STREAM_CONTENT_TYPE = "text/event-stream";

export interface StreamOptions {
	ping?: Duration.Input;
	maxAge?: Duration.Input;
}

export interface EventRoutesOptions {
	bus: EventBus;
	access: ChannelAccess;
	stream?: StreamOptions;
}

/** The workspace and thread streams, with authorization resolved before streaming. */
export function eventRoutes({ bus, access, stream }: EventRoutesOptions) {
	const streamFor = (
		request: HttpServerRequest.HttpServerRequest,
		resolve: (user: CurrentUser["Service"]) => Effect.Effect<Channel | undefined, never, Database>,
	) =>
		Effect.gen(function* () {
			const user = yield* CurrentUser;
			const channel = yield* resolve(user);
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
				options: stream,
				stillAuthorized: Effect.suspend(() => resolve(user)).pipe(
					Effect.map((current) => current === channel),
				),
			});
		});

	return HttpApiBuilder.group(ServerApi, "events", (handlers) =>
		handlers
			.handle("workspace", ({ params, request }) =>
				streamFor(request, (user) => access.workspace({ user }, params.workspaceId)),
			)
			.handle("thread", ({ params, request }) =>
				streamFor(request, (user) => access.thread({ user }, params.threadId)),
			),
	);
}

/** One event, as the wire format. */
function frame({ seq, event }: Delivery): string {
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
	options: { ping = PING, maxAge = MAX_AGE } = {},
	stillAuthorized,
}: {
	bus: EventBus;
	channel: Channel;
	since: number | undefined;
	options?: StreamOptions | undefined;
	/**
	 * Re-asked before every event. It is the only thing that notices access
	 * being revoked mid-stream, which is why it is required.
	 */
	stillAuthorized: Effect.Effect<boolean, never, Database>;
}) {
	const maxAgeMillis = Duration.toMillis(Duration.fromInputUnsafe(maxAge));
	const ready = yield* Deferred.make<void>();
	const runPromise = Effect.runPromiseWith(yield* Effect.context<Database>());
	// Each re-check is a trace of its own, linked to the stream's request. As a
	// child of the request it would sit under a span that is not exported until
	// the stream closes, up to `maxAge` later.
	const streamSpan = yield* Effect.option(Effect.currentParentSpan);
	const stillAuthorizedFor = ({ seq, event }: Delivery) =>
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

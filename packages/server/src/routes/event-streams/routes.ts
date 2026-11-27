import { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { StreamEvent } from "@sugabots/contracts";
import { NotFound } from "@sugabots/contracts/http";
import type { Delivery } from "@sugabots/contracts/operations/events";
import type { Running } from "@sugabots/core/operations/operation";
import { Context, Deferred, Duration, Effect, Exit, Schedule, Scope, Stream } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { longRunningCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, memberOnly } from "../../http/errors.ts";

/**
 * The event stream entrypoint: each stream is the long-running operation that
 * follows it, held open as server-sent events until the client leaves, the
 * operation ends (the member stops reaching what it follows, or their session
 * ends or expires) or the clock turns out. Who hears what is the operation's
 * to decide; this file is the transport and its housekeeping.
 *
 * The operation's subscriptions and its proving again belong to a scope of
 * the stream's own, closed when the response ends: the client hanging up
 * cancels the web stream, which interrupts the fibre, which closes it.
 */

/** A comment line often enough to keep an idle stream out of a proxy's timeout. */
const PING = Duration.seconds(15);

/**
 * The server hangs up after this and the client reconnects with
 * `Last-Event-ID`, missing nothing. Bounds the streams held open by clients
 * that went away without the socket noticing.
 */
const MAX_AGE = Duration.minutes(30);

const STREAM_HEADERS = {
	// Private workspace events must not be written to an intermediary cache.
	"cache-control": "no-store",
	// nginx otherwise buffers proxied responses and delays event delivery.
	"x-accel-buffering": "no",
};

const STREAM_CONTENT_TYPE = "text/event-stream";

const streamRefusals = { ResourceHidden: NotFound, BotCannotReach: NotFound };

/** How often a stream pings, and how long it lives. */
export interface Timing {
	readonly ping: Duration.Input;
	readonly maxAge: Duration.Input;
}

/** The streams' timing, which a test may shorten. */
export const StreamTiming = Context.Reference<Timing>("@sugabots/server/StreamTiming", {
	defaultValue: () => ({ ping: PING, maxAge: MAX_AGE }),
});

/** The workspace, chat and personal streams, each its long-running operation. */
export const eventStreamRoutes = HttpApiBuilder.group(ServerApi, "eventStreams", (handlers) =>
	Effect.gen(function* () {
		const follow = yield* longRunningCaller;
		const timing = yield* StreamTiming;
		const streamed = <E, R>(
			following: Effect.Effect<Running<Delivery>, E, Scope.Scope | R>,
			source: object,
		) => respond(following, timing, source instanceof IncomingMessage);
		return handlers
			.handle("workspace", ({ params, request }) =>
				streamed(
					follow("events.followWorkspace", {
						workspace: params.workspace,
						since: resumeFrom(request.headers["last-event-id"]),
					}),
					request.source,
				).pipe(memberOnly, asHttpError(streamRefusals)),
			)
			.handle("chat", ({ params, request }) =>
				streamed(
					follow("events.followChat", {
						chatId: params.chatId,
						since: resumeFrom(request.headers["last-event-id"]),
					}),
					request.source,
				).pipe(memberOnly, asHttpError(streamRefusals)),
			)
			.handle("me", ({ request }) =>
				streamed(
					follow("events.followOwn", { since: resumeFrom(request.headers["last-event-id"]) }),
					request.source,
				).pipe(memberOnly),
			);
	}),
);

/**
 * Starts the operation in a scope of the stream's own, and answers with what
 * it yields, as server-sent events. A refusal as it starts closes the scope
 * and is the response; otherwise the scope closes once the response ends.
 * The operation listens before it returns, so nothing published straight
 * after the response arrives is lost.
 */
const respond = <E, R>(
	following: Effect.Effect<Running<Delivery>, E, Scope.Scope | R>,
	{ ping, maxAge }: Timing,
	node: boolean,
) =>
	Effect.suspend(() => {
		const scope = Scope.makeUnsafe();
		return Effect.gen(function* () {
			const { stream, ended } = yield* Scope.provide(scope)(following);
			const frames = Stream.merge(
				stream.pipe(Stream.map(({ seq, event }) => frame(seq, event))),
				Stream.fromEffectRepeat(Effect.succeed(": ping\n\n")).pipe(
					Stream.schedule(Schedule.spaced(ping)),
				),
			);
			const upstream = (yield* frames.pipe(
				Stream.encodeText,
				Stream.toReadableStreamEffect({ strategy: { highWaterMark: 0 } }),
			)).getReader();
			const cancelled = Deferred.makeUnsafe<void>();
			const transport = new AbortController();
			let finished = false;
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						Effect.runFork(
							Effect.raceAllFirst([
								ended.pipe(Effect.as("revoked" as const)),
								Effect.sleep(maxAge).pipe(Effect.as("expired" as const)),
								Deferred.await(cancelled).pipe(Effect.as("cancelled" as const)),
							]).pipe(
								Effect.tap((reason) =>
									Effect.sync(() => {
										finished = true;
										if (reason === "revoked") {
											const error = new Error("The event stream ended");
											controller.error(error);
											transport.abort(error);
										} else if (reason === "expired") {
											controller.close();
										}
									}),
								),
								Effect.ensuring(
									Effect.all(
										[
											Scope.close(scope, Exit.void),
											Effect.promise(() => upstream.cancel().catch(() => {})),
										],
										{ concurrency: "unbounded", discard: true },
									),
								),
							),
						);
					},
					async pull(controller) {
						try {
							const { value, done } = await upstream.read();
							if (!done && !finished) controller.enqueue(value);
						} catch (cause) {
							if (!finished) controller.error(cause);
							Deferred.doneUnsafe(cancelled, Effect.void);
						}
					},
					cancel() {
						finished = true;
						Deferred.doneUnsafe(cancelled, Effect.void);
						return Scope.close(scope, Exit.void).pipe(Effect.runPromise);
					},
				},
				{ highWaterMark: 0 },
			);
			// The Node pipeline also needs cancellation when it is waiting for the socket to drain.
			const writer = node ? Readable.fromWeb(body, { signal: transport.signal }) : body;
			if (writer instanceof Readable) writer.on("error", () => {});
			return HttpServerResponse.raw(writer, {
				headers: STREAM_HEADERS,
				contentType: STREAM_CONTENT_TYPE,
			});
		}).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
	});

/** One event, as the wire format. */
function frame(seq: number | undefined, event: StreamEvent): string {
	// An ephemeral event carries no id, so it does not move the client's resume
	// point past a state change it never saw.
	const id = seq === undefined ? "" : `id: ${seq}\n`;
	return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * `Last-Event-ID` is whatever the client sent, including nothing at all. Only a
 * positive integer is a resume point; anything else starts a fresh stream,
 * which is the same thing a first connection to the stream gets.
 */
function resumeFrom(header: string | undefined): number | undefined {
	if (!header) {
		return undefined;
	}

	const seq = Number(header);
	return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

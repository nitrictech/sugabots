import { resetEvent, type StreamEvent, streamEventSchema } from "@sugabots/contracts";
import { Api, type ApiFailure, InternalServerError } from "@sugabots/contracts/http";
import { type UserText, userText } from "@sugabots/errors";
import { Schema } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { createParser } from "eventsource-parser";
import { failureFromResponse } from "./errors.ts";

/**
 * Live updates, as an async iterable that reconnects.
 *
 * ```ts
 * for await (const event of client.events.chat(chatId)) { … }
 * ```
 *
 * It needs a `fetch` whose response body streams.
 *
 * A dropped connection is the normal case, not an error: the server hangs up
 * every thirty minutes on purpose. The loop below reconnects with
 * `Last-Event-ID` set to the last event that carried an id, and the server
 * replays what was missed. When it cannot resume from there, the server sends
 * `reset`. A connection with nothing to resume from starts with the server's
 * `ready`, sent once it knows where the stream starts. Either way the consumer
 * reloads what it shows. An event with an id that cannot be read yields a
 * `reset` here, and the next connection starts with `ready`.
 */

export interface EventStream extends AsyncIterable<StreamEvent> {
	/** Ends the stream. The iterator finishes; it does not throw. */
	close(): void;
}

export interface EventsApi {
	/** Chats, unread counts, bots and projects across one workspace. */
	workspace(workspaceId: string): EventStream;
	/** One chat's messages, turns and tool calls. */
	chat(chatId: string): EventStream;
	/** What is for the current user alone, such as their notifications. */
	me(): EventStream;
}

interface EventsApiOptions {
	baseUrl: string;
	fetch?: typeof globalThis.fetch;
	/** Backoff between reconnects, for tests. */
	retryMs?: number;
}

/** First reconnect delay. Doubles up to the cap, with jitter. */
const RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
/**
 * Far above any event the server sends, so the cap only stops a broken stream
 * from buffering without end. The largest events are tool calls, which carry
 * the call's stored input and output, escaped again by the event's own JSON.
 */
const MAX_EVENT_CHARS = 1024 * 1024;

export function createEventsApi({
	baseUrl,
	fetch = globalThis.fetch,
	retryMs = RETRY_MS,
}: EventsApiOptions): EventsApi {
	const urls = HttpApiClient.urlBuilder(Api, { baseUrl }).eventStreams;
	const open = (url: string): EventStream => createEventStream({ url, fetch, retryMs });

	return {
		workspace: (workspace) => open(urls.workspace({ params: { workspace } })),
		chat: (chatId) => open(urls.chat({ params: { chatId } })),
		me: () => open(urls.me()),
	};
}

interface StreamContext {
	url: string;
	fetch: typeof globalThis.fetch;
	retryMs: number;
}

function createEventStream(context: StreamContext): EventStream {
	const closing = new AbortController();
	const { signal } = closing;

	async function* iterate(): AsyncGenerator<StreamEvent> {
		let attempt = 0;
		let lastEventId: string | undefined;

		while (!signal.aborted) {
			let retryAfterMs = 0;
			try {
				const body = await connect(context, lastEventId, signal);
				for await (const message of readMessages(body)) {
					attempt = 0;

					const event = Schema.decodeUnknownResult(streamEventSchema)(parseJson(message.data));
					if (event._tag === "Success") {
						if (message.id !== undefined || event.success.type === "reset") {
							lastEventId = message.id;
						}
						yield event.success;
					} else if (message.id !== undefined) {
						lastEventId = undefined;
						yield resetEvent();
					}
				}
			} catch (error) {
				if (signal.aborted) {
					return;
				}
				// The session is gone, or the resource is: reconnecting cannot
				// help, and a silent retry loop would hide it. Anything else —
				// a dropped socket, a restart, a 503, a rate limit — is worth
				// waiting out.
				if (
					error instanceof StreamRefused &&
					(isPermanent(error.status) || (error.status >= 200 && error.status < 300))
				) {
					throw error.failure;
				}
				if (error instanceof StreamRefused) retryAfterMs = error.retryAfterMs;
			}
			if (!signal.aborted) {
				// The server's `Retry-After`, as with a 503 while it restarts or a 429,
				// is the least it asked for; the backoff may wait longer.
				await sleep(Math.max(backoff(context.retryMs, attempt++), retryAfterMs), signal);
			}
		}
	}

	return {
		[Symbol.asyncIterator]: iterate,
		close: () => closing.abort(),
	};
}

/**
 * A response that ended a connection, with the status it came with: whether
 * to reconnect is decided by the status, and what the caller sees is the
 * failure.
 */
class StreamRefused {
	constructor(
		readonly failure: ApiFailure,
		readonly status: number,
		/** How long the response's `Retry-After` asked to wait before trying again; 0 without one. */
		readonly retryAfterMs = 0,
	) {}
}

/** A successful response that is not a usable stream. Reconnecting would get the same. */
function malformed(message: UserText, status: number): StreamRefused {
	return new StreamRefused(new InternalServerError({ message }), status);
}

interface Message {
	id?: string;
	data: string;
}

/** One connection: everything it delivers, until the server or the client ends it. */
async function connect(
	{ url, fetch }: StreamContext,
	lastEventId: string | undefined,
	signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
	const response = await fetch(url, {
		signal,
		credentials: "include",
		headers: {
			accept: "text/event-stream",
			...(lastEventId ? { "last-event-id": lastEventId } : {}),
		},
	});

	if (!response.ok) {
		throw new StreamRefused(
			failureFromResponse(await response.json().catch(() => undefined), response.status),
			response.status,
			retryAfterMs(response.headers.get("retry-after"), Date.now()),
		);
	}
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "text/event-stream") {
		throw malformed(userText`The event stream returned an invalid content type`, response.status);
	}
	if (!response.body) {
		throw malformed(userText`The event stream returned no body`, response.status);
	}

	return response.body;
}

async function* readMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<Message> {
	// A manual reader rather than `for await` over the body: async iteration of
	// a ReadableStream is not available in every browser this has to run in.
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const ready: Message[] = [];
	let tooLarge = false;
	const parser = createParser({
		maxBufferSize: MAX_EVENT_CHARS,
		onEvent: ({ id, data }) => ready.push({ id, data }),
		onError: (error) => {
			if (error.type === "max-buffer-size-exceeded") tooLarge = true;
		},
	});

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			parser.feed(decoder.decode(value, { stream: true }));
			while (ready.length > 0) {
				yield ready.shift() as Message;
			}
			if (tooLarge) {
				throw malformed(userText`The event stream frame exceeded the size limit`, 200);
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

function parseJson(data: string): unknown {
	try {
		return JSON.parse(data);
	} catch {
		return undefined;
	}
}

/**
 * A failure reconnecting cannot fix. Everything else, 408 and 429 included, is
 * waited out — a rate limit is the one 4xx that asks you to come back later.
 */
function isPermanent(status: number): boolean {
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * The wait a `Retry-After` header asks for at `nowMs`: a number of seconds, or
 * an HTTP date. 0 without one, or with one that cannot be read.
 */
function retryAfterMs(header: string | null, nowMs: number): number {
	if (!header) return 0;
	const seconds = Number(header);
	const waitMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - nowMs;
	return Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0;
}

/** Exponential, capped, and jittered so a restart does not bring every client back at once. */
function backoff(base: number, attempt: number): number {
	const delay = Math.min(base * 2 ** attempt, MAX_RETRY_MS);
	return delay * (0.5 + Math.random() / 2);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};

		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

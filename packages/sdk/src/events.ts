import { resetEvent, type StreamEvent, streamEventSchema } from "@sugabots/contracts";
import { Schema } from "effect";
import { createParser } from "eventsource-parser";
import { ApiError, toApiError } from "./errors.ts";
import type { TokenStore } from "./tokens.ts";

/**
 * Live updates, as an async iterable that reconnects.
 *
 * ```ts
 * for await (const event of client.events.thread(threadId)) { … }
 * ```
 *
 * Not `EventSource`: it cannot send an `Authorization` header for bearer
 * clients. `fetch` plus a parser also turns in browsers, Electron, and Node.
 * React Native, whose fetch does not stream, uses `react-native-sse` against the
 * same routes.
 *
 * A dropped connection is the normal case, not an error: the server hangs up
 * every thirty minutes on purpose. The loop below reconnects with
 * `Last-Event-ID` and the server replays what was missed, so a consumer sees
 * one uninterrupted sequence of events and never learns a reconnect happened.
 */

export interface EventStreamOptions {
	/** Resume from here instead of starting live. Usually a remembered `lastEventId`. */
	lastEventId?: string;
	/** Ends the stream. Without one, iterate with `break` or call `close`. */
	signal?: AbortSignal;
}

export interface EventStream extends AsyncIterable<StreamEvent> {
	/** The last durable event seen, to resume from after this stream is gone. */
	readonly lastEventId: string | undefined;
	/** Ends the stream. The iterator finishes; it does not throw. */
	close(): void;
}

export interface EventsApi {
	/** Threads, unread counts, agents and pods across one workspace. */
	workspace(workspaceId: string, options?: EventStreamOptions): EventStream;
	/** One root thread and every thread under it. */
	thread(threadId: string, options?: EventStreamOptions): EventStream;
}

export interface EventsApiOptions {
	baseUrl: string;
	tokens?: TokenStore;
	fetch?: typeof globalThis.fetch;
	/** Backoff between reconnects, for tests. */
	retryMs?: number;
}

/** First reconnect delay. Doubles up to the cap, with jitter. */
const RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
const MAX_EVENT_CHARS = 64 * 1024;

export function createEventsApi({
	baseUrl,
	tokens,
	fetch = globalThis.fetch,
	retryMs = RETRY_MS,
}: EventsApiOptions): EventsApi {
	const open = (path: string, options: EventStreamOptions | undefined): EventStream =>
		createEventStream({ url: `${baseUrl}${path}`, tokens, fetch, retryMs, ...options });

	return {
		workspace: (workspaceId, options) =>
			open(`/workspaces/${encodeURIComponent(workspaceId)}/events`, options),
		thread: (threadId, options) => open(`/threads/${encodeURIComponent(threadId)}/events`, options),
	};
}

interface StreamContext extends EventStreamOptions, Pick<EventsApiOptions, "tokens"> {
	url: string;
	fetch: typeof globalThis.fetch;
	retryMs: number;
}

function createEventStream(context: StreamContext): EventStream {
	const closing = new AbortController();
	const signal = context.signal
		? AbortSignal.any([context.signal, closing.signal])
		: closing.signal;

	let lastEventId = context.lastEventId;

	async function* iterate(): AsyncGenerator<StreamEvent> {
		let attempt = 0;

		while (!signal.aborted) {
			try {
				const connection = await connect(context, lastEventId, signal);
				if (!connection) {
					return;
				}

				for await (const message of connection) {
					attempt = 0;

					const event = Schema.decodeUnknownResult(streamEventSchema)(parseJson(message.data));
					if (event._tag === "Success") {
						if (message.id !== undefined) {
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
				// The token is gone, or the resource is: reconnecting cannot
				// help, and a silent retry loop would hide it. Anything else —
				// a dropped socket, a restart, a 503, a rate limit — is worth
				// waiting out.
				if (
					error instanceof ApiError &&
					(isPermanent(error.status) || (error.status >= 200 && error.status < 300))
				) {
					throw error;
				}
			}
			if (!signal.aborted) {
				await sleep(backoff(context.retryMs, attempt++), signal);
			}
		}
	}

	return {
		[Symbol.asyncIterator]: iterate,
		get lastEventId() {
			return lastEventId;
		},
		close: () => closing.abort(),
	};
}

interface Message {
	id?: string;
	data: string;
}

/** One connection: everything it delivers, until the server or the client ends it. */
async function connect(
	{ url, tokens, fetch }: StreamContext,
	lastEventId: string | undefined,
	signal: AbortSignal,
): Promise<AsyncGenerator<Message> | undefined> {
	const token = tokens?.get();

	const response = await fetch(url, {
		signal,
		credentials: tokens ? "omit" : "include",
		headers: {
			accept: "text/event-stream",
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(lastEventId ? { "last-event-id": lastEventId } : {}),
		},
	});

	if (response.status === 204) {
		return undefined;
	}
	if (!response.ok) {
		throw toApiError(await response.json().catch(() => undefined), response.status);
	}
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "text/event-stream") {
		throw new ApiError(
			"internal",
			"The event stream returned an invalid content type",
			response.status,
		);
	}
	if (!response.body) {
		throw new ApiError("internal", "The event stream returned no body", response.status);
	}

	return readMessages(response.body);
}

async function* readMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<Message> {
	// A manual reader rather than `for await` over the body: async iteration of
	// a ReadableStream is not available in every browser this has to run in.
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const ready: Message[] = [];
	let buffered = "";
	let eventChars = 0;
	const parser = createParser({
		onEvent: ({ id, data }) => ready.push({ id, data }),
	});

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}

			buffered += decoder.decode(value, { stream: true });
			while (true) {
				const lineEnd = buffered.search(/[\r\n]/);
				if (lineEnd < 0 || (buffered[lineEnd] === "\r" && lineEnd === buffered.length - 1)) {
					break;
				}

				const delimiterLength =
					buffered[lineEnd] === "\r" && buffered[lineEnd + 1] === "\n" ? 2 : 1;
				const line = buffered.slice(0, lineEnd + delimiterLength);
				buffered = buffered.slice(lineEnd + delimiterLength);
				eventChars += line.length;
				if (eventChars > MAX_EVENT_CHARS) {
					throw new ApiError("internal", "The event stream frame exceeded the size limit", 200);
				}

				parser.feed(line);
				if (lineEnd === 0) {
					eventChars = 0;
				}
				while (ready.length > 0) {
					yield ready.shift() as Message;
				}
			}

			if (eventChars + buffered.length > MAX_EVENT_CHARS) {
				throw new ApiError("internal", "The event stream frame exceeded the size limit", 200);
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

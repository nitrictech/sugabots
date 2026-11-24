import { resetEvent, type StreamEvent, streamEventSchema } from "@sugabots/contracts";
import { type ApiFailure, InternalServerError } from "@sugabots/contracts/http";
import { type UserText, userText } from "@sugabots/errors";
import { Schema } from "effect";
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
 * replays what was missed. When it cannot resume from there, or an event with
 * an id cannot be read, the stream yields a `reset` event and starts live, so
 * the consumer reloads what it shows.
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
	const open = (path: string): EventStream =>
		createEventStream({ url: `${baseUrl}${path}`, fetch, retryMs });

	return {
		workspace: (workspaceId) => open(`/workspaces/${encodeURIComponent(workspaceId)}/events`),
		chat: (chatId) => open(`/chats/${encodeURIComponent(chatId)}/events`),
		me: () => open("/me/events"),
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
			try {
				const connection = await connect(context, lastEventId, signal);
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
			}
			if (!signal.aborted) {
				await sleep(backoff(context.retryMs, attempt++), signal);
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
): Promise<AsyncGenerator<Message>> {
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
		);
	}
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "text/event-stream") {
		throw malformed(userText`The event stream returned an invalid content type`, response.status);
	}
	if (!response.body) {
		throw malformed(userText`The event stream returned no body`, response.status);
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
					throw malformed(userText`The event stream frame exceeded the size limit`, 200);
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

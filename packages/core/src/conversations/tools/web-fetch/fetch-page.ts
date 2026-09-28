import { type EgressHttpClient, EgressRefused } from "../../../providers/network/egress.ts";
import { UserMessage } from "../../../user-message.ts";
import { readablePage } from "./readable.ts";

/**
 * Fetching one public web page for an agent to read.
 *
 * The page is fetched through the installation's egress policy, so a private
 * or reserved address is refused before a connection is made. Redirects are
 * followed by hand, a few hops at most, so that every hop meets the same
 * check. A page has a time budget and a size cap, and what comes back is cut
 * to a length a model can take in. HTML is reduced to its readable content;
 * plain text, Markdown, JSON and XML pass through as they are; anything else
 * is refused rather than dumped into the context as bytes.
 *
 * A plain `http:` address is fetched over `https:` instead. The egress client
 * refuses plain HTTP off private networks, and a public page that is only on
 * HTTP is rare enough that an upgrade serves better than a refusal.
 *
 * Every way a fetch can go wrong is an answer, not an error: the agent is
 * told why and can try another address or tell the person.
 */

export const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_CHARACTERS = 40_000;
const USER_AGENT = "Sugabots/1 (+https://github.com/nitrictech/agents)";

interface FetchedPage {
	/** As asked for. */
	url: string;
	/** Where the page was, after redirects. */
	finalUrl: string;
	title: string | null;
	contentType: string;
	/** Markdown for an HTML page; otherwise the body as text. */
	text: string;
	/** Whether `text` was cut to fit. */
	truncated: boolean;
}

/** Why a page was not fetched, as the model reads it and people see it among the reply's tool calls. */
export interface Refusal {
	ok: false;
	reason: UserMessage;
}

type PageOutcome = { ok: true; page: FetchedPage } | Refusal;

export type FetchPage = (url: string, signal?: AbortSignal) => Promise<PageOutcome>;

interface PageFetcherOptions {
	/** An unbound egress client, `createEgressHttpClient`. */
	fetch: EgressHttpClient;
	timeoutMs?: number;
	maxBytes?: number;
	maxCharacters?: number;
}

export function pageFetcher({
	fetch,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	maxBytes = DEFAULT_MAX_BYTES,
	maxCharacters = DEFAULT_MAX_CHARACTERS,
}: PageFetcherOptions): FetchPage {
	return async (requested, signal) => {
		const start = webUrl(requested);
		if (!start.ok) {
			return start;
		}
		const timeout = AbortSignal.timeout(timeoutMs);
		const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
		try {
			let current = start.url;
			for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
				const response = await fetch(current, {
					signal: stop,
					redirect: "manual",
					headers: {
						accept:
							"text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
						"user-agent": USER_AGENT,
					},
				});
				if (isRedirect(response.status)) {
					const location = response.headers.get("location");
					await response.body?.cancel();
					if (!location) {
						return refused(
							UserMessage.of`The server answered HTTP ${response.status} without saying where to go`,
						);
					}
					const next = webUrl(location, current);
					if (!next.ok) {
						return next;
					}
					current = next.url;
					continue;
				}
				if (!response.ok) {
					await response.body?.cancel();
					return refused(UserMessage.of`The server answered HTTP ${response.status}`);
				}
				return await readPage(response, requested, current, { maxBytes, maxCharacters });
			}
			return refused(UserMessage.of`Gave up after ${MAX_REDIRECTS} redirects`);
		} catch (cause) {
			if (signal?.aborted) {
				return refused(UserMessage.of`The turn was stopped before the page arrived`);
			}
			if (timeout.aborted) {
				return refused(UserMessage.of`No answer within ${timeoutMs / 1000} seconds`);
			}
			if (cause instanceof EgressRefused) return refused(cause.userMessage);
			// Anything else is a fault on our side or the network's: its details go to
			// the logs, and the model is told only that the page did not arrive.
			console.error(`Fetching ${requested} failed`, cause);
			return refused(UserMessage.of`The page could not be fetched`);
		}
	};
}

function refused(reason: UserMessage): Refusal {
	return { ok: false, reason };
}

function webUrl(value: string, base?: URL): { ok: true; url: URL } | Refusal {
	let url: URL;
	try {
		url = new URL(value, base);
	} catch {
		return refused(UserMessage.of`The URL is not valid`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return refused(UserMessage.of`Only http and https addresses can be fetched`);
	}
	url.protocol = "https:";
	return { ok: true, url };
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

type Kind = "html" | "text";

/** What the body is, by media type, or nothing if it is not text a model can read. */
function kindOf(mediaType: string): Kind | undefined {
	if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return "html";
	if (mediaType.startsWith("text/")) return "text";
	if (mediaType === "application/json" || mediaType.endsWith("+json")) return "text";
	if (mediaType === "application/xml" || mediaType.endsWith("+xml")) return "text";
	return undefined;
}

async function readPage(
	response: Response,
	requested: string,
	finalUrl: URL,
	limits: { maxBytes: number; maxCharacters: number },
): Promise<PageOutcome> {
	const contentType = response.headers.get("content-type") ?? "";
	const { mediaType, charset } = parseContentType(contentType);
	const kind = kindOf(mediaType);
	if (!kind) {
		await response.body?.cancel();
		// The media type is the server's own words, so it is not repeated.
		return refused(UserMessage.of`The page is of a type that cannot be read as text`);
	}
	const bytes = await readUpTo(response, limits.maxBytes);
	if (!bytes) {
		return refused(
			UserMessage.of`The page is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB`,
		);
	}
	const body = decode(bytes, charset);
	const readable =
		kind === "html" ? readablePage(body, finalUrl.href) : { title: null, markdown: body.trim() };
	const truncated = readable.markdown.length > limits.maxCharacters;
	return {
		ok: true,
		page: {
			url: requested,
			finalUrl: finalUrl.href,
			title: readable.title,
			contentType: mediaType,
			text: truncated ? readable.markdown.slice(0, limits.maxCharacters) : readable.markdown,
			truncated,
		},
	};
}

function parseContentType(header: string): { mediaType: string; charset: string | undefined } {
	const [type = "", ...parameters] = header.split(";");
	const charset = parameters
		.map((parameter) => parameter.trim())
		.find((parameter) => parameter.toLowerCase().startsWith("charset="))
		?.slice("charset=".length)
		.replace(/^"|"$/g, "");
	return { mediaType: type.trim().toLowerCase(), charset };
}

/** The whole body, or nothing once it has gone past `maxBytes`. */
async function readUpTo(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
	if (!response.body) {
		return new Uint8Array();
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maxBytes) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const joined = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined;
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
	try {
		return new TextDecoder(charset ?? "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { botPalettes } from "@sugabots/avatars/bot-colors";
import type { BotColor } from "@sugabots/contracts";
import { DesktopUnavailable } from "@sugabots/contracts/errors/computers";
import { type UserText, userText } from "@sugabots/errors";
import { Cache, Effect, Schema, Semaphore } from "effect";
import { Computers } from "../../../computers/computers.ts";
import { execWithPreparedFolders } from "../computer/folders.ts";
import type { Place, TurnComputer } from "../computer/tools.ts";
import type { Failed } from "../failed.ts";
import type { Image } from "../images.ts";
import playwrightTools from "./playwright-tools.json" with { type: "json" };

/**
 * The browser tools: Playwright MCP's, run in the computer of the project the
 * turn works in by a browser of the bot's own in each chat, on the
 * bot's own desktop there, so
 * members watching see what it does. The tools are offered from the list the
 * image's server was built with; the browser starts on the first call.
 */

/** What a browser tool gives back: the server's text, and any screenshots. */
interface BrowserResult {
	text: string;
	images?: readonly Image[];
}

/** A desktop and browser for one bot in one chat, started on first use. */
export interface BrowserSession {
	readonly calls: Semaphore.Semaphore;
	/** Calls `tool` in the browser, giving up on it when `abortSignal` aborts. */
	readonly call: (
		computer: Computers.Computer,
		tool: string,
		input: unknown,
		abortSignal: AbortSignal | undefined,
	) => Promise<BrowserResult | Failed>;
	readonly target: (
		computer: Computers.Computer,
		tool: string,
		input: Record<string, unknown>,
		signal: AbortSignal,
	) => Promise<BrowserTarget | undefined>;
	/** Lets go of the connection to the browser. The browser carries on for later turns. */
	readonly close: () => Promise<void>;
}

const SCREENSHOT_TOOL = "browser_take_screenshot";
const NO_BROWSER = userText`This computer's image has no desktop or browser. Its image needs sugabots-desktop, as Sugabots' default image has.`;

/** A bot in a chat, whose desktop there is drawn in the bot's colour. */
interface BotInChat {
	readonly chatId: string;
	readonly botId: string;
	readonly color: BotColor;
}

/** A bot browsing in a chat, in the way it was set to. */
interface BotBrowsing extends BotInChat {
	/**
	 * Whether it browses so members watching can follow: a cursor that moves to
	 * what it clicks, smooth scrolling, and typing at a typing pace. Slower.
	 */
	readonly naturalBrowsing: boolean;
}

/** The session's name for a bot in a chat: one desktop and browser each. */
function sessionName(turn: { chatId: string; botId: string }) {
	return `${turn.chatId}-${turn.botId}`;
}

/** A bot's desktop in a chat, running: where viewers reach it. */
interface Desktop {
	/** The server a viewer may click and type through. */
	readonly control: VncServer;
	/** The server a viewer may only watch through. */
	readonly watch: VncServer;
}

/** One of a desktop's VNC servers, which takes a WebSocket on its port. */
interface VncServer {
	readonly port: number;
	/** What it asks for: Sugabots' to know, never a member's. */
	readonly password: string;
}

/** A bot's browser in a chat, running on its desktop. */
interface Browser {
	/** Where its Playwright MCP server is. */
	readonly browserPort: number;
	/** Whether it had to start, so its tabs from before are gone. */
	readonly started: boolean;
}

/**
 * Starts the bot's desktop in the chat, without its browser, or finds it
 * running: what a member opening the desktop needs.
 */
export const startDesktop = (computer: Computers.Computer, place: Place, turn: BotInChat) =>
	Effect.map(
		desktopCommand(computer, place, turn, "desktop"),
		(reported): Desktop => ({
			control: { port: reported.viewer, password: reported.password },
			watch: { port: reported.watch, password: reported.watchPassword },
		}),
	);

/**
 * Starts the bot's browser in the chat, on its desktop, or finds them
 * running: what the bot's browser calls need. A member who opened the
 * desktop first meets the same desktop, and the same browser if the dock
 * started it.
 */
const startBrowser = (computer: Computers.Computer, place: Place, turn: BotInChat) =>
	Effect.flatMap(desktopCommand(computer, place, turn, "session"), (ports) =>
		ports.browser === undefined
			? Effect.fail(new DesktopUnavailable({ reason: NO_BROWSER }))
			: Effect.succeed<Browser>({
					browserPort: ports.browser,
					started: ports.started,
				}),
	);

/**
 * Runs `sugabots-desktop desktop` or `session` for the bot in the chat,
 * and reads the ports and passwords it reports.
 */
const desktopCommand = (
	computer: Computers.Computer,
	place: Place,
	turn: BotInChat,
	command: "desktop" | "session",
) =>
	Effect.gen(function* () {
		const directory = `${place.folder}/.browser/${turn.botId}`;
		const ran = yield* execWithPreparedFolders(
			computer,
			place,
			{ env: { HOME: place.home }, timeout: "60 seconds", maxOutputCharacters: 2_000 },
			`sugabots-desktop ${command} ${Computers.shellQuoted(sessionName(turn))} ${Computers.shellQuoted(`${directory}/profile`)} ${Computers.shellQuoted(directory)} --accent ${Computers.shellQuoted(botPalettes[turn.color].face)} --folder ${Computers.shellQuoted(place.folder)}`,
		);
		const reported: Record<string, string | undefined> = Object.fromEntries(
			ran.stdout.text
				.trim()
				.split(/\s+/)
				.map((pair) => pair.split("=")),
		);
		const viewer = Number(reported.viewer);
		const watch = Number(reported.watch);
		const password = reported.password;
		const watchPassword = reported["watch-password"];
		if (
			ran.exitCode !== 0 ||
			!Number.isInteger(viewer) ||
			!Number.isInteger(watch) ||
			password === undefined ||
			watchPassword === undefined
		) {
			return yield* new DesktopUnavailable({ reason: NO_BROWSER });
		}
		return {
			viewer,
			watch,
			browser: reported.browser === undefined ? undefined : Number(reported.browser),
			started: reported.started === "yes",
			password,
			watchPassword,
		};
	});

/** There is no desktop to reach, for `reason`. */
export { DesktopUnavailable };

export interface CachedBrowserSession {
	readonly id: string;
	readonly naturalBrowsing: boolean | undefined;
}

export function browserSession(
	run: TurnComputer["run"],
	place: Place,
	turn: BotBrowsing,
	providerId: string,
	sessions: Cache.Cache<string, CachedBrowserSession | undefined>,
): BrowserSession {
	interface ConnectedBrowser {
		client: Client;
		transport: StreamableHTTPClientTransport;
		key: string;
		naturalBrowsing: boolean | undefined;
		note?: UserText;
	}
	let connecting: Promise<ConnectedBrowser | Failed> | undefined;
	let told = false;

	const configureAndCacheSession = async (connected: ConnectedBrowser, signal?: AbortSignal) => {
		if (connected.naturalBrowsing !== turn.naturalBrowsing) {
			const accent = turn.naturalBrowsing ? botPalettes[turn.color].face : undefined;
			const result = await connected.client
				.callTool(
					{ name: RUN_CODE_TOOL, arguments: { code: naturalBrowsingCode(accent) } },
					undefined,
					{ signal },
				)
				.catch(() => undefined);
			// Playwright refuses to run code while a modal is open.
			connected.naturalBrowsing = result && !result.isError ? turn.naturalBrowsing : undefined;
		}
		const { sessionId } = connected.transport;
		await run(
			Cache.set(
				sessions,
				connected.key,
				sessionId === undefined
					? undefined
					: { id: sessionId, naturalBrowsing: connected.naturalBrowsing },
			),
		);
	};

	const connect = async (computer: Computers.Computer): Promise<ConnectedBrowser | Failed> => {
		const browser = await run(
			startBrowser(computer, place, turn).pipe(
				Effect.catchTag("DesktopUnavailable", (unavailable) =>
					Effect.succeed({ status: "failed" as const, error: unavailable.reason }),
				),
			),
		);
		if ("status" in browser) return browser;
		const endpoint = await run(computer.endpoint(browser.browserPort));
		const key = JSON.stringify([providerId, computer.id, sessionName(turn)]);
		// Pending modals belong to the MCP session that opened them, even when a step ends.
		const cached = browser.started ? undefined : await run(Cache.get(sessions, key));
		const openClient = async (session?: CachedBrowserSession) => {
			const client = new Client({ name: "sugabots", version: "1" });
			const transport = new StreamableHTTPClientTransport(new URL(`${endpoint.url}/mcp`), {
				requestInit: { headers: endpoint.headers },
				fetch: endpoint.fetch,
				sessionId: session?.id,
			});
			await client.connect(transport);
			if (session) {
				try {
					await client.ping();
				} catch (cause) {
					await client.close();
					throw cause;
				}
			}
			return { client, transport, key, naturalBrowsing: session ? session.naturalBrowsing : false };
		};
		const connected = await openClient(cached).catch((cause: unknown) => {
			if (cached && cause instanceof StreamableHTTPError && cause.code === 404) return openClient();
			throw cause;
		});
		await configureAndCacheSession(connected);
		return {
			...connected,
			...(browser.started && {
				note: userText`Your browser has just started, on your own desktop in the computer. Tabs from before, if any, are gone.`,
			}),
		};
	};

	const connectOnce = async (computer: Computers.Computer) => {
		connecting ??= connect(computer).catch((cause: unknown) => {
			connecting = undefined;
			if (cause instanceof Computers.Unavailable)
				return { status: "failed" as const, error: cause.userMessage };
			throw cause;
		});
		const connected = await connecting;
		if ("status" in connected) connecting = undefined;
		return connected;
	};

	return {
		calls: Semaphore.makeUnsafe(1),
		target: async (computer, tool, input, signal) => {
			const connected = await connectOnce(computer);
			if ("status" in connected) return undefined;
			if (handlesBrowserModal(tool))
				return readBrowserModalTarget(connected.client, connected.transport.sessionId, signal);
			const index =
				tool === "browser_tabs" &&
				(input.action === "close" || input.action === "select") &&
				typeof input.index === "number"
					? input.index
					: null;
			return readBrowserTarget(connected.client, index, signal);
		},
		call: async (computer, toolName, input, abortSignal) => {
			const connected = await connectOnce(computer);
			if ("status" in connected) return connected;
			const result = await connected.client.callTool(
				{ name: toolName, arguments: input as Record<string, unknown> },
				undefined,
				{ signal: abortSignal },
			);
			if (toolName === "browser_close" && !result.isError) {
				connecting = undefined;
				await run(Cache.invalidate(sessions, connected.key));
				try {
					await connected.transport.terminateSession();
				} catch (cause) {
					if (!(cause instanceof StreamableHTTPError && cause.code === 404))
						await run(Effect.logWarning("Terminating a browser's MCP session failed", cause));
				} finally {
					await connected.client.close();
				}
			}
			if (
				!result.isError &&
				handlesBrowserModal(toolName) &&
				connected.naturalBrowsing !== turn.naturalBrowsing
			)
				await configureAndCacheSession(connected, abortSignal);
			const note = told ? undefined : connected.note;
			told = true;
			return toBrowserResult(result.content, note);
		},
		close: async () => {
			const connected = await connecting?.catch(() => undefined);
			if (connected && !("status" in connected)) await connected.client.close();
		},
	};
}

const RUN_CODE_TOOL = "browser_run_code_unsafe";

function handlesBrowserModal(tool: string) {
	return tool === "browser_handle_dialog" || tool === "browser_file_upload";
}

const browserUrlSchema = Schema.NonEmptyString.check(Schema.isMaxLength(8_192));
const browserTargetSchema = Schema.Struct({
	browserTab: Schema.NonEmptyString,
	browserDocument: Schema.NonEmptyString,
	browserUrl: browserUrlSchema,
});
type BrowserModalTarget = {
	readonly browserTab: string;
	readonly browserUrl: string;
	readonly browserModal: string | null;
};
export type BrowserTarget = typeof browserTargetSchema.Type | BrowserModalTarget;

const decodeBrowserTarget = Schema.decodeUnknownOption(Schema.fromJsonString(browserTargetSchema));
const decodeBrowserUrl = Schema.decodeUnknownOption(browserUrlSchema);

async function readBrowserModalTarget(
	client: Client,
	sessionId: string | undefined,
	signal: AbortSignal,
): Promise<BrowserModalTarget | undefined> {
	const result = await client.callTool(
		{ name: "browser_tabs", arguments: { action: "list" } },
		undefined,
		{ signal },
	);
	if (result.isError) return undefined;
	const { text } = toBrowserResult(result.content, undefined);
	const [tabs = ""] = text.split(/\r?\n### /, 1);
	if (!/^### Result\r?\n/.test(tabs)) return undefined;
	const tab = /^- (\d+): \(current\) \[.*?\]\((.*)\)\r?$/m.exec(tabs);
	const url = decodeBrowserUrl(tab?.[2]);
	if (!tab || url._tag === "None") return undefined;
	const modal = /^### Modal state\r?\n([\s\S]+)/m.exec(text)?.[1];
	return {
		browserTab: createHash("sha256")
			.update(JSON.stringify([sessionId, tab[1]]))
			.digest("hex"),
		browserUrl: url.value,
		browserModal: modal ? createHash("sha256").update(modal).digest("hex") : null,
	};
}

async function readBrowserTarget(client: Client, index: number | null, signal: AbortSignal) {
	const result = await client.callTool(
		{
			name: RUN_CODE_TOOL,
			arguments: {
				code: `async (page) => {
					const index = ${JSON.stringify(index)};
					const tab = index === null ? page : page.context().pages()[index];
					if (!tab) return;
					const session = await tab.context().newCDPSession(tab);
					try {
						const { targetInfo } = await session.send("Target.getTargetInfo");
						const { frameTree: { frame } } = await session.send("Page.getFrameTree");
						return {
							browserTab: targetInfo.targetId,
							browserDocument: frame.loaderId,
							browserUrl: frame.url + (frame.urlFragment ?? ""),
						};
					} finally {
						await session.detach();
					}
				}`,
			},
		},
		undefined,
		{ signal },
	);
	if (result.isError) return undefined;
	const { text } = toBrowserResult(result.content, undefined);
	const json = /^### Result\r?\n([^\r\n]+)/.exec(text)?.[1];
	const parsed = decodeBrowserTarget(json);
	return parsed._tag === "Some" ? parsed.value : undefined;
}

/**
 * naturalBrowsingCode generates Playwright code to show a cursor in `accent`,
 * scroll smoothly and type at a typing pace. An undefined accent disables these.
 *
 * Each MCP session has its own browser context. The server shares the Locator
 * methods across sessions, so the wrappers check whether that context shows a cursor.
 */
function naturalBrowsingCode(accent: string | undefined) {
	return `async (page) => {
	const cursor = ${JSON.stringify(accent === undefined ? null : cursorOptions(accent))};
	const context = page.context();
	if (context.sugabotsShowCursor) context.off("page", context.sugabotsShowCursor);
	if (!cursor) {
		context.sugabotsShowCursor = undefined;
		await Promise.all(context.pages().map((tab) => tab.screencast.hideActions()));
		return;
	}
	const showCursor = (tab) => tab.screencast.showActions(cursor);
	context.sugabotsShowCursor = (tab) => showCursor(tab).catch(() => {});
	context.on("page", context.sugabotsShowCursor);
	await Promise.all(context.pages().map(showCursor));

	const TYPING_DELAY_MILLISECONDS = 70;
	// Long text is typed faster, so filling in a long field doesn't hold up a turn.
	const LONGEST_TYPING_MILLISECONDS = 6000;
	// A smooth scroll that had nowhere to go never says it ended.
	const LONGEST_SCROLL_MILLISECONDS = 1500;
	const Locator = Object.getPrototypeOf(page.locator("body"));
	if (Locator.sugabotsWrapped) return;
	Locator.sugabotsWrapped = true;
	const natural = (locator) => locator.page().context().sugabotsShowCursor !== undefined;
	const scrollSmoothlyTo = (locator) =>
		locator
			.evaluate(
				async (element, longest) => {
					const box = element.getBoundingClientRect();
					if (box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth) return;
					element.scrollIntoView({ behavior: "smooth", block: "center" });
					await new Promise((ended) => {
						addEventListener("scrollend", ended, { once: true });
						setTimeout(ended, longest);
					});
				},
				LONGEST_SCROLL_MILLISECONDS,
				{ timeout: LONGEST_SCROLL_MILLISECONDS * 2 },
			)
			// The action itself reports an element that isn't there.
			.catch(() => {});
	for (const name of ["click", "dblclick", "hover", "selectOption", "check", "uncheck", "setChecked"]) {
		const act = Locator[name];
		Locator[name] = async function (...args) {
			if (natural(this)) await scrollSmoothlyTo(this);
			return act.apply(this, args);
		};
	}
	const pressSequentially = Locator.pressSequentially;
	Locator.pressSequentially = async function (text, options = {}) {
		if (!natural(this)) return pressSequentially.call(this, text, options);
		await scrollSmoothlyTo(this);
		const delay = Math.min(TYPING_DELAY_MILLISECONDS, LONGEST_TYPING_MILLISECONDS / Math.max(text.length, 1));
		return pressSequentially.call(this, text, { delay, ...options });
	};
	const fill = Locator.fill;
	// Clicks into the field and types, as a member would.
	Locator.fill = async function (value, options = {}) {
		if (!natural(this) || value === "") return fill.call(this, value, options);
		await this.click(options);
		await fill.call(this, "", options);
		return this.pressSequentially(value, options);
	};
}`;
}

/** Playwright's cursor, in `accent`, as `page.screencast.showActions` takes it. */
function cursorOptions(accent: string) {
	return {
		cursor: "pointer",
		// How long the cursor's ring stays on what it's about to use, which Playwright waits for.
		duration: 700,
		style: {
			point: `width: 28px; height: 28px; border-radius: 50%; border: 3px solid ${accent}; background: ${accent}40`,
			highlight: `outline: 2px solid ${accent}cc; border-radius: 4px`,
			// Playwright's name for the action, such as getByRole('button'), which means nothing to members watching.
			title: "display: none",
		},
	};
}

function toBrowserResult(content: unknown, note: UserText | undefined): BrowserResult {
	const parts = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
	const text = parts
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string);
	const images = parts
		.filter((part) => part.type === "image" && typeof part.data === "string")
		.map((part) => ({
			data: part.data as string,
			mediaType: String(part.mimeType ?? "image/png"),
		}));
	return {
		text: [...(note ? [note] : []), ...text].join("\n\n"),
		...(images.length > 0 ? { images } : {}),
	};
}

/** One of the browser tools, as the image's server lists it. */
interface BrowserTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

/**
 * The browser tools a turn is offered, in the order the server lists them. A
 * model that can't take images isn't offered screenshots, and is given the
 * text of any other result alone.
 */
export function offeredBrowserTools(acceptsImages: boolean): readonly BrowserTool[] {
	return playwrightTools.filter((entry) => acceptsImages || entry.name !== SCREENSHOT_TOOL);
}

/** Whether `name` is a browser tool a turn whose model takes images, or not, is offered. */
export function isBrowserTool(name: string, acceptsImages: boolean): boolean {
	return offeredBrowserTools(acceptsImages).some((entry) => entry.name === name);
}

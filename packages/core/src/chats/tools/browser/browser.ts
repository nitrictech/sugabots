import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { botPalettes } from "@sugabots/avatars/bot-colors";
import type { BotColor } from "@sugabots/contracts";
import { DesktopUnavailable } from "@sugabots/contracts/errors/computers";
import { type UserText, userText } from "@sugabots/errors";
import { Effect } from "effect";
import { Computers } from "../../../computers/computers.ts";
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
	/** Calls `tool` in the browser, giving up on it when `abortSignal` aborts. */
	readonly call: (
		tool: string,
		input: unknown,
		abortSignal: AbortSignal | undefined,
	) => Promise<BrowserResult | Failed>;
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
		const ran = yield* computer.exec(
			`mkdir -p ${Computers.shellQuoted(place.home)} && sugabots-desktop ${command} ${Computers.shellQuoted(sessionName(turn))} ${Computers.shellQuoted(`${directory}/profile`)} ${Computers.shellQuoted(directory)} --accent ${Computers.shellQuoted(botPalettes[turn.color].face)} --folder ${Computers.shellQuoted(place.folder)}`,
			{ env: { HOME: place.home }, timeout: "60 seconds", maxOutputCharacters: 2_000 },
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

export function browserSession(
	turnComputer: TurnComputer,
	place: Place,
	turn: BotBrowsing,
): BrowserSession {
	let connecting: Promise<{ client: Client; note?: UserText } | Failed> | undefined;
	let told = false;

	const connect = async (): Promise<{ client: Client; note?: UserText } | Failed> => {
		const { computer } = await turnComputer.open();
		const browser = await turnComputer.run(
			startBrowser(computer, place, turn).pipe(
				Effect.catchTag("DesktopUnavailable", (unavailable) =>
					Effect.succeed({ status: "failed" as const, error: unavailable.reason }),
				),
			),
		);
		if ("status" in browser) return browser;
		const endpoint = await turnComputer.run(computer.endpoint(browser.browserPort));
		const client = new Client({ name: "sugabots", version: "1" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${endpoint.url}/mcp`), {
				requestInit: { headers: endpoint.headers },
			}),
		);
		if (turn.naturalBrowsing) await browseNaturally(client, botPalettes[turn.color].face);
		return browser.started
			? {
					client,
					note: userText`Your browser has just started, on your own desktop in the computer. Tabs from before, if any, are gone.`,
				}
			: { client };
	};

	return {
		call: async (toolName, input, abortSignal) => {
			connecting ??= connect().catch((cause: unknown) => {
				connecting = undefined;
				if (cause instanceof Computers.Unavailable)
					return { status: "failed", error: cause.userMessage };
				throw cause;
			});
			const connected = await connecting;
			if ("status" in connected) {
				connecting = undefined;
				return connected;
			}
			const result = await connected.client.callTool(
				{ name: toolName, arguments: input as Record<string, unknown> },
				undefined,
				{ signal: abortSignal },
			);
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

/**
 * Has the browser's MCP server act naturally for the rest of this session,
 * the turn's, in `accent`. Browsing naturally only helps members watching, so
 * when the server refuses it the bot browses plainly rather than failing.
 */
async function browseNaturally(client: Client, accent: string) {
	await client
		.callTool({ name: RUN_CODE_TOOL, arguments: { code: naturalBrowsingCode(accent) } })
		.catch(() => undefined);
}

/**
 * Playwright code for the browser's MCP server: a cursor on each tab, drawn
 * by Playwright, that moves to what the bot uses and rings it; a smooth
 * scroll to it first; and typing at a typing pace rather than setting a
 * field's value.
 *
 * The scrolling and typing wrap the Locator methods the server's tools act
 * through, which every MCP session in the server shares, so they're wrapped
 * once and act naturally only for a session whose browser context is marked.
 * Each session connects to the browser anew, with a context of its own, so
 * the next turn's browses plainly unless this runs again.
 */
function naturalBrowsingCode(accent: string) {
	return `async (page) => {
	const cursor = ${JSON.stringify(cursorOptions(accent))};
	const TYPING_DELAY_MILLISECONDS = 70;
	// Long text is typed faster, so filling in a long field doesn't hold up a turn.
	const LONGEST_TYPING_MILLISECONDS = 6000;
	// A smooth scroll that had nowhere to go never says it ended.
	const LONGEST_SCROLL_MILLISECONDS = 1500;
	const context = page.context();
	context.sugabotsNaturalBrowsing = true;
	const showCursor = (tab) => tab.screencast.showActions(cursor);
	await Promise.all(context.pages().map(showCursor));
	context.on("page", (tab) => showCursor(tab).catch(() => {}));

	const Locator = Object.getPrototypeOf(page.locator("body"));
	if (Locator.sugabotsWrapped) return;
	Locator.sugabotsWrapped = true;
	const natural = (locator) => locator.page().context().sugabotsNaturalBrowsing === true;
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { botColors } from "@sugabots/avatars/bot-colors";
import type { AgentColor } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { jsonSchema, type ToolSet, tool } from "ai";
import { Data, Effect } from "effect";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import type { UserFacing } from "../../../user-message.ts";
import { type Image, withImages } from "../images.ts";
import type { OpenSandbox, Place } from "../sandbox/tools.ts";
import playwrightTools from "./playwright-tools.json" with { type: "json" };

/**
 * The browser tools: Playwright MCP's, run in the pod's sandbox by a browser
 * of the agent's own in each thread, on the agent's own desktop there, so
 * people watching see what it does. The tools are offered from the list the
 * image's server was built with; the browser starts on the first call.
 */

/** What a browser tool gives back: the server's text, and any screenshots. */
export interface BrowserResult {
	text: string;
	images?: readonly Image[];
}

interface Failed {
	status: "failed";
	error: UserText;
}

/** A desktop and browser for one agent in one thread, started on first use. */
export interface BrowserSession {
	/** The session's name in the sandbox, which the viewer finds its desktop by. */
	readonly name: string;
	readonly call: (tool: string, input: unknown) => Promise<BrowserResult | Failed>;
	/** Lets go of the connection to the browser. The browser carries on for later turns. */
	readonly close: () => Promise<void>;
}

const SCREENSHOT_TOOL = "browser_take_screenshot";
const IMAGE_BEFORE_PASSWORDS = userText`This sandbox's image is from before desktops had passwords. Upgrade the pod's sandbox to open its desktop.`;
const NO_BROWSER = userText`This sandbox's image has no desktop or browser. Its image needs sugabots-desktop, as Sugabots' default image has.`;

/** An agent in a thread, whose desktop there is drawn in the agent's colour. */
export interface AgentInThread {
	readonly threadId: string;
	readonly agentId: string;
	readonly color: AgentColor;
}

/** An agent browsing in a thread, in the way it was set to. */
export interface AgentBrowsing extends AgentInThread {
	/**
	 * Whether it browses so people watching can follow: a cursor that moves to
	 * what it clicks, smooth scrolling, and typing at a typing pace. Slower.
	 */
	readonly naturalBrowsing: boolean;
}

/** The session's name for an agent in a thread: one desktop and browser each. */
export function sessionName(turn: { threadId: string; agentId: string }) {
	return `${turn.threadId}-${turn.agentId}`;
}

/** An agent's desktop in a thread, running: where viewers reach it, and whether it had to start. */
export interface Desktop {
	/** The server a viewer may click and type through. */
	readonly control: VncServer;
	/** The server a viewer may only watch through. */
	readonly watch: VncServer;
	readonly started: boolean;
}

/** One of a desktop's VNC servers, which takes a WebSocket on its port. */
export interface VncServer {
	readonly port: number;
	/** What it asks for: Sugabots' to know, never a person's. */
	readonly password: string;
}

/** An agent's browser in a thread, running on its desktop. */
export interface Browser {
	readonly viewerPort: number;
	/** Where its Playwright MCP server is. */
	readonly browserPort: number;
	/** Whether it had to start, so its tabs from before are gone. */
	readonly started: boolean;
}

/**
 * Starts the agent's desktop in the thread, without its browser, or finds it
 * running: what a person opening the desktop needs.
 */
export const startDesktop = (sandbox: Sandboxes.Sandbox, place: Place, turn: AgentInThread) =>
	Effect.flatMap(desktopCommand(sandbox, place, turn, "desktop"), (reported) =>
		reported.watch === undefined ||
		reported.password === undefined ||
		reported.watchPassword === undefined
			? Effect.fail(new DesktopUnavailable({ reason: IMAGE_BEFORE_PASSWORDS }))
			: Effect.succeed<Desktop>({
					control: { port: reported.viewer, password: reported.password },
					watch: { port: reported.watch, password: reported.watchPassword },
					started: reported.started,
				}),
	);

/**
 * Starts the agent's browser in the thread, on its desktop, or finds them
 * running: what the agent's browser calls need. A person who opened the
 * desktop first meets the same desktop, and the same browser if the dock
 * started it.
 */
export const startBrowser = (sandbox: Sandboxes.Sandbox, place: Place, turn: AgentInThread) =>
	Effect.flatMap(desktopCommand(sandbox, place, turn, "session"), (ports) =>
		ports.browser === undefined
			? Effect.fail(new DesktopUnavailable({ reason: NO_BROWSER }))
			: Effect.succeed<Browser>({
					viewerPort: ports.viewer,
					browserPort: ports.browser,
					started: ports.started,
				}),
	);

/**
 * Runs `sugabots-desktop desktop` or `session` for the agent in the thread,
 * and reads the ports and passwords it reports.
 */
const desktopCommand = (
	sandbox: Sandboxes.Sandbox,
	place: Place,
	turn: AgentInThread,
	command: "desktop" | "session",
) =>
	Effect.gen(function* () {
		const directory = `${place.folder}/.browser/${turn.agentId}`;
		// Images from before desktops had colours ignore `--accent` and `--folder`.
		const ran = yield* sandbox.exec(
			`mkdir -p ${Sandboxes.shellQuoted(place.home)} && sugabots-desktop ${command} ${Sandboxes.shellQuoted(sessionName(turn))} ${Sandboxes.shellQuoted(`${directory}/profile`)} ${Sandboxes.shellQuoted(directory)} --accent ${Sandboxes.shellQuoted(botColors[turn.color].face)} --folder ${Sandboxes.shellQuoted(place.folder)}`,
			{ env: { HOME: place.home }, timeout: "60 seconds", maxOutputCharacters: 2_000 },
		);
		const reported: Record<string, string | undefined> = Object.fromEntries(
			ran.stdout.text
				.trim()
				.split(/\s+/)
				.map((pair) => pair.split("=")),
		);
		const viewer = Number(reported.viewer);
		if (ran.exitCode !== 0 || !Number.isInteger(viewer)) {
			return yield* new DesktopUnavailable({ reason: NO_BROWSER });
		}
		return {
			viewer,
			watch: reported.watch === undefined ? undefined : Number(reported.watch),
			browser: reported.browser === undefined ? undefined : Number(reported.browser),
			started: reported.started === "yes",
			password: reported.password,
			watchPassword: reported["watch-password"],
		};
	});

/** There is no desktop to reach, for `reason`. */
export class DesktopUnavailable
	extends Data.TaggedError("DesktopUnavailable")<{ reason: UserText }>
	implements UserFacing
{
	get userMessage() {
		return this.reason;
	}
}

export function browserSession(
	openSandbox: OpenSandbox,
	place: Place,
	turn: AgentBrowsing,
): BrowserSession {
	const name = sessionName(turn);
	let connecting: Promise<{ client: Client; note?: UserText } | Failed> | undefined;
	let told = false;

	const connect = async (): Promise<{ client: Client; note?: UserText } | Failed> => {
		const { sandbox } = await openSandbox();
		const browser = await Effect.runPromise(
			startBrowser(sandbox, place, turn).pipe(
				Effect.catchTag("DesktopUnavailable", (unavailable) =>
					Effect.succeed({ status: "failed" as const, error: unavailable.reason }),
				),
			),
		);
		if ("status" in browser) return browser;
		const endpoint = await Effect.runPromise(sandbox.endpoint(browser.browserPort));
		const client = new Client({ name: "sugabots", version: "1" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${endpoint.url}/mcp`), {
				requestInit: { headers: endpoint.headers },
			}),
		);
		if (turn.naturalBrowsing) await browseNaturally(client, botColors[turn.color].face);
		return browser.started
			? {
					client,
					note: userText`Your browser has just started, on your own desktop in the sandbox. Tabs from before, if any, are gone.`,
				}
			: { client };
	};

	return {
		name,
		call: async (toolName, input) => {
			connecting ??= connect().catch((cause: unknown) => {
				connecting = undefined;
				if (cause instanceof Sandboxes.Unavailable)
					return { status: "failed", error: cause.userMessage };
				throw cause;
			});
			const connected = await connecting;
			if ("status" in connected) {
				connecting = undefined;
				return connected;
			}
			const result = await connected.client.callTool({
				name: toolName,
				arguments: input as Record<string, unknown>,
			});
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
 * the turn's, in `accent`. Images from before Playwright drew a cursor
 * refuse it, and the agent browses as it otherwise would.
 */
async function browseNaturally(client: Client, accent: string) {
	await client
		.callTool({ name: RUN_CODE_TOOL, arguments: { code: naturalBrowsingCode(accent) } })
		.catch(() => undefined);
}

/**
 * Playwright code for the browser's MCP server: a cursor on each tab, drawn
 * by Playwright, that moves to what the agent uses and rings it; a smooth
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
	// Clicks into the field and types, as a person would.
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
			// Playwright's name for the action, such as getByRole('button'), which means nothing to people watching.
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

/**
 * The browser tools for a turn. A model that can't take images isn't offered
 * screenshots, and is given the text of any other result alone.
 */
export function browserTools(session: BrowserSession, acceptsImages: boolean): ToolSet {
	const tools: ToolSet = {};
	for (const entry of playwrightTools) {
		if (!acceptsImages && entry.name === SCREENSHOT_TOOL) continue;
		tools[entry.name] = tool({
			description: entry.description,
			inputSchema: jsonSchema(entry.inputSchema as Parameters<typeof jsonSchema>[0]),
			execute: (input) => session.call(entry.name, input),
			toModelOutput: ({ output }) => withImages(output, acceptsImages),
		});
	}
	return tools;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type UserText, userText } from "@sugabots/errors";
import { jsonSchema, type ToolSet, tool } from "ai";
import { Data, Effect } from "effect";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import type { UserFacing } from "../../../user-message.ts";
import { type Image, type OpenSandbox, type Place, withImages } from "../sandbox/tools.ts";
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
export const startDesktop = (
	sandbox: Sandboxes.Sandbox,
	place: Place,
	turn: { threadId: string; agentId: string },
) =>
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
export const startBrowser = (
	sandbox: Sandboxes.Sandbox,
	place: Place,
	turn: { threadId: string; agentId: string },
) =>
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
	turn: { threadId: string; agentId: string },
	command: "desktop" | "session",
) =>
	Effect.gen(function* () {
		const directory = `${place.folder}/.browser/${turn.agentId}`;
		const ran = yield* sandbox.exec(
			`mkdir -p ${Sandboxes.shellQuoted(place.home)} && sugabots-desktop ${command} ${Sandboxes.shellQuoted(sessionName(turn))} ${Sandboxes.shellQuoted(`${directory}/profile`)} ${Sandboxes.shellQuoted(directory)}`,
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
	turn: { threadId: string; agentId: string },
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
 * of the agent's own in each thread, on a display of its own there, so
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

/** A browser for one agent in one thread, on its own display, started on first use. */
export interface BrowserSession {
	/** The session's name in the sandbox, which viewers find its display by. */
	readonly name: string;
	readonly call: (tool: string, input: unknown) => Promise<BrowserResult | Failed>;
	/** Lets go of the connection to the browser. The browser carries on for later turns. */
	readonly close: () => Promise<void>;
}

const SCREENSHOT_TOOL = "browser_take_screenshot";
const NO_SUCH_WINDOW = userText`This window of the desktop isn't open any more.`;
const NO_BROWSER = userText`This sandbox's image has no desktop or browser. Its image needs sugabots-desktop, as Sugabots' default image has.`;

/** The session's name for an agent in a thread: one desktop and browser each. */
export function sessionName(turn: { threadId: string; agentId: string }) {
	return `${turn.threadId}-${turn.agentId}`;
}

/** The servers a viewer reaches one thing through: one to use it, one only to watch it. */
export interface ViewerServers {
	readonly control: ViewerServer;
	readonly watch: ViewerServer;
}

/** A server a viewer reaches a window or the desktop server through, which takes a WebSocket on its port. */
export interface ViewerServer {
	readonly port: number;
	/** What it asks for: Sugabots' to know, never a person's. */
	readonly password: string;
}

/** An agent's browser in a thread, running on a display of its own. */
export interface Browser {
	/** Where its Playwright MCP server is. */
	readonly browserPort: number;
	/** Whether it had to start, so its tabs from before are gone. */
	readonly started: boolean;
	/**
	 * Where viewers reach the agent's desktop server: its browser's tabs, its
	 * terminal, and its windows. Absent in sandboxes made from images from
	 * before desktops were drawn by the web app.
	 */
	readonly desktopServer?: ViewerServers;
}

/**
 * Starts the agent's browser in the thread, on its own display, and its
 * desktop server, or finds them running: what the agent's browser calls and
 * the people viewing its desktop need.
 */
export const startBrowser = (
	sandbox: Sandboxes.Sandbox,
	place: Place,
	turn: { threadId: string; agentId: string },
) =>
	Effect.gen(function* () {
		const directory = `${place.folder}/.browser/${turn.agentId}`;
		const reported = yield* desktopCommand(sandbox, place, [
			"session",
			sessionName(turn),
			`${directory}/profile`,
			directory,
			place.folder,
		]);
		const browser = port(reported.values.browser);
		if (reported.exitCode !== 0 || browser === undefined) {
			return yield* new DesktopUnavailable({ reason: NO_BROWSER });
		}
		const server = port(reported.values.server);
		return {
			browserPort: browser,
			started: reported.values.started === "yes",
			...(server !== undefined && reported.passwords
				? { desktopServer: serversAt(server, reported.passwords) }
				: {}),
		} satisfies Browser;
	});

/**
 * Where viewers reach the window `window` of the agent's desktop in the
 * thread, over VNC: `browser`, or the number of a display the agent started.
 * Fails if the desktop has no such window running.
 */
export const windowViewers = (
	sandbox: Sandboxes.Sandbox,
	place: Place,
	turn: { threadId: string; agentId: string },
	window: string,
) =>
	Effect.gen(function* () {
		const reported = yield* desktopCommand(sandbox, place, ["display", sessionName(turn), window]);
		const viewer = port(reported.values.viewer);
		if (reported.exitCode !== 0 || viewer === undefined || !reported.passwords) {
			return yield* new DesktopUnavailable({ reason: NO_SUCH_WINDOW });
		}
		return serversAt(viewer, reported.passwords);
	});

/** The servers on `port`, taking a display's two passwords. */
function serversAt(port: number, passwords: { control: string; watch: string }): ViewerServers {
	return {
		control: { port, password: passwords.control },
		watch: { port, password: passwords.watch },
	};
}

function port(reported: string | undefined) {
	const parsed = Number(reported);
	return reported !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Runs `sugabots-desktop` with `args` in the agent's home, and reads the
 * `name=value` pairs it prints, with its passwords read from them.
 */
const desktopCommand = (sandbox: Sandboxes.Sandbox, place: Place, args: readonly string[]) =>
	Effect.gen(function* () {
		const ran = yield* sandbox.exec(
			`mkdir -p ${Sandboxes.shellQuoted(place.home)} && sugabots-desktop ${args.map(Sandboxes.shellQuoted).join(" ")}`,
			{ env: { HOME: place.home }, timeout: "60 seconds", maxOutputCharacters: 2_000 },
		);
		const reported: Record<string, string | undefined> = Object.fromEntries(
			ran.stdout.text
				.trim()
				.split(/\s+/)
				.map((pair) => pair.split("=")),
		);
		const { password, "watch-password": watchPassword } = reported;
		return {
			values: reported,
			exitCode: ran.exitCode,
			passwords:
				password === undefined || watchPassword === undefined
					? undefined
					: { control: password, watch: watchPassword },
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

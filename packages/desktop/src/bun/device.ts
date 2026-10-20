import { homedir, hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { DEVICE_CONNECT_PATH, type DeviceFrame } from "@sugabots/contracts/devices";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Session } from "electrobun/main";
import { z } from "zod";
import type { CommandRequest } from "../shared/rpc.ts";

/** How long to wait before dialling the server again after the socket drops. */
const RECONNECT_DELAY_MS = 5_000;
/** How long a command may run before it's stopped. */
const COMMAND_TIMEOUT_MS = 120_000;
/** How much of a command's output goes back to the bot, per stream. */
const OUTPUT_LIMIT_CHARACTERS = 20_000;

/**
 * Keeps this computer connected to the Sugabots server at `origin`, offering
 * its tools to the threads its owner lends it to. Every call waits for
 * `approve`, so nothing runs that the owner didn't allow here.
 *
 * A spike: it signs in with the session cookie the app's window holds, so it
 * connects once the person has signed in there.
 */
export function connectDevice({
	origin,
	approve,
}: {
	origin: string;
	approve: (request: CommandRequest) => Promise<boolean>;
}): { readonly disconnect: () => void } {
	let stopped = false;
	let current: WebSocket | undefined;
	const url = new URL(`${API_BASE_PATH}${DEVICE_CONNECT_PATH}`, origin);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("name", hostname());

	const dial = () => {
		if (stopped) return;
		const cookies = Session.defaultSession.cookies.get({ url: origin });
		if (cookies.length === 0) {
			console.log(`[device] no session cookie for ${origin} yet; sign in in the window`);
			setTimeout(dial, RECONNECT_DELAY_MS);
			return;
		}
		const socket = new WebSocket(url, {
			// Bun's WebSocket takes headers; the server only accepts its own origin.
			headers: {
				origin,
				cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
			},
		} as unknown as string[]);
		current = socket;
		console.log(`[device] connecting to ${url.origin} with ${cookies.length} cookies`);
		socket.addEventListener("open", () => console.log("[device] connected"));
		const sessions = new Map<string, SocketTransport>();
		const send = (frame: DeviceFrame) => socket.send(JSON.stringify(frame));

		socket.addEventListener("message", async (event) => {
			const frame = JSON.parse(String(event.data)) as DeviceFrame;
			if (frame.type === "open") {
				console.log(`[device] server opened session ${frame.session}`);
				const transport = new SocketTransport(frame.session, send);
				sessions.set(frame.session, transport);
				await toolServer(approve).connect(transport);
			} else if (frame.type === "message") {
				sessions.get(frame.session)?.onmessage?.(frame.message as JSONRPCMessage);
			} else {
				sessions.get(frame.session)?.onclose?.();
				sessions.delete(frame.session);
			}
		});
		socket.addEventListener("close", (event) => {
			console.log(`[device] disconnected (${event.code} ${event.reason}); retrying`);
			for (const transport of sessions.values()) transport.onclose?.();
			sessions.clear();
			setTimeout(dial, RECONNECT_DELAY_MS);
		});
	};
	dial();
	return {
		disconnect: () => {
			stopped = true;
			current?.close();
		},
	};
}

/** One MCP session the server opened, carried in frames on the device's socket. */
class SocketTransport implements Transport {
	onmessage?: (message: JSONRPCMessage) => void;
	onclose?: () => void;
	onerror?: (error: Error) => void;

	constructor(
		readonly session: string,
		readonly sendFrame: (frame: DeviceFrame) => void,
	) {}

	async start() {}

	async send(message: JSONRPCMessage) {
		this.sendFrame({ type: "message", session: this.session, message });
	}

	async close() {
		this.sendFrame({ type: "close", session: this.session });
		this.onclose?.();
	}
}

function toolServer(approve: (request: CommandRequest) => Promise<boolean>): McpServer {
	const server = new McpServer({ name: "sugabots-desktop", version: "0.0.0" });
	server.registerTool(
		"run_command",
		{
			description:
				"Runs a shell command on the person's own computer and returns its output and exit code. The person approves each command on their computer before it runs.",
			inputSchema: {
				command: z.string().describe("The shell command to run."),
				cwd: z
					.string()
					.optional()
					.describe("The folder to run it in; the person's home folder when left out."),
			},
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async ({ command, cwd = homedir() }) => {
			if (!(await approve({ command, cwd }))) {
				return {
					isError: true,
					content: [{ type: "text", text: "The person declined to run this command." }],
				};
			}
			return { content: [{ type: "text", text: await runCommand(command, cwd) }] };
		},
	);
	return server;
}

async function runCommand(command: string, cwd: string): Promise<string> {
	const shell = process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command];
	const child = Bun.spawn(shell, { cwd, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	return [
		`exit code: ${exitCode}`,
		`stdout:\n${stdout.slice(0, OUTPUT_LIMIT_CHARACTERS)}`,
		`stderr:\n${stderr.slice(0, OUTPUT_LIMIT_CHARACTERS)}`,
	].join("\n");
}

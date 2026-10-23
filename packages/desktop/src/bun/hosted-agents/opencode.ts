import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import type { ApproveToolUse, RunEvent } from "./claude-code.ts";
import { confined } from "./sandbox.ts";

interface OpencodeServer {
	url: string;
	close: () => void;
}

/**
 * opencode, run through its own server (`opencode serve`) on loopback, one per
 * folder so each is confined to its own. Started on first use and shared by
 * that folder's runs; they stop when this process does.
 */
const servers = new Map<string, Promise<OpencodeServer>>();

/** How long opencode's server has to say where it listens. */
const STARTUP_TIMEOUT_MS = 15_000;

function opencodeServer(executable: string, workingDirectory: string) {
	let server = servers.get(workingDirectory);
	if (!server) {
		server = startServer(executable, workingDirectory).catch((failure: unknown) => {
			servers.delete(workingDirectory);
			throw failure;
		});
		servers.set(workingDirectory, server);
	}
	return server;
}

async function startServer(executable: string, workingDirectory: string): Promise<OpencodeServer> {
	const [program = executable, ...args] = confined(
		[executable, "serve", "--hostname=127.0.0.1", "--port=0"],
		{ kind: "opencode", workingDirectory },
	);
	const child = Bun.spawn([program, ...args], {
		cwd: workingDirectory,
		stdout: "pipe",
		stderr: "inherit",
	});
	const close = () => child.kill();
	const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
	const timeout = setTimeout(close, STARTUP_TIMEOUT_MS);
	let output = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`opencode's server stopped before it listened: ${output.trim()}`);
			output += value;
			const url = output.match(/opencode server listening on (https?:\/\/\S+)/)?.[1];
			if (url) return { url, close };
		}
	} finally {
		clearTimeout(timeout);
		reader.releaseLock();
	}
}

export function stopOpencode() {
	for (const server of servers.values())
		void server.then(
			({ close }) => close(),
			() => {},
		);
	servers.clear();
}

/** The name an MCP server's tools are prefixed with, so their permission requests can be recognised. */
const SUGABOTS_PREFIX = "sugabots";

/**
 * Sends `prompt` to opencode, working in `workingDirectory`, continuing
 * `sessionId` when the conversation has one. It runs as the person at this
 * computer, with their own opencode settings and providers; whatever those
 * settings would ask about is asked through `approve`, except Sugabots' own
 * tools, served at `sugabotsUrl`, which the server runs under the pod's
 * rules. Its server runs confined to the folder. Throws when the run fails.
 */
export async function* runOpencode(options: {
	agentName: string;
	executable: string;
	workingDirectory: string;
	prompt: string;
	sessionId: string | undefined;
	approve: ApproveToolUse;
	sugabotsUrl: string | undefined;
	signal: AbortSignal;
}): AsyncGenerator<RunEvent> {
	const { url } = await opencodeServer(options.executable, options.workingDirectory);
	const directory = options.workingDirectory;
	const client = createOpencodeClient({ baseUrl: url, directory });

	const sessionID =
		options.sessionId ??
		(await client.session.create({ directory }, { throwOnError: true })).data.id;
	yield { type: "session", id: sessionID };

	// Unique to the run: another conversation in the same folder has its own turn's tools.
	const mcpName = `${SUGABOTS_PREFIX}-${crypto.randomUUID().slice(0, 8)}`;
	if (options.sugabotsUrl) {
		await client.mcp.add(
			{
				directory,
				name: mcpName,
				config: { type: "remote", url: options.sugabotsUrl, oauth: false },
			},
			{ throwOnError: true },
		);
	}
	const aborts = new AbortController();
	const stop = () => {
		aborts.abort();
		void client.session.abort({ sessionID, directory });
	};
	options.signal.addEventListener("abort", stop, { once: true });
	try {
		const events = await client.event.subscribe({ directory }, { signal: aborts.signal });
		await client.session.promptAsync(
			{ sessionID, directory, parts: [{ type: "text", text: options.prompt }] },
			{ throwOnError: true },
		);
		const replies = new Set<string>();
		const textParts = new Set<string>();
		let lastTextPart: string | undefined;
		for await (const event of events.stream as AsyncIterable<Event>) {
			if (!("properties" in event) || sessionOf(event) !== sessionID) continue;
			switch (event.type) {
				case "message.updated":
					if (event.properties.info.role === "assistant") replies.add(event.properties.info.id);
					break;
				case "message.part.updated":
					if (event.properties.part.type === "text") textParts.add(event.properties.part.id);
					break;
				case "message.part.delta": {
					const { messageID, partID, field, delta } = event.properties;
					if (field !== "text" || !replies.has(messageID) || !textParts.has(partID)) break;
					const separated = lastTextPart !== undefined && lastTextPart !== partID;
					lastTextPart = partID;
					yield { type: "text", text: separated ? `\n\n${delta}` : delta };
					break;
				}
				case "permission.asked": {
					const asked = event.properties;
					const allowed =
						asked.permission.startsWith(mcpName) ||
						(await options.approve({
							agentName: options.agentName,
							toolName: asked.permission,
							input: { patterns: asked.patterns, ...asked.metadata },
						}));
					await client.permission.reply({
						requestID: asked.id,
						directory,
						reply: allowed ? "once" : "reject",
					});
					break;
				}
				case "session.error":
					throw new Error(
						`opencode stopped: ${JSON.stringify(event.properties.error ?? "unknown")}`,
					);
				case "session.idle":
					return;
			}
		}
	} finally {
		options.signal.removeEventListener("abort", stop);
		aborts.abort();
		if (options.sugabotsUrl) void client.mcp.disconnect({ name: mcpName, directory });
	}
}

function sessionOf(event: Event): string | undefined {
	const properties = event.properties as { sessionID?: unknown };
	return typeof properties.sessionID === "string" ? properties.sessionID : undefined;
}

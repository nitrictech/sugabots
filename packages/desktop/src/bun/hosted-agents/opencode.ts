import { createOpencodeClient, createOpencodeServer, type Event } from "@opencode-ai/sdk/v2";
import type { ApproveToolUse, RunEvent } from "./claude-code.ts";

/**
 * opencode, run through its own server, which this app starts once on
 * loopback (`opencode serve`) and shares between runs. It stops when this
 * process does.
 */
let server: Promise<{ url: string; close: () => void }> | undefined;

function opencodeServer() {
	server ??= createOpencodeServer({ port: 0 }).catch((failure: unknown) => {
		server = undefined;
		throw failure;
	});
	return server;
}

export function stopOpencode() {
	void server?.then(({ close }) => close());
	server = undefined;
}

/** The name an MCP server's tools are prefixed with, so their permission requests can be recognised. */
const SUGABOTS_PREFIX = "sugabots";

/**
 * Sends `prompt` to opencode, working in `workingDirectory`, continuing
 * `sessionId` when the conversation has one. It runs as the person at this
 * computer, with their own opencode settings and providers; whatever those
 * settings would ask about is asked through `approve`, except Sugabots' own
 * tools, served at `sugabotsUrl`, which the server runs under the pod's
 * rules. Throws when the run fails.
 */
export async function* runOpencode(options: {
	agentName: string;
	workingDirectory: string;
	prompt: string;
	sessionId: string | undefined;
	approve: ApproveToolUse;
	sugabotsUrl: string | undefined;
	signal: AbortSignal;
}): AsyncGenerator<RunEvent> {
	const { url } = await opencodeServer();
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

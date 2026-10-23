import {
	DEVICE_LINK_PATH,
	type DeviceToServer,
	type InstalledAgent,
	type LocalAgentKind,
	type ServerToDevice,
	serverToDeviceSchema,
} from "@sugabots/contracts/devices";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Schema } from "effect";
import { type AgentHost, agentOrigin } from "./hosted-agents/host.ts";
import type { SugabotsTools } from "./hosted-agents/sugabots-tools.ts";
import type { LentAgent } from "./local-agents.ts";

/**
 * This computer's link to the server it's paired with: a WebSocket it dials
 * out on and keeps open, down which the server sends HTTP requests for the
 * agents this computer lends. Each is answered in this process by the agent
 * host, never sent on, so the server reaches nothing else on this computer
 * or its network. The server can also ask for an agent to be lent, which
 * only the person at this computer can agree to, through `askToLend`.
 */
export interface DeviceLink extends SugabotsTools {
	/** Replaces the agents lent, telling the server if it's connected. */
	readonly lend: (agents: ReadonlyArray<LentAgent>) => void;
	/** Closes the link for good and abandons its requests. */
	readonly stop: () => void;
}

const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 30_000;

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(serverToDeviceSchema));

/**
 * Connects to `server` with `token`, and reconnects with backoff whenever the
 * link drops or the server refuses it, as it does until the pairing is
 * approved.
 */
export function startDeviceLink(options: {
	server: string;
	token: string;
	agents: ReadonlyArray<LentAgent>;
	/** The agent programs installed here, which the server is told it could ask to lend. */
	installed: ReadonlyArray<InstalledAgent>;
	host: AgentHost;
	/** Asks the person at this computer to lend an agent of `kind`: what they lent, or nothing. */
	askToLend: (kind: LocalAgentKind) => Promise<LentAgent | undefined>;
	/** Stops lending the agent at the address the server knows it by. */
	stopLending: (url: string) => void;
	/** Told, on each connection, which device the server knows this computer as. */
	identified: (deviceId: string) => void;
}): DeviceLink {
	const linkUrl = new URL(`${API_BASE_PATH}${DEVICE_LINK_PATH}`, options.server);
	linkUrl.protocol = linkUrl.protocol === "https:" ? "wss:" : "ws:";
	let agents = options.agents;
	let socket: WebSocket | undefined;
	let stopped = false;
	let retryMs = FIRST_RETRY_MS;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const inFlight = new Map<string, AbortController>();
	/** What this end asked the server about tools, waiting for answers, by id. */
	const asked = new Map<string, (answer: ToolAnswer | undefined) => void>();
	let questionsAsked = 0;
	const ask = (question: (id: string) => DeviceToServer) =>
		new Promise<ToolAnswer | undefined>((resolve) => {
			if (socket?.readyState !== WebSocket.OPEN) return resolve(undefined);
			const id = String(++questionsAsked);
			asked.set(id, resolve);
			send(question(id));
		});

	const send = (message: DeviceToServer) => {
		if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	};
	const sendAgents = () =>
		send({
			type: "agents",
			agents: {
				lent: agents.map(toLocalAgent),
				installed: options.installed.map(({ kind, name, version }) => ({ kind, name, version })),
			},
		});
	const abandonRequests = () => {
		for (const controller of inFlight.values()) controller.abort();
		inFlight.clear();
		for (const answer of asked.values()) answer(undefined);
		asked.clear();
	};

	const connect = () => {
		// Bun's WebSocket takes headers, which browsers' doesn't.
		const opened = new WebSocket(linkUrl.href, {
			headers: { authorization: `Bearer ${options.token}` },
		} as unknown as string[]);
		socket = opened;
		opened.addEventListener("open", () => {
			retryMs = FIRST_RETRY_MS;
			sendAgents();
		});
		opened.addEventListener("message", (event) => {
			const message = decodeMessage(typeof event.data === "string" ? event.data : "");
			if (message._tag === "Some") receive(message.value);
		});
		opened.addEventListener("close", () => {
			if (socket !== opened) return;
			socket = undefined;
			abandonRequests();
			if (stopped) return;
			retry = setTimeout(connect, retryMs);
			retryMs = Math.min(retryMs * 2, LAST_RETRY_MS);
		});
	};

	const receive = (message: ServerToDevice) => {
		if (message.type === "cancel") {
			inFlight.get(message.id)?.abort();
			inFlight.delete(message.id);
			return;
		}
		if (message.type === "lend") {
			void options.askToLend(message.kind).then(
				(lent) => send({ type: "lent", id: message.id, agent: lent ? toLocalAgent(lent) : null }),
				() => send({ type: "lent", id: message.id, agent: null }),
			);
			return;
		}
		if (message.type === "tools" || message.type === "toolResult") {
			asked.get(message.id)?.(message);
			asked.delete(message.id);
			return;
		}
		if (message.type === "hello") {
			options.identified(message.deviceId);
			return;
		}
		if (message.type === "stopLending") {
			options.stopLending(message.url);
			return;
		}
		const controller = new AbortController();
		inFlight.set(message.id, controller);
		void relay(message, options.host, send, controller.signal).finally(() => {
			if (inFlight.get(message.id) === controller) inFlight.delete(message.id);
		});
	};

	connect();

	return {
		list: async (where) => {
			const answer = await ask((id) => ({ type: "listTools", id, ...where }));
			return answer?.type === "tools" ? answer.tools : [];
		},
		call: async (where, name, input) => {
			const answer = await ask((id) => ({ type: "callTool", id, ...where, name, input }));
			return answer?.type === "toolResult"
				? { text: answer.text, isError: answer.isError }
				: { text: "Sugabots couldn't be reached, so the tool didn't run.", isError: true };
		},
		lend: (lent) => {
			agents = lent;
			sendAgents();
		},
		stop: () => {
			stopped = true;
			clearTimeout(retry);
			abandonRequests();
			socket?.close();
		},
	};
}

/** A lent agent as the server knows it: by the address its requests come to. */
function toLocalAgent({ id, kind, name, description, workingDirectory }: LentAgent) {
	return { url: agentOrigin(id), kind, name, description, workingDirectory };
}

type RelayedRequest = Extract<ServerToDevice, { type: "request" }>;

type ToolAnswer = Extract<ServerToDevice, { type: "tools" | "toolResult" }>;

/** Answers `request` with the agent host, and streams its response back as it's written. */
export async function relay(
	request: RelayedRequest,
	host: AgentHost,
	send: (message: DeviceToServer) => void,
	signal: AbortSignal,
): Promise<void> {
	const { id } = request;
	try {
		const response = await host.handle(
			new Request(request.url, {
				method: request.method,
				headers: request.headers.map(([name, value]) => [name, value]),
				body: request.body === null ? undefined : Buffer.from(request.body, "base64"),
				signal,
			}),
		);
		send({ type: "response", id, status: response.status, headers: [...response.headers] });
		if (response.body) {
			for await (const chunk of response.body) {
				if (signal.aborted) return;
				send({ type: "body", id, chunk: Buffer.from(chunk).toString("base64") });
			}
		}
		send({ type: "end", id });
	} catch (failure) {
		if (signal.aborted) return;
		send({ type: "failed", id, reason: `The agent didn't answer: ${String(failure)}` });
	}
}

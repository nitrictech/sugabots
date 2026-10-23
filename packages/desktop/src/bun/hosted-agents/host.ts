import { type AgentCard, type Part, Role, TaskState } from "@a2a-js/sdk";
import {
	AgentEvent,
	type AgentExecutor,
	DefaultRequestHandler,
	defaultServerCallContextBuilder,
	type ExecutionEventBus,
	InMemoryTaskStore,
	JsonRpcTransportHandler,
	UnauthenticatedUser,
} from "@a2a-js/sdk/server";
import type { LentAgent } from "../local-agents.ts";
import { type ApproveToolUse, type RunEvent, runClaudeCode } from "./claude-code.ts";
import { runOpencode } from "./opencode.ts";
import {
	type AskedIn,
	type LoopbackTools,
	type SugabotsTools,
	startLoopbackTools,
	sugabotsMcpServer,
} from "./sugabots-tools.ts";

/**
 * The A2A agents this computer lends, served in this process rather than on
 * a port: the device link hands each request from the server to
 * {@link AgentHost.handle}. An agent's address names no real host, so nothing
 * else on this computer or its network can reach it.
 */
export interface AgentHost {
	/** Answers `request` for the agent its origin names, or 404 for any other. */
	readonly handle: (request: Request) => Promise<Response>;
	/** Replaces the agents lent. */
	readonly lend: (agents: ReadonlyArray<LentAgent>) => void;
}

/** Where a lent agent's conversations stand: each A2A context's Claude Code session. */
export interface Sessions {
	readonly get: (agentId: string, contextId: string) => string | undefined;
	readonly set: (agentId: string, contextId: string, sessionId: string) => void;
}

const CARD_PATH = "/.well-known/agent-card.json";
const JSON_RPC_PATH = "/a2a/jsonrpc";
const PROTOCOL_VERSION = "1.0";
/** The one artifact a run's reply streams into, a delta at a time. */
const REPLY_ARTIFACT = "reply";

export function startAgentHost(options: {
	agents: ReadonlyArray<LentAgent>;
	sessions: Sessions;
	approve: ApproveToolUse;
	tools: SugabotsTools;
}): AgentHost {
	let served = new Map<string, Served>();
	const running = { ...options, loopback: startLoopbackTools(options.tools) };
	const lend = (agents: ReadonlyArray<LentAgent>) => {
		const kept = new Map<string, Served>();
		for (const agent of agents) {
			const previous = served.get(agent.id);
			kept.set(
				agent.id,
				previous && sameAgent(previous.agent, agent) ? previous : serve(agent, running),
			);
		}
		served = kept;
	};
	lend(options.agents);

	return {
		lend,
		handle: async (request) => {
			const url = new URL(request.url);
			const agent = [...served.values()].find(({ origin }) => origin === url.origin);
			if (!agent) return new Response("This computer lends no agent there", { status: 404 });
			if (request.method === "GET" && url.pathname === CARD_PATH) {
				return Response.json(agent.card);
			}
			if (request.method === "POST" && url.pathname === JSON_RPC_PATH) {
				return answerJsonRpc(agent.transport, request);
			}
			return new Response("Not found", { status: 404 });
		},
	};
}

/** One lent agent's A2A server. */
interface Served {
	agent: LentAgent;
	origin: string;
	card: AgentCard;
	transport: JsonRpcTransportHandler;
}

function sameAgent(a: LentAgent, b: LentAgent) {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** The address a lent agent is reached at: under `.invalid`, which never resolves. */
export function agentOrigin(agentId: string) {
	return `http://${agentId}.agents.invalid`;
}

function serve(agent: LentAgent, options: Runners): Served {
	const origin = agentOrigin(agent.id);
	const card: AgentCard = {
		name: agent.name,
		description: agent.description ?? "",
		supportedInterfaces: [
			{
				url: `${origin}${JSON_RPC_PATH}`,
				protocolBinding: "JSONRPC",
				tenant: "",
				protocolVersion: PROTOCOL_VERSION,
			},
		],
		provider: undefined,
		version: "1.0.0",
		capabilities: { streaming: true, pushNotifications: false, extensions: [] },
		securitySchemes: {},
		securityRequirements: [],
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: [],
		signatures: [],
	};
	const handler = new DefaultRequestHandler(
		card,
		new InMemoryTaskStore(),
		executor(agent, options),
	);
	return { agent, origin, card, transport: new JsonRpcTransportHandler(handler) };
}

/** What runs a lent agent needs: its sessions, the owner's approval, and the turn's Sugabots tools. */
interface Runners {
	sessions: Sessions;
	approve: ApproveToolUse;
	tools: SugabotsTools;
	loopback: LoopbackTools;
}

/** One run of `agent`'s program with `prompt`, in the session `sessionId` continues. */
async function* run(
	agent: LentAgent,
	runners: Runners,
	asked: AskedIn,
	request: { prompt: string; sessionId: string | undefined; signal: AbortSignal },
): AsyncGenerator<RunEvent> {
	const common = {
		agentName: agent.name,
		workingDirectory: agent.workingDirectory,
		approve: runners.approve,
		...request,
	};
	switch (agent.kind) {
		case "claude-code":
			yield* runClaudeCode({
				...common,
				executable: agent.executable,
				sugabots: await sugabotsMcpServer(runners.tools, asked),
			});
			return;
		case "opencode": {
			const exposed = await runners.loopback.expose(asked);
			try {
				yield* runOpencode({ ...common, sugabotsUrl: exposed?.url });
			} finally {
				exposed?.close();
			}
			return;
		}
	}
}

/** Each message sent to `agent` is one run of its program, continuing its conversation's session. */
function executor(agent: LentAgent, runners: Runners): AgentExecutor {
	const { sessions } = runners;
	const running = new Map<string, AbortController>();
	return {
		execute: async (context, bus) => {
			const { taskId, contextId } = context;
			const aborts = new AbortController();
			running.set(taskId, aborts);
			bus.publish(
				AgentEvent.task({
					id: taskId,
					contextId,
					status: status(TaskState.TASK_STATE_WORKING),
					artifacts: [],
					history: [context.userMessage],
					metadata: undefined,
				}),
			);
			try {
				for await (const event of run(
					agent,
					runners,
					{ agentUrl: agentOrigin(agent.id), contextId },
					{
						prompt: textOf(context.userMessage.parts),
						sessionId: sessions.get(agent.id, contextId),
						signal: aborts.signal,
					},
				)) {
					if (event.type === "session") {
						sessions.set(agent.id, contextId, event.id);
						continue;
					}
					bus.publish(
						AgentEvent.artifactUpdate({
							taskId,
							contextId,
							artifact: {
								artifactId: REPLY_ARTIFACT,
								name: "",
								description: "",
								parts: [textPart(event.text)],
								metadata: undefined,
								extensions: [],
							},
							append: true,
							lastChunk: false,
							metadata: undefined,
						}),
					);
				}
				finish(bus, taskId, contextId, status(TaskState.TASK_STATE_COMPLETED));
			} catch (failure) {
				const state = aborts.signal.aborted
					? TaskState.TASK_STATE_CANCELED
					: TaskState.TASK_STATE_FAILED;
				finish(bus, taskId, contextId, status(state, String(failure)));
			} finally {
				running.delete(taskId);
			}
		},
		cancelTask: async (taskId) => {
			running.get(taskId)?.abort();
		},
	};
}

function finish(
	bus: ExecutionEventBus,
	taskId: string,
	contextId: string,
	finalStatus: ReturnType<typeof status>,
) {
	bus.publish(
		AgentEvent.statusUpdate({ taskId, contextId, status: finalStatus, metadata: undefined }),
	);
	bus.finished();
}

function status(state: TaskState, said?: string) {
	return {
		state,
		message:
			said === undefined
				? undefined
				: {
						messageId: crypto.randomUUID(),
						contextId: "",
						taskId: "",
						role: Role.ROLE_AGENT,
						parts: [textPart(said)],
						metadata: undefined,
						extensions: [],
						referenceTaskIds: [],
					},
		timestamp: new Date().toISOString(),
	};
}

function textPart(text: string): Part {
	return {
		content: { $case: "text", value: text },
		metadata: undefined,
		filename: "",
		mediaType: "",
	};
}

function textOf(parts: readonly Part[]): string {
	return parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")).join("");
}

/**
 * Answers a JSON-RPC request the way the SDK's Express handler does: one
 * JSON response, or a stream of them as server-sent events.
 */
async function answerJsonRpc(transport: JsonRpcTransportHandler, request: Request) {
	const context = defaultServerCallContextBuilder({
		extensions: undefined,
		user: new UnauthenticatedUser(),
		headers: Object.fromEntries(request.headers),
		requestedVersion: request.headers.get("A2A-Version") ?? undefined,
	});
	const answer = await transport.handle(await request.text(), context);
	if (!(Symbol.asyncIterator in answer)) return Response.json(answer);
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			for await (const event of answer) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
	});
}

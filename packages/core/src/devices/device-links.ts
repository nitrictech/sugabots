export * as DeviceLinks from "./device-links.ts";

import {
	type DeviceAgents,
	type DeviceToServer,
	deviceToServerSchema,
	type LocalAgent,
	type LocalAgentKind,
	type OfferedTool,
	type ServerToDevice,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { Context, Data, Deferred, Effect, Layer, Option, Queue, Schema, type Scope } from "effect";
import type { Socket } from "effect/unstable/socket";
import type { UserFacing } from "../user-message.ts";

/**
 * The paired devices connected to this process, each over the WebSocket it
 * dialled out on: HTTP to the agents they lend carried over those sockets,
 * and asking them to lend or stop lending one. A device's agents are
 * reachable exactly while it is connected.
 *
 * Held in memory: it assumes one server process, as the single-runner
 * workflow engine does. With several, a turn would have to reach the process
 * holding the device's socket.
 */
export interface Interface {
	/**
	 * Serves `deviceId`'s link over `socket` until either side closes it. A
	 * newer link for the same device replaces this one.
	 */
	readonly serve: (deviceId: string, socket: Socket.Socket) => Effect.Effect<void>;
	/** Closes the device's link, if it has one. */
	readonly disconnect: (deviceId: string) => Effect.Effect<void>;
	/** What the device lends and could, or nothing while it isn't connected. */
	readonly agents: (deviceId: string) => DeviceAgents | undefined;
	/**
	 * Asks the device's owner, on the device, to lend an agent of `kind` in a
	 * folder they choose there, and waits for their answer.
	 */
	readonly lend: (
		deviceId: string,
		kind: LocalAgentKind,
	) => Effect.Effect<LocalAgent, DeviceOffline | LendingDeclined>;
	/** Tells the device to stop lending the agent at `url`. */
	readonly stopLending: (deviceId: string, url: string) => Effect.Effect<void, DeviceOffline>;
	/**
	 * Offers `toolbox` to the agent at `agentUrl` on the device, for what it
	 * is asked in A2A context `contextId`, until the scope closes: the turn
	 * asking it. The device can list and call those tools, and no others.
	 */
	readonly offerTools: (
		asked: { deviceId: string; agentUrl: string; contextId: string },
		toolbox: Toolbox,
	) => Effect.Effect<void, never, Scope.Scope>;
	/**
	 * A `fetch` whose requests the device makes on its own computer. It
	 * rejects while the device isn't connected, and the device refuses any
	 * address but its agents'.
	 */
	readonly fetchThrough: (deviceId: string) => typeof fetch;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/DeviceLinks") {}

export const make = Effect.sync(() => {
	const links = new Map<string, Link>();
	/** The toolboxes offered to each device's agents, by device then {@link askedInKey}. */
	const toolboxes = new Map<string, Map<string, Toolbox>>();
	const toolboxFor = (deviceId: string, asked: { agentUrl: string; contextId: string }) =>
		toolboxes.get(deviceId)?.get(askedInKey(asked));

	/** Answers what a device asks about its agents' tools, from the toolboxes offered to it. */
	const answerToolUse = (deviceId: string, link: Link, message: ToolUse) => {
		const toolbox = toolboxFor(deviceId, message);
		if (message.type === "listTools") {
			link.send({ type: "tools", id: message.id, tools: toolbox?.list() ?? [] });
			return;
		}
		if (!toolbox) {
			link.send({
				type: "toolResult",
				id: message.id,
				text: "That turn has ended, so its tools are gone.",
				isError: true,
			});
			return;
		}
		const aborts = new AbortController();
		link.toolCalls.add(aborts);
		void toolbox
			.call(message.name, message.input, aborts.signal)
			.catch((failure: unknown) => ({ text: `The tool failed: ${String(failure)}`, isError: true }))
			.then((result) => link.send({ type: "toolResult", id: message.id, ...result }))
			.finally(() => link.toolCalls.delete(aborts));
	};
	/** Numbers what is sent down links to be answered, so each answer finds its question. */
	let questionsSent = 0;
	const connected = (deviceId: string) => {
		const link = links.get(deviceId);
		return link ? Effect.succeed(link) : Effect.fail(new DeviceOffline());
	};

	return Service.of({
		serve: (deviceId, socket) =>
			Effect.gen(function* () {
				const writer = yield* socket.writer;
				const outgoing = yield* Queue.unbounded<string>();
				const replaced = yield* Deferred.make<void>();
				const link: Link = {
					agents: { lent: [], installed: [] },
					pending: new Map(),
					lendings: new Map(),
					toolCalls: new Set(),
					send: (message) => {
						Queue.offerUnsafe(outgoing, JSON.stringify(message));
					},
					end: () => {
						Deferred.doneUnsafe(replaced, Effect.void);
					},
				};
				links.get(deviceId)?.end();
				links.set(deviceId, link);
				link.send({ type: "hello", deviceId });
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						if (links.get(deviceId) === link) links.delete(deviceId);
						for (const request of link.pending.values()) request.fail("The device disconnected");
						for (const answer of link.lendings.values()) answer(undefined);
						for (const call of link.toolCalls) call.abort();
					}),
				);
				const reader = yield* socket.reader;
				const sending = Queue.take(outgoing).pipe(Effect.flatMap(writer.write), Effect.forever);
				const receiving = reader.pull.pipe(
					Effect.flatMap((frames) =>
						Effect.sync(() => {
							for (const frame of frames) {
								const message = decodeMessage(
									typeof frame === "string" ? frame : TEXT.decode(frame),
								);
								if (Option.isNone(message)) continue;
								if (isToolUse(message.value)) answerToolUse(deviceId, link, message.value);
								else receive(link, message.value);
							}
						}),
					),
					Effect.forever,
				);
				yield* Effect.raceFirst(Effect.raceFirst(sending, receiving), Deferred.await(replaced));
			}).pipe(Effect.scoped, Effect.ignore),

		disconnect: (deviceId) => Effect.sync(() => links.get(deviceId)?.end()),

		agents: (deviceId) => links.get(deviceId)?.agents,

		lend: (deviceId, kind) =>
			Effect.flatMap(connected(deviceId), (link) =>
				Effect.callback<LocalAgent, DeviceOffline | LendingDeclined>((resume) => {
					const id = String(++questionsSent);
					link.lendings.set(id, (agent) => {
						link.lendings.delete(id);
						resume(
							agent === undefined
								? Effect.fail(new DeviceOffline())
								: agent === null
									? Effect.fail(new LendingDeclined())
									: Effect.succeed(agent),
						);
					});
					link.send({ type: "lend", id, kind });
					return Effect.sync(() => link.lendings.delete(id));
				}),
			),

		stopLending: (deviceId, url) =>
			Effect.map(connected(deviceId), (link) => link.send({ type: "stopLending", url })),

		offerTools: ({ deviceId, ...asked }, toolbox) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const offered = toolboxes.get(deviceId) ?? new Map<string, Toolbox>();
					offered.set(askedInKey(asked), toolbox);
					toolboxes.set(deviceId, offered);
				}),
				() =>
					Effect.sync(() => {
						const offered = toolboxes.get(deviceId);
						if (offered?.get(askedInKey(asked)) === toolbox) offered.delete(askedInKey(asked));
						if (offered?.size === 0) toolboxes.delete(deviceId);
					}),
			),

		fetchThrough: (deviceId) => async (input, init) => {
			const link = links.get(deviceId);
			if (!link) throw new Error("The device carrying this agent isn't connected");
			const request = new Request(input, init);
			const body = request.body
				? Buffer.from(await request.arrayBuffer()).toString("base64")
				: null;
			const id = String(++questionsSent);
			return new Promise<Response>((resolve, reject) => {
				let stream!: ReadableStreamDefaultController<Uint8Array>;
				const responseBody = new ReadableStream<Uint8Array>({
					start: (controller) => {
						stream = controller;
					},
					cancel: () => cancel(),
				});
				const settle = () => {
					link.pending.delete(id);
					request.signal.removeEventListener("abort", cancel);
				};
				const cancel = () => {
					if (!link.pending.has(id)) return;
					link.send({ type: "cancel", id });
					link.pending.get(id)?.fail("The request was cancelled");
				};
				link.pending.set(id, {
					respond: (status, headers) =>
						resolve(
							new Response(NULL_BODY_STATUSES.has(status) ? null : responseBody, {
								status,
								headers: headers.map(([name, value]) => [name, value]),
							}),
						),
					chunk: (bytes) => stream.enqueue(bytes),
					end: () => {
						settle();
						stream.close();
					},
					fail: (reason) => {
						settle();
						const failure = new Error(reason);
						reject(failure);
						stream.error(failure);
					},
				});
				request.signal.addEventListener("abort", cancel);
				link.send({
					type: "request",
					id,
					method: request.method,
					url: request.url,
					headers: [...request.headers],
					body,
				});
			});
		},
	});
});

export const layer = Layer.effect(Service, make);

/** One device's connection. */
interface Link {
	agents: DeviceAgents;
	/** The requests sent down it that are still answering, by id. */
	readonly pending: Map<string, PendingRequest>;
	/** Where each owner's answer to being asked to lend goes, by id: nothing when the device went. */
	readonly lendings: Map<string, (agent: LocalAgent | null | undefined) => void>;
	/** The tool calls its agents made that are still running, called off if it goes. */
	readonly toolCalls: Set<AbortController>;
	readonly send: (message: ServerToDevice) => void;
	/** Closes it, for a newer link or for the device being forgotten. */
	readonly end: () => void;
}

/** Where what the device sends back about a request goes. */
interface PendingRequest {
	readonly respond: (status: number, headers: ReadonlyArray<readonly [string, string]>) => void;
	readonly chunk: (bytes: Uint8Array) => void;
	readonly end: () => void;
	readonly fail: (reason: string) => void;
}

/** Sugabots tools offered to a lent agent while a turn asks it. */
export interface Toolbox {
	readonly list: () => ReadonlyArray<OfferedTool>;
	/** Runs tool `name` with `input` in the turn; a failure the agent should see is an error result. */
	readonly call: (
		name: string,
		input: unknown,
		signal: AbortSignal,
	) => Promise<{ text: string; isError: boolean }>;
}

type ToolUse = Extract<DeviceToServer, { type: "listTools" | "callTool" }>;

function isToolUse(message: DeviceToServer): message is ToolUse {
	return message.type === "listTools" || message.type === "callTool";
}

function askedInKey({ agentUrl, contextId }: { agentUrl: string; contextId: string }) {
	return `${agentUrl}\n${contextId}`;
}

/** A device's message, or nothing for one that isn't: a device is not trusted to send well-formed ones. */
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(deviceToServerSchema));

function receive(link: Link, message: DeviceToServer) {
	if (message.type === "agents") {
		link.agents = message.agents;
		return;
	}
	if (message.type === "lent") {
		link.lendings.get(message.id)?.(message.agent);
		return;
	}
	const request = link.pending.get(message.id);
	if (!request) return;
	switch (message.type) {
		case "response":
			return request.respond(message.status, message.headers);
		case "body":
			return request.chunk(Buffer.from(message.chunk, "base64"));
		case "end":
			return request.end();
		case "failed":
			return request.fail(message.reason);
	}
}

const TEXT = new TextDecoder();

/** The statuses a `Response` must be made without a body for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** The device isn't connected, so the app isn't running there or can't reach the server. */
export class DeviceOffline extends Data.TaggedError("DeviceOffline") implements UserFacing {
	get userMessage() {
		return userText`That computer isn't connected. Open the Sugabots desktop app on it, and try again.`;
	}
}

/** The device's owner said no, on the device. */
export class LendingDeclined extends Data.TaggedError("LendingDeclined") implements UserFacing {
	get userMessage() {
		return userText`Nothing was lent: it wasn't allowed on that computer.`;
	}
}

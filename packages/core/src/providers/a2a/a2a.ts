export * as A2A from "./a2a.ts";

import { type Part, Role, type StreamResponse, TaskState } from "@a2a-js/sdk";
import {
	ClientFactory,
	DefaultAgentCardResolver,
	JsonRpcTransportFactory,
	RestTransportFactory,
} from "@a2a-js/sdk/client";
import { userText } from "@sugabots/errors";
import { Context, Data, Effect, Layer, type Scope } from "effect";
import { Credentials } from "../../credentials/credentials.ts";
import { Ids } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { Egress, type EgressHttpClient } from "../network/egress.ts";

/**
 * Agents run by other services, reached over the Agent2Agent protocol (A2A)
 * through the official SDK: v1.0 natively, and v0.3 for an agent whose card
 * is still in that shape. Every request, the card's included, goes through
 * the egress policy.
 */
export interface Interface {
	/**
	 * Sends `text` to the agent at `endpoint`, as the next message of the
	 * conversation `contextId`, and streams what it answers. Closing the scope
	 * aborts the request.
	 */
	readonly send: (request: SendRequest) => Effect.Effect<Reply, RequestFailed, Scope.Scope>;
	/** What the agent at an address not yet saved says it is, which also shows the address and secret work. */
	readonly readCard: (endpoint: UnsavedEndpoint) => Effect.Effect<Card, RequestFailed>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/A2A") {}

export const make = Effect.gen(function* () {
	const egress = yield* Egress.Service;
	const credentials = yield* Credentials.Service;
	const ids = yield* Ids.Service;

	/** The agent's card, and a client for it, sending `headers` with every request. */
	const connect = (url: string, headers: Record<string, string>) =>
		Effect.tryPromise({
			try: async () => {
				const fetchImpl = egressFetch(egress, headers);
				const card = await new DefaultAgentCardResolver({
					fetchImpl,
					legacyCompat: { enabled: true },
				}).resolve(...cardLocation(url));
				const client = await new ClientFactory({
					transports: [
						new JsonRpcTransportFactory({ fetchImpl, legacyCompat: { enabled: true } }),
						new RestTransportFactory({ fetchImpl, legacyCompat: { enabled: true } }),
					],
				}).createFromAgentCard(card);
				return { card, client };
			},
			catch: (cause) =>
				new RequestFailed({ reason: `Reading the agent card failed: ${String(cause)}` }),
		});

	return Service.of({
		send: ({ endpoint, contextId, text }) =>
			Effect.gen(function* () {
				const aborts = new AbortController();
				yield* Effect.addFinalizer(() => Effect.sync(() => aborts.abort()));
				const headers =
					endpoint.secretHeader !== null && endpoint.secretEncrypted !== null
						? {
								[endpoint.secretHeader]: credentials.decrypt(
									endpoint.secretEncrypted,
									SECRET_PURPOSE,
								),
							}
						: {};
				const { client } = yield* connect(endpoint.url, headers);
				const messageId = yield* ids.next;
				const events = client.sendMessageStream(
					{
						tenant: "",
						message: {
							messageId,
							contextId,
							taskId: "",
							role: Role.ROLE_USER,
							parts: [textPart(text)],
							metadata: undefined,
							extensions: [],
							referenceTaskIds: [],
						},
						configuration: undefined,
						metadata: undefined,
					},
					{ signal: aborts.signal },
				);
				return replyFrom(events);
			}),
		readCard: (endpoint) =>
			Effect.map(
				connect(
					endpoint.url,
					endpoint.secretHeader && endpoint.secret
						? { [endpoint.secretHeader]: endpoint.secret }
						: {},
				),
				({ card }) => ({ name: card.name, description: card.description || null }),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** What `Credentials` seals an A2A agent's secret for, so it opens for nothing else. */
export const SECRET_PURPOSE = "agent.a2a-secret";

/** Where an agent is reached: its agent card's base URL, and the secret it expects, sealed. */
export interface Endpoint {
	url: string;
	secretHeader: string | null;
	secretEncrypted: string | null;
}

/** An address and secret somebody has typed, before they are saved and the secret sealed. */
export interface UnsavedEndpoint {
	url: string;
	secretHeader?: string | undefined;
	secret?: string | undefined;
}

/** What an agent's card says it is. */
export interface Card {
	name: string;
	description: string | null;
}

export interface SendRequest {
	endpoint: Endpoint;
	/** The A2A conversation the message belongs to, so the agent keeps its own history of it. */
	contextId: string;
	text: string;
}

export interface Reply {
	/** The answer's text, one delta at a time. It ends rather than throws when the request fails. */
	text: AsyncIterable<string>;
	/** How the answer ended. Meaningful only once `text` has been read to its end. */
	finished: Effect.Effect<void, RequestFailed>;
}

/** Reaching the agent, or what it answered, failed. */
export class RequestFailed
	extends Data.TaggedError("A2ARequestFailed")<{ readonly reason: string }>
	implements UserFacing
{
	override get message() {
		return `A2A request failed: ${this.reason}`;
	}
	get userMessage() {
		return userText`The agent this bot stands for could not be reached or did not answer.`;
	}
}

/**
 * The SDK's `fetch`: each request under the egress policy for its own host,
 * as the card may name another host than its own, with `headers` added.
 */
function egressFetch(egress: Egress.Interface, headers: Record<string, string>): EgressHttpClient {
	return (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const merged = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) merged.set(name, value);
		for (const [name, value] of Object.entries(headers)) merged.set(name, value);
		return egress.providers.for({ baseUrl: new URL(url).origin })(url, {
			...init,
			headers: merged,
		});
	};
}

/** Where the card is, as the resolver takes it: under the address, or the address itself when it names a card. */
function cardLocation(url: string): [baseUrl: string, path?: string] {
	return url.endsWith(".json") ? [url, ""] : [url.replace(/\/+$/, "")];
}

function textPart(text: string): Part {
	return {
		content: { $case: "text", value: text },
		metadata: undefined,
		filename: "",
		mediaType: "",
	};
}

/** States a task reports that end it badly. */
const FAILED_STATES = new Set([
	TaskState.TASK_STATE_FAILED,
	TaskState.TASK_STATE_REJECTED,
	TaskState.TASK_STATE_CANCELED,
]);
/** States whose status message is the agent asking people something, which is always shown. */
const ASKING_STATES = new Set([
	TaskState.TASK_STATE_INPUT_REQUIRED,
	TaskState.TASK_STATE_AUTH_REQUIRED,
]);

/**
 * The answer in `events`. Each artifact, and the agent's own words, start on
 * a new paragraph after what came before. A task's closing message is shown
 * only when no artifact answered: agents often repeat the whole answer in it.
 */
function replyFrom(events: AsyncIterable<StreamResponse>): Reply {
	let failure: RequestFailed | undefined;
	async function* text() {
		let lastSource: string | undefined;
		let artifactsAnswered = false;
		const say = (value: string, artifactId?: string) => {
			if (value === "") return "";
			const source = artifactId ?? "message";
			const separated = lastSource !== undefined && source !== lastSource ? `\n\n${value}` : value;
			lastSource = source;
			return separated;
		};
		try {
			for await (const event of events) {
				for (const piece of piecesOf(event)) {
					if ("failed" in piece) {
						failure = new RequestFailed({ reason: piece.failed });
						return;
					}
					if (piece.closing && artifactsAnswered) continue;
					if (piece.artifactId !== undefined && piece.text !== "") artifactsAnswered = true;
					const written = say(piece.text, piece.artifactId);
					if (written !== "") yield written;
				}
			}
		} catch (cause) {
			failure = new RequestFailed({ reason: `The request failed: ${String(cause)}` });
		}
	}
	return {
		text: text(),
		finished: Effect.suspend(() => (failure ? Effect.fail(failure) : Effect.void)),
	};
}

type Piece =
	| {
			text: string;
			artifactId?: string;
			/** The message a completed task ends with, which often repeats its artifacts. */
			closing?: true;
	  }
	| { failed: string };

/** What one event says to people, in order: its text, by artifact, or how the task failed. */
function piecesOf({ payload }: StreamResponse): Piece[] {
	switch (payload?.$case) {
		case "message":
			return [{ text: textOf(payload.value.parts) }];
		case "artifactUpdate":
			return payload.value.artifact
				? [
						{
							text: textOf(payload.value.artifact.parts),
							artifactId: payload.value.artifact.artifactId,
						},
					]
				: [];
		case "statusUpdate":
			return statusPieces(payload.value.status);
		case "task":
			return [
				...payload.value.artifacts.map((artifact) => ({
					text: textOf(artifact.parts),
					artifactId: artifact.artifactId,
				})),
				...statusPieces(payload.value.status),
			];
		case undefined:
			return [];
	}
}

function statusPieces(
	status: { state: TaskState; message?: { parts: Part[] } | undefined } | undefined,
): Piece[] {
	if (!status) return [];
	const said = status.message ? textOf(status.message.parts) : "";
	if (FAILED_STATES.has(status.state)) {
		return [{ failed: said || "The task did not finish" }];
	}
	if (status.state === TaskState.TASK_STATE_COMPLETED) return [{ text: said, closing: true }];
	return ASKING_STATES.has(status.state) ? [{ text: said }] : [];
}

function textOf(parts: readonly Part[]): string {
	return parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")).join("");
}

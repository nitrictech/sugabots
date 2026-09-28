/**
 * The one client every part of the workspace asks a model through: turns,
 * facilitation, summaries, compaction, model trials and provider settings.
 * It resolves the workspace's provider for a model, signs in where the
 * provider needs it, and streams the answer.
 */
export * as Models from "./models.ts";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
	APICallError,
	type AssistantModelMessage,
	type ModelMessage,
	stepCountIs,
	streamText,
	type ToolApprovalConfiguration,
	type ToolApprovalRequestOutput,
	type ToolModelMessage,
	type ToolSet,
} from "ai";
import { Context, Data, Duration, Effect, Layer, Schedule } from "effect";
import { ModelRequests } from "../../accounting/model-requests.ts";
import { streamLedger } from "../../accounting/stream-ledger.ts";
import type { Database } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { withChatgptAccess } from "../model-providers/chatgpt.ts";
import { type ModelRegistry, modelsDev } from "../model-providers/dialects/index.ts";
import { ModelProviderRepository } from "../model-providers/model-provider-repository.ts";
import { Egress, type EgressHttpClients } from "../network/egress.ts";

/**
 * What a turn keeps of its model's work. What each request used and cost is
 * in the `model_request` ledger, not here.
 */
export interface Accounting {
	/** How many requests the model made, which caps the steps a resumed turn has left. */
	modelCalls: number;
	/**
	 * The prompt's size at the turn's first model call: its history, system
	 * text and tools. What its tool calls return is left out, since the next
	 * turn keeps only a short record of it.
	 */
	contextTokens?: number;
	contextCapacity?: number;
}

export interface Input {
	workspaceId: string;
	/** What the request is for, which the ledger records as whose spend it is. */
	activity: ModelRequests.Activity;
	model: string;
	system: string;
	messages: readonly PromptMessage[];
	/** Server-owned SDK messages appended when resuming a suspended tool call. */
	continuationMessages?: readonly ModelMessage[];
	/** What the model may call during the turn. The SDK executes them as it streams. */
	tools?: ToolSet;
	toolApproval?: ToolApprovalConfiguration<ToolSet, unknown>;
	maxSteps?: number;
	signal: AbortSignal;
}

/** A request as its prompt is written; whoever sends it says what it is for. */
export type Prompt = Omit<Input, "activity">;

export interface PromptMessage {
	role: "user" | "assistant";
	content: string;
}

interface Streamed {
	text: AsyncIterable<string>;
	/**
	 * What the finished response cost. Meaningful only once `text` has been
	 * read to its end; asked for after an abort, it fails. An Effect rather than
	 * a promise so nothing exists until the caller asks, which is what keeps an
	 * aborted turn from leaving a rejection nobody handles.
	 */
	accounting: Effect.Effect<Accounting, ModelRequestFailed>;
	continuation?: Effect.Effect<
		{
			approvalRequests: ToolApprovalRequestOutput<ToolSet>[];
			responseMessages: Array<AssistantModelMessage | ToolModelMessage>;
		},
		ModelRequestFailed
	>;
}

/** Streams one model response for a workspace, through the provider it has configured. */
export interface Interface {
	/** The Effect ends once the stream has been opened; `text` is then read as it arrives. */
	stream(input: Input): Effect.Effect<Streamed, ModelRequestFailed, Database>;
}

/** The model could not be asked, or its provider failed the request. */
export class ModelRequestFailed
	extends Data.TaggedError("ModelRequestFailed")<{
		/** Why, for the logs. It may quote the provider's own response. */
		readonly message: string;
		readonly reason: ModelRequestFailure;
		readonly cause?: unknown;
	}>
	implements UserFacing
{
	/**
	 * A request that failed with `cause`. A refused request carries its reason
	 * in the response body, usually as `{"error":{"message":...}}`; that
	 * sentence is the one worth logging, ahead of the SDK's own summary.
	 */
	static fromCause(cause: unknown): ModelRequestFailed {
		if (!APICallError.isInstance(cause)) {
			const message = cause instanceof Error ? cause.message : String(cause);
			return new ModelRequestFailed({ message, reason: "unavailable", cause });
		}
		const status = cause.statusCode;
		const said = providerSaid(cause.responseBody) ?? cause.message;
		return new ModelRequestFailed({
			message: `${status ? `Provider returned ${status}` : "Provider refused"}: ${said}`,
			reason:
				status === 401 || status === 403
					? "rejected"
					: status === 429
						? "rateLimited"
						: "unavailable",
			cause,
		});
	}

	get userMessage() {
		return MODEL_REQUEST_USER_MESSAGES[this.reason];
	}
}

type ModelRequestFailure =
	| "noProvider"
	| "signInFailed"
	| "rejected"
	| "rateLimited"
	| "unavailable"
	| "timedOut";

const MODEL_REQUEST_USER_MESSAGES: Record<ModelRequestFailure, UserMessage> = {
	noProvider: UserMessage.of`No active provider offers this model.`,
	signInFailed: UserMessage.of`The model provider's ChatGPT sign-in failed. Sign in again.`,
	rejected: UserMessage.of`The model provider refused the request. Check its API key.`,
	rateLimited: UserMessage.of`The model provider is busy. Try again shortly.`,
	unavailable: UserMessage.of`The model provider could not answer.`,
	timedOut: UserMessage.of`The model did not answer in time.`,
};

interface Options {
	modelProviders: Pick<ModelProviderRepository.Interface, "resolve" | "renewChatgptTokens">;
	httpClients: EgressHttpClients;
	/** Where every request the model makes is recorded. */
	requests: ModelRequests.Interface;
	/** What a request is priced from when its provider doesn't say what it cost. */
	registry: Pick<ModelRegistry, "cost" | "version">;
}

export function make({ modelProviders, httpClients, requests, registry }: Options): Interface {
	return {
		stream: (input) =>
			Effect.gen(function* () {
				const resolved = yield* modelProviders.resolve(input.workspaceId, input.model);
				if (!resolved) {
					return yield* new ModelRequestFailed({
						message: `No active provider offers the model "${input.model}"`,
						reason: "noProvider",
					});
				}
				const connection = yield* withChatgptAccess(
					modelProviders,
					httpClients,
					input.workspaceId,
					resolved,
				).pipe(
					Effect.mapError(
						(failure) =>
							new ModelRequestFailed({
								message: failure.message,
								reason: "signInFailed",
								cause: failure,
							}),
					),
				);
				const fetch = httpClients.for(connection);
				const ledger = yield* streamLedger({
					requests,
					registry,
					workspaceId: input.workspaceId,
					activity: input.activity,
					model: input.model,
					connection,
				});
				const codex = connection.preset === "chatgpt";
				// The SDK does not throw a provider's error into the text stream: it
				// reports it here and ends the stream, and whatever is asked of the
				// result afterwards fails with "No output generated". Keeping the
				// first error is what lets the failure say why the provider refused.
				let providerFailure: unknown;
				const approvalRequests: ToolApprovalRequestOutput<ToolSet>[] = [];
				const result = streamText({
					model: languageModel(connection, input.model, fetch),
					// The Codex backend takes the system prompt only as `instructions`,
					// and keeps nothing between requests, so reasoning has to travel with them.
					...(codex
						? {
								providerOptions: {
									openai: {
										instructions: input.system,
										store: false,
										include: ["reasoning.encrypted_content"],
									},
								},
							}
						: { system: input.system }),
					messages: [...input.messages, ...(input.continuationMessages ?? [])],
					tools: input.tools,
					toolApproval: input.toolApproval,
					abortSignal: input.signal,
					onChunk: ({ chunk }) => {
						if (chunk.type === "tool-approval-request" && !chunk.isAutomatic) {
							approvalRequests.push(chunk);
						}
					},
					onLanguageModelCallStart: () => ledger.started(),
					onLanguageModelCallEnd: ({ usage }) => ledger.ended(usage),
					onError: ({ error }) => {
						providerFailure ??= error;
						return ledger.failed();
					},
					onAbort: () => ledger.aborted(),
					stopWhen: stepCountIs(input.maxSteps ?? 8),
					maxRetries: 0,
				});
				return {
					text: result.textStream,
					accounting: Effect.tryPromise({
						try: async () => {
							const steps = await result.steps;
							if (providerFailure !== undefined) throw providerFailure;
							return {
								modelCalls: steps.length,
								contextTokens: steps[0]?.usage.inputTokens,
							};
						},
						catch: (cause) => ModelRequestFailed.fromCause(providerFailure ?? cause),
					}),
					continuation: Effect.tryPromise({
						try: async () => ({
							approvalRequests: [...approvalRequests],
							responseMessages: await result.responseMessages,
						}),
						catch: (cause) => ModelRequestFailed.fromCause(cause),
					}),
				};
			}),
	};
}

function languageModel(
	connection: ModelProviderRepository.ProviderEndpoint,
	modelId: string,
	fetch: typeof globalThis.fetch,
) {
	if (connection.apiFormat === "anthropic") {
		return createAnthropic({
			apiKey: connection.apiKey ?? "",
			baseURL: connection.baseUrl.endsWith("/v1")
				? connection.baseUrl
				: `${connection.baseUrl.replace(/\/$/, "")}/v1`,
			headers: connection.headers,
			fetch,
		})(modelId);
	}
	const openai = createOpenAI({
		apiKey: connection.apiKey ?? "ollama",
		baseURL: connection.baseUrl,
		headers: connection.headers,
		fetch,
	});
	// The Codex backend speaks only the Responses API.
	return connection.preset === "chatgpt" ? openai.responses(modelId) : openai.chat(modelId);
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Models") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const modelProviders = yield* ModelProviderRepository.Service;
		const egress = yield* Egress.Service;
		const requests = yield* ModelRequests.Service;
		return make({ modelProviders, httpClients: egress.providers, requests, registry: modelsDev });
	}),
).pipe(Layer.provide(Layer.mergeAll(ModelProviderRepository.layer, ModelRequests.layer)));

/**
 * Asks a model for one word, to learn whether it will answer at all. What
 * listing a provider's models cannot tell: that a model is gated behind a
 * setting on the provider's side, that a key has no credit, that the model
 * refuses the request shape. Fails with the provider's reason.
 */
export function probe(
	model: Interface,
	workspaceId: string,
	modelId: string,
): Effect.Effect<void, ModelRequestFailed, Database> {
	return Effect.scoped(
		Effect.gen(function* () {
			const stop = new AbortController();
			yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()));
			const generated = yield* model.stream({
				workspaceId,
				activity: { purpose: "probe" },
				model: modelId,
				system: "Answer with the single word OK.",
				messages: [{ role: "user", content: "OK?" }],
				signal: stop.signal,
			});
			yield* forEachDelta(generated.text, stop, () => Effect.void);
			yield* generated.accounting;
		}).pipe(
			Effect.timeoutOrElse({
				duration: "30 seconds",
				orElse: () =>
					Effect.fail(
						new ModelRequestFailed({
							message: "Model did not answer within 30 seconds",
							reason: "timedOut",
						}),
					),
			}),
		),
	);
}

function providerSaid(body: string | undefined): string | undefined {
	if (!body) return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const error = (parsed as { error?: unknown }).error;
		const message =
			typeof error === "object" && error !== null
				? (error as { message?: unknown }).message
				: (parsed as { message?: unknown }).message;
		return typeof message === "string" && message ? message : undefined;
	} catch {
		return body.length <= 300 ? body : undefined;
	}
}

/**
 * Reads the model's text one delta at a time and runs `onDelta` for each.
 *
 * Interrupting this aborts the request through `stop`, and does not wait for
 * the iterator to wind down: the SDK's generator may be parked on a network
 * read that only the abort will end, so waiting on it would deadlock.
 */
export const forEachDelta = <E, R>(
	text: AsyncIterable<string>,
	stop: AbortController,
	onDelta: (delta: string) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E | ModelRequestFailed, R> => {
	const iterator = text[Symbol.asyncIterator]();
	const next = Effect.callback<IteratorResult<string>, ModelRequestFailed>((resume) => {
		iterator.next().then(
			(result) => resume(Effect.succeed(result)),
			(cause) => resume(Effect.fail(ModelRequestFailed.fromCause(cause))),
		);
		return Effect.sync(() => stop.abort());
	});
	const loop: Effect.Effect<void, E | ModelRequestFailed, R> = Effect.flatMap(next, (result) =>
		result.done ? Effect.void : Effect.andThen(onDelta(result.value), loop),
	);
	return loop;
};

/**
 * Asking a model for an answer in a particular shape, and dealing with the
 * times it does not give one.
 *
 * A model that returns prose where JSON was asked for, or a word that is not
 * one of the choices, has not failed in the way a timeout or a dead connection
 * has. It is usually a one-off, and asking again usually works. Retrying is far
 * cheaper than giving up, which leaves a thread without its summary or has the
 * facilitator decide that nobody speaks.
 *
 * Only the shape is retried here. A timeout is not — the next attempt would
 * cost the same again — and neither is anything the database or the stream
 * raised, which asking again will not change.
 */

/** The model answered, but not in a shape we can use. */
export class UnusableAnswer
	extends Data.TaggedError("UnusableAnswer")<{
		/** What was wrong with the answer. */
		readonly reason: string;
	}>
	implements UserFacing
{
	override get message() {
		return this.reason;
	}
	get userMessage() {
		return UserMessage.of`The model's answer could not be used.`;
	}
}

/** The model did not finish answering within the time allowed. */
export class AnswerTimedOut
	extends Data.TaggedError("AnswerTimedOut")<{
		/** Which answer, and the limit it ran past. */
		readonly message: string;
	}>
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`The model did not answer in time.`;
	}
}

/**
 * Three attempts, a moment apart.
 *
 * Short, because each attempt is a model call somebody is waiting on, and
 * because a prompt the model cannot follow will not start working on the tenth
 * try — that is a prompt to fix, not a failure to absorb. The small gap is
 * jittered so a wave of threads hitting the same bad patch does not re-ask in
 * lockstep.
 */
const RETRY_UNUSABLE = Schedule.recurs(2).pipe(
	Schedule.addDelay(() => Effect.succeed(Duration.millis(250))),
	Schedule.jittered,
);

/**
 * Asks again when the answer was the wrong shape, and gives up on anything
 * else. What the caller does after the last attempt is its own business:
 * falling back to a safe default, or recording the failure.
 */
export const retryUnusable = <A, E, R>(ask: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.retry(ask, {
		while: (failure: E) => failure instanceof UnusableAnswer,
		schedule: RETRY_UNUSABLE,
	});

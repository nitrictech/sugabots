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
import { Data, Effect } from "effect";
import type { Database } from "../../database/database.ts";
import type { TurnUsage } from "../../database/schema.ts";
import type { ModelProviderStore } from "../../providers/model-providers/store.ts";
import type { EgressHttpClients } from "../../providers/network/egress.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";

export interface ModelAccounting {
	usage: TurnUsage;
	reportedCost?: number;
	contextTokens?: number;
	contextCapacity?: number;
}

export interface TurnModelInput {
	workspaceId: string;
	model: string;
	system: string;
	messages: readonly TurnPromptMessage[];
	/** Server-owned SDK messages appended when resuming a suspended tool call. */
	continuationMessages?: readonly ModelMessage[];
	/** What the model may call during the turn. The SDK executes them as it streams. */
	tools?: ToolSet;
	toolApproval?: ToolApprovalConfiguration<ToolSet, unknown>;
	maxSteps?: number;
	signal: AbortSignal;
}

export interface TurnPromptMessage {
	role: "user" | "assistant";
	content: string;
}

export interface TurnModelResult {
	text: AsyncIterable<string>;
	/**
	 * What the finished response cost. Meaningful only once `text` has been
	 * read to its end; asked for after an abort, it fails. An Effect rather than
	 * a promise so nothing exists until the caller asks, which is what keeps an
	 * aborted turn from leaving a rejection nobody handles.
	 */
	accounting: Effect.Effect<ModelAccounting, ModelRequestFailed>;
	continuation?: Effect.Effect<
		{
			approvalRequests: ToolApprovalRequestOutput<ToolSet>[];
			responseMessages: Array<AssistantModelMessage | ToolModelMessage>;
		},
		ModelRequestFailed
	>;
}

/** Streams one model response for a workspace, through the provider it has configured. */
export interface TurnModel {
	/** The Effect ends once the stream has been opened; `text` is then read as it arrives. */
	stream(input: TurnModelInput): Effect.Effect<TurnModelResult, ModelRequestFailed, Database>;
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

type ModelRequestFailure = "noProvider" | "rejected" | "rateLimited" | "unavailable" | "timedOut";

const MODEL_REQUEST_USER_MESSAGES: Record<ModelRequestFailure, UserMessage> = {
	noProvider: UserMessage.of`No active provider offers this model.`,
	rejected: UserMessage.of`The model provider refused the request. Check its API key.`,
	rateLimited: UserMessage.of`The model provider is busy. Try again shortly.`,
	unavailable: UserMessage.of`The model provider could not answer.`,
	timedOut: UserMessage.of`The model did not answer in time.`,
};

export interface TurnModelOptions {
	modelProviders: Pick<ModelProviderStore, "resolve">;
	httpClients: EgressHttpClients;
}

export function workspaceTurnModel({ modelProviders, httpClients }: TurnModelOptions): TurnModel {
	return {
		stream: (input) =>
			Effect.gen(function* () {
				const connection = yield* modelProviders.resolve(input.workspaceId, input.model);
				if (!connection) {
					return yield* new ModelRequestFailed({
						message: `No active provider offers the model "${input.model}"`,
						reason: "noProvider",
					});
				}
				const fetch = httpClients.for(connection);
				const model =
					connection.apiFormat === "anthropic"
						? createAnthropic({
								apiKey: connection.apiKey ?? "",
								baseURL: connection.baseUrl.endsWith("/v1")
									? connection.baseUrl
									: `${connection.baseUrl.replace(/\/$/, "")}/v1`,
								headers: connection.headers,
								fetch,
							})(input.model)
						: createOpenAI({
								apiKey: connection.apiKey ?? "ollama",
								baseURL: connection.baseUrl,
								headers: connection.headers,
								fetch,
							}).chat(input.model);
				// The SDK does not throw a provider's error into the text stream: it
				// reports it here and ends the stream, and whatever is asked of the
				// result afterwards fails with "No output generated". Keeping the
				// first error is what lets the failure say why the provider refused.
				let providerFailure: unknown;
				const approvalRequests: ToolApprovalRequestOutput<ToolSet>[] = [];
				const result = streamText({
					model,
					system: input.system,
					messages: [...input.messages, ...(input.continuationMessages ?? [])],
					tools: input.tools,
					toolApproval: input.toolApproval,
					abortSignal: input.signal,
					onChunk: ({ chunk }) => {
						if (chunk.type === "tool-approval-request" && !chunk.isAutomatic) {
							approvalRequests.push(chunk);
						}
					},
					onError: ({ error }) => {
						providerFailure ??= error;
					},
					stopWhen: stepCountIs(input.maxSteps ?? 8),
					maxRetries: 0,
				});
				return {
					text: result.textStream,
					accounting: Effect.tryPromise({
						try: async () => {
							const [usage, steps] = await Promise.all([result.usage, result.steps]);
							if (providerFailure !== undefined) throw providerFailure;
							return {
								usage: {
									modelCalls: steps.length,
									inputTokens: usage.inputTokens,
									outputTokens: usage.outputTokens,
									totalTokens: usage.totalTokens,
									reasoningTokens: usage.outputTokenDetails.reasoningTokens,
									cachedInputTokens: usage.inputTokenDetails.cacheReadTokens,
								},
								contextTokens: steps.at(-1)?.usage.inputTokens,
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

/**
 * Asks a model for one word, to learn whether it will answer at all. What
 * listing a provider's models cannot tell: that a model is gated behind a
 * setting on the provider's side, that a key has no credit, that the model
 * refuses the request shape. Fails with the provider's reason.
 */
export function probeModel(
	model: TurnModel,
	workspaceId: string,
	modelId: string,
): Effect.Effect<void, ModelRequestFailed, Database> {
	return Effect.scoped(
		Effect.gen(function* () {
			const stop = new AbortController();
			yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()));
			const generated = yield* model.stream({
				workspaceId,
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

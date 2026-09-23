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
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import type { TurnUsage } from "../../database/schema.ts";
import type { ModelProviderStore } from "../../providers/model-providers/store.ts";
import type { EgressHttpClients } from "../../providers/network/egress.ts";

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
	messages: TurnPromptMessage[];
	/** Server-owned SDK messages appended when resuming a suspended tool call. */
	continuationMessages?: ModelMessage[];
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
	accounting: Effect.Effect<ModelAccounting, Error>;
	continuation?: Effect.Effect<
		{
			approvalRequests: ToolApprovalRequestOutput<ToolSet>[];
			responseMessages: Array<AssistantModelMessage | ToolModelMessage>;
		},
		Error
	>;
}

/** Streams one model response for a workspace, through the provider it has configured. */
export interface TurnModel {
	/** The Effect ends once the stream has been opened; `text` is then read as it arrives. */
	stream(input: TurnModelInput): Effect.Effect<TurnModelResult, Error, Database>;
}

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
					return yield* Effect.fail(
						new Error(`No active provider offers the model "${input.model}"`),
					);
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
				// first error is what lets the turn say what the provider said.
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
							if (providerFailure !== undefined) {
								throw new Error(describeModelFailure(providerFailure));
							}
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
						catch: (cause) =>
							new Error(
								describeModelFailure(providerFailure === undefined ? cause : providerFailure),
							),
					}),
					continuation: Effect.tryPromise({
						try: async () => ({
							approvalRequests: [...approvalRequests],
							responseMessages: await result.responseMessages,
						}),
						catch: (cause) => new Error(describeModelFailure(cause)),
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
): Effect.Effect<void, Error, Database> {
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
				orElse: () => Effect.fail(new Error("Model did not answer within 30 seconds")),
			}),
		),
	);
}

/**
 * What went wrong, in the provider's words where it had any. A refused
 * request carries its reason in the response body, usually as
 * `{"error":{"message":...}}`; that sentence is the one worth reading, ahead
 * of the SDK's own summary of the same response.
 */
export function describeModelFailure(cause: unknown): string {
	if (APICallError.isInstance(cause)) {
		const status = cause.statusCode ? `Provider returned ${cause.statusCode}` : "Provider refused";
		const said = providerSaid(cause.responseBody) ?? cause.message;
		return `${status}: ${said}`;
	}
	return cause instanceof Error ? cause.message : String(cause);
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
): Effect.Effect<void, E | Error, R> => {
	const iterator = text[Symbol.asyncIterator]();
	const next = Effect.callback<IteratorResult<string>, Error>((resume) => {
		iterator.next().then(
			(result) => resume(Effect.succeed(result)),
			(cause) => resume(Effect.fail(cause instanceof Error ? cause : new Error(String(cause)))),
		);
		return Effect.sync(() => stop.abort());
	});
	const loop: Effect.Effect<void, E | Error, R> = Effect.flatMap(next, (result) =>
		result.done ? Effect.void : Effect.andThen(onDelta(result.value), loop),
	);
	return loop;
};

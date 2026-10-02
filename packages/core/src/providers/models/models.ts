/**
 * The one client every part of the workspace asks a model through: turns,
 * facilitation, summaries, compaction, model trials and provider settings.
 * It resolves the workspace's provider for a model, signs in where the
 * provider needs it, and either streams the response or collects a whole
 * answer.
 */
export * as Models from "./models.ts";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
	APICallError,
	type AssistantModelMessage,
	type ModelMessage,
	stepCountIs,
	streamText,
	type ToolApprovalConfiguration,
	type ToolApprovalRequestOutput,
	type ToolModelMessage,
	type ToolResultPart,
	type ToolSet,
} from "ai";
import { Context, Data, Duration, Effect, Layer, Ref, Schedule, type Scope } from "effect";
import { ModelRequests } from "../../accounting/model-requests.ts";
import { streamLedger } from "../../accounting/stream-ledger.ts";
import type { Database } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { type ModelRegistry, modelsDev } from "../model-providers/dialects/index.ts";
import { ModelProviderRepository } from "../model-providers/model-provider-repository.ts";
import { withSignInAccess } from "../model-providers/sign-in/sign-in.ts";
import { Egress, type EgressHttpClients } from "../network/egress.ts";

/** What asking a model once is about: which model, for which workspace, and what it is told. */
export interface Prompt {
	workspaceId: string;
	model: string;
	system: string;
	messages: readonly PromptMessage[];
}

export interface PromptMessage {
	role: "user" | "assistant";
	content: string;
}

/** A response streamed as it arrives, with tools the model may call along the way. */
export interface StreamRequest extends Prompt {
	/** What the request is for, which the ledger records as whose spend it is. */
	activity: ModelRequests.Activity;
	/** Server-owned SDK messages appended when resuming a suspended tool call. */
	continuationMessages?: readonly ModelMessage[];
	/** What the model may call. The SDK executes them as it streams. */
	tools?: ToolSet;
	toolApproval?: ToolApprovalConfiguration<ToolSet, unknown>;
	/**
	 * How many model calls the response may take, counting one per round of
	 * tool calls. The last is told to answer rather than call more tools.
	 */
	maxSteps: number;
}

/** A whole answer, given up on if it runs past either limit. */
export interface AnswerRequest extends Prompt {
	/** What the request is for, which the ledger records as whose spend it is and the logs name it by. */
	activity: ModelRequests.Activity;
	maxCharacters: number;
	timeout: Duration.Input;
}

export interface Streamed {
	/** The response's text, one delta at a time. Read it with {@link forEachDelta}. */
	text: AsyncIterable<string>;
	/**
	 * How the response ended. Meaningful only once `text` has been read to its
	 * end; asked for after an abort, it fails. An Effect rather than a promise
	 * so nothing exists until the caller asks, which is what keeps an aborted
	 * response from leaving a rejection nobody handles.
	 */
	finished: Effect.Effect<Finished, RequestFailed>;
}

/**
 * What a finished response leaves for whoever carries it on. What each
 * request used and cost is in the `model_request` ledger, not here.
 */
export interface Finished {
	/** How many model calls the response took, one per round of tool calls. */
	modelCalls: number;
	/**
	 * The prompt's size at the response's first model call: its history, system
	 * text and tools. What its tool calls return is left out.
	 */
	contextTokens?: number;
	/** The tool calls waiting on someone's approval. */
	approvalRequests: ToolApprovalRequestOutput<ToolSet>[];
	/** The messages that carry the response on once those calls are decided. */
	responseMessages: Array<AssistantModelMessage | ToolModelMessage>;
}

export interface Answer {
	text: string;
	/** The prompt's size, as in {@link Finished}. */
	contextTokens?: number;
}

export interface Interface {
	/**
	 * Opens a streamed response. The Effect ends once the stream is open, and
	 * closing its scope aborts the request, along with any tool call still
	 * running inside it.
	 */
	stream(request: StreamRequest): Effect.Effect<Streamed, RequestFailed, Database | Scope.Scope>;
	/** Asks for one whole answer, in a single model call. */
	answer(
		request: AnswerRequest,
	): Effect.Effect<Answer, RequestFailed | AnswerTimedOut | UnusableAnswer, Database>;
}

/**
 * logModelFailure logs what is known about a failed model request: `failure`
 * with its cause chain, every error the provider reported in the stream, and
 * whether `signal` had aborted. For an HTTP failure that includes the
 * provider's address, status, headers and body. The request body is left out,
 * since it holds the conversation.
 */
function logModelFailure(
	failure: unknown,
	streamErrors: readonly unknown[],
	signal: AbortSignal,
): Effect.Effect<void> {
	return Effect.logWarning(
		`A model request failed: ${logJson({
			failure: streamErrors.includes(failure) ? "the first of streamErrors" : causeChain(failure),
			streamErrors: streamErrors.map(causeChain),
			// False means the request's scope was still open when this was logged: nothing here aborted it.
			abortedHere: signal.aborted,
			...(signal.aborted ? { abortReason: causeChain(signal.reason) } : {}),
		})}`,
	);
}

/** The longest any one string in a logged failure may be, since a body can echo a whole prompt. */
const MAX_LOGGED_STRING = 4_000;

/**
 * logJson returns `value` as one line of JSON, so a logger can't cut nested
 * fields short, with each string capped at `MAX_LOGGED_STRING` characters.
 */
function logJson(value: unknown): string {
	return JSON.stringify(value, (_key, field) =>
		typeof field === "string" && field.length > MAX_LOGGED_STRING
			? `${field.slice(0, MAX_LOGGED_STRING)}…`
			: field,
	);
}

/** How many causes deep `causeChain` follows, so a cycle can't run forever. */
const MAX_CAUSE_DEPTH = 5;

/**
 * causeChain describes `error` and each error it was caused by, with their
 * stacks and the fields providers and the SDK put on them: an HTTP address,
 * status, response, code or data.
 */
function causeChain(error: unknown): Array<Record<string, unknown>> {
	const chain: Array<Record<string, unknown>> = [];
	for (let current = error, depth = 0; current !== undefined && depth < MAX_CAUSE_DEPTH; depth++) {
		if (!(current instanceof Error)) {
			chain.push({ value: current });
			break;
		}
		const fields = current as Error & Record<string, unknown>;
		chain.push({
			name: current.name,
			message: current.message,
			stack: current.stack,
			...(APICallError.isInstance(current)
				? { url: current.url, status: current.statusCode, headers: current.responseHeaders }
				: {}),
			...definedFields(fields, ["statusCode", "responseBody", "code", "data"]),
		});
		current = current.cause;
	}
	return chain;
}

/** definedFields returns those of `names` that `record` has a value for. */
function definedFields(record: Record<string, unknown>, names: readonly string[]) {
	return Object.fromEntries(
		names.flatMap((name) => (record[name] === undefined ? [] : [[name, record[name]]])),
	);
}

/**
 * loggingFailure passes `text` through, calling `log` with whatever ends it
 * early, since a reader of the text alone can't say what else went wrong.
 */
async function* loggingFailure<T>(text: AsyncIterable<T>, log: (cause: unknown) => void) {
	try {
		yield* text;
	} catch (cause) {
		log(cause);
		throw cause;
	}
}

/** The model could not be asked, or its provider failed the request. */
export class RequestFailed
	extends Data.TaggedError("ModelRequestFailed")<{
		/** Why, for the logs. It may quote the provider's own response. */
		readonly message: string;
		readonly reason: RequestFailure;
		readonly cause?: unknown;
	}>
	implements UserFacing
{
	/**
	 * A request that failed with `cause`. A refused request carries its reason
	 * in the response body, usually as `{"error":{"message":...}}`; that
	 * sentence is the one worth logging, ahead of the SDK's own summary.
	 */
	static fromCause(cause: unknown): RequestFailed {
		if (!APICallError.isInstance(cause)) {
			const message = cause instanceof Error ? cause.message : String(cause);
			return new RequestFailed({ message, reason: "unavailable", cause });
		}
		const status = cause.statusCode;
		const said = providerSaid(cause.responseBody) ?? cause.message;
		return new RequestFailed({
			message: `${status ? `Provider returned ${status}` : "Provider refused"}: ${said}`,
			reason: reasonFor(status, cause.responseBody),
			cause,
		});
	}

	/**
	 * Whether the same request may work if sent again: the provider was busy,
	 * timed out or failed. A refusal, such as a rejected key, no credit or a
	 * request it couldn't accept, would only be refused again.
	 */
	get mayRetry(): boolean {
		return this.reason === "rateLimited" || this.reason === "unavailable";
	}

	get userMessage() {
		return REQUEST_USER_MESSAGES[this.reason];
	}
}

/** reasonFor names why a provider answered a request with `status` and `body`. */
function reasonFor(status: number | undefined, body: string | undefined): RequestFailure {
	if (status === 401 || status === 403) return "rejected";
	// OpenAI, and the servers that copy its errors, report an exhausted quota as a 429.
	if (status === 402 || (status === 429 && errorCode(body) === "insufficient_quota")) {
		return "outOfCredit";
	}
	if (status === 429) return "rateLimited";
	// A timed-out request may go through next time; any other 4xx is a problem with the request itself.
	if (status !== undefined && status >= 400 && status < 500 && status !== 408) return "refused";
	return "unavailable";
}

type RequestFailure =
	| "noProvider"
	| "signInFailed"
	| "rejected"
	| "outOfCredit"
	| "refused"
	| "rateLimited"
	| "unavailable";

const REQUEST_USER_MESSAGES: Record<RequestFailure, UserMessage> = {
	noProvider: UserMessage.of`No active provider offers this model.`,
	signInFailed: UserMessage.of`The model provider's sign-in failed. Sign in again.`,
	rejected: UserMessage.of`The model provider refused the request. Check its API key.`,
	outOfCredit: UserMessage.of`The model provider declined the request because of a billing issue, such as no credit left on the account or this bot's API key. A workspace admin can check with the provider.`,
	refused: UserMessage.of`The model provider couldn't accept this request.`,
	rateLimited: UserMessage.of`The model provider is busy. Try again shortly.`,
	unavailable: UserMessage.of`The model provider could not answer.`,
};

interface Options {
	modelProviders: Pick<ModelProviderRepository.Interface, "resolve" | "renewOAuthTokens">;
	httpClients: EgressHttpClients;
	/** Where every request the model makes is recorded. */
	requests: ModelRequests.Interface;
	/** What a request is priced from when its provider doesn't say what it cost. */
	registry: Pick<ModelRegistry, "cost" | "version">;
}

export function make({ modelProviders, httpClients, requests, registry }: Options): Interface {
	return fromStream((input) =>
		Effect.gen(function* () {
			const signal = yield* Effect.abortSignal;
			const resolved = yield* modelProviders.resolve(input.workspaceId, input.model);
			if (!resolved) {
				return yield* new RequestFailed({
					message: `No active provider offers the model "${input.model}"`,
					reason: "noProvider",
				});
			}
			const connection = yield* withSignInAccess(
				modelProviders,
				httpClients,
				input.workspaceId,
				resolved,
			).pipe(
				Effect.mapError(
					(failure) =>
						new RequestFailed({
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
			// Every error the stream reports, not just the first, so the log shows what led to the failure.
			const streamErrors: unknown[] = [];
			// The SDK's callbacks run outside Effect, so they log through this.
			const runLog = Effect.runForkWith(yield* Effect.context<never>());
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
				abortSignal: signal,
				onChunk: ({ chunk }) => {
					if (chunk.type === "tool-approval-request" && !chunk.isAutomatic) {
						approvalRequests.push(chunk);
					}
				},
				onLanguageModelCallStart: () => ledger.started(),
				onLanguageModelCallEnd: ({ usage }) => ledger.ended(usage),
				onError: ({ error }) => {
					providerFailure ??= error;
					streamErrors.push(error);
					return ledger.failed();
				},
				onAbort: () => {
					runLog(
						Effect.logWarning(
							`A model request was aborted here: ${logJson({ reason: causeChain(signal.reason) })}`,
						),
					);
					return ledger.aborted();
				},
				// A response stopped by the step limit on a round of tool calls ends
				// with nothing said, so the last round is told to answer. The note
				// rides on the newest tool result, which no provider has cached yet:
				// changing the tools or system text instead would cost the cache
				// every earlier call built.
				prepareStep: ({ stepNumber, messages }) =>
					stepNumber === input.maxSteps - 1 ? { messages: withLastStepNote(messages) } : undefined,
				stopWhen: stepCountIs(input.maxSteps),
				maxRetries: 0,
			});
			return {
				text: loggingFailure(result.textStream, (cause) =>
					runLog(logModelFailure(cause, streamErrors, signal)),
				),
				finished: Effect.tryPromise({
					try: async () => {
						const [steps, responseMessages] = await Promise.all([
							result.steps,
							result.responseMessages,
						]);
						if (providerFailure !== undefined) throw providerFailure;
						return {
							modelCalls: steps.length,
							contextTokens: steps[0]?.usage.inputTokens,
							approvalRequests: [...approvalRequests],
							responseMessages,
						};
					},
					catch: (cause) => providerFailure ?? cause,
				}).pipe(
					Effect.tapError((failure) => logModelFailure(failure, streamErrors, signal)),
					Effect.mapError(RequestFailed.fromCause),
				),
			};
		}),
	);
}

/**
 * A client whose whole answers are collected from `stream`. How the real one
 * is built, and how a test builds one from a scripted stream.
 */
export function fromStream(stream: Interface["stream"]): Interface {
	return {
		stream,
		answer: (request) =>
			Effect.scoped(
				Effect.gen(function* () {
					const streamed = yield* stream({ ...request, maxSteps: 1 });
					const collected = yield* Ref.make("");
					yield* forEachDelta(streamed.text, (delta) =>
						Ref.updateAndGet(collected, (soFar) => soFar + delta).pipe(
							Effect.filterOrFail(
								(soFar) => soFar.length <= request.maxCharacters,
								() =>
									new UnusableAnswer({
										reason: `The ${request.activity.purpose} answer ran past ${request.maxCharacters} characters`,
									}),
							),
							Effect.asVoid,
						),
					);
					const { contextTokens } = yield* streamed.finished;
					return { text: yield* Ref.get(collected), contextTokens };
				}),
			).pipe(
				Effect.timeoutOrElse({
					duration: request.timeout,
					orElse: () =>
						Effect.fail(
							new AnswerTimedOut({ message: `The ${request.activity.purpose} answer timed out` }),
						),
				}),
			),
	};
}

const LAST_STEP_NOTE =
	"(This is your last step: you cannot call tools any more. Answer now from what you have found, and say what you could not check.)";

/** `messages` with {@link LAST_STEP_NOTE} added to the newest tool result, if the last message has one. */
function withLastStepNote(messages: ModelMessage[]): ModelMessage[] {
	const last = messages.at(-1);
	if (last?.role !== "tool") return messages;
	const resultAt = last.content.findLastIndex((part) => part.type === "tool-result");
	const result = last.content[resultAt];
	if (result?.type !== "tool-result") return messages;
	const content = last.content.with(resultAt, { ...result, output: noted(result.output) });
	return [...messages.slice(0, -1), { ...last, content }];
}

/** A tool's output with {@link LAST_STEP_NOTE} after it, in the output's own form where it has room for text. */
function noted(output: ToolResultPart["output"]): ToolResultPart["output"] {
	switch (output.type) {
		case "text":
		case "error-text":
			return { ...output, value: `${output.value}\n\n${LAST_STEP_NOTE}` };
		case "json":
			return { type: "text", value: `${JSON.stringify(output.value)}\n\n${LAST_STEP_NOTE}` };
		case "error-json":
			return {
				type: "error-text",
				value: `${JSON.stringify(output.value)}\n\n${LAST_STEP_NOTE}`,
			};
		case "content":
			return { ...output, value: [...output.value, { type: "text", text: LAST_STEP_NOTE }] };
		case "execution-denied":
			return {
				...output,
				reason: output.reason ? `${output.reason}\n\n${LAST_STEP_NOTE}` : LAST_STEP_NOTE,
			};
	}
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
	if (connection.preset === "openrouter") {
		return createOpenRouter({
			apiKey: connection.apiKey ?? "",
			baseURL: connection.baseUrl,
			headers: connection.headers,
			fetch,
			// Asks for usage at the end of each stream, which costs are recorded from.
			compatibility: "strict",
		})(modelId);
	}
	const openai = createOpenAI({
		// A local server such as Ollama takes no key, but the SDK insists on one.
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
		const requests = yield* ModelRequests.make;
		return make({ modelProviders, httpClients: egress.providers, requests, registry: modelsDev });
	}),
).pipe(Layer.provide(ModelProviderRepository.layer));

/** errorCode returns the `code`, else the `type`, of the error in an OpenAI-style error `body`. */
function errorCode(body: string | undefined): string | undefined {
	if (!body) return undefined;
	try {
		const { error } = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
		const code = error?.code ?? error?.type;
		return typeof code === "string" ? code : undefined;
	} catch {
		return undefined;
	}
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
 * Interrupting this does not wait for the iterator to wind down: the SDK's
 * generator may be parked on a network read that only aborting the request
 * will end, which happens when the stream's scope closes.
 */
export const forEachDelta = <E, R>(
	text: AsyncIterable<string>,
	onDelta: (delta: string) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E | RequestFailed, R> => {
	const iterator = text[Symbol.asyncIterator]();
	const next = Effect.callback<IteratorResult<string>, RequestFailed>((resume) => {
		iterator.next().then(
			(result) => resume(Effect.succeed(result)),
			(cause) => resume(Effect.fail(RequestFailed.fromCause(cause))),
		);
	});
	const loop: Effect.Effect<void, E | RequestFailed, R> = Effect.flatMap(next, (result) =>
		result.done ? Effect.void : Effect.andThen(onDelta(result.value), loop),
	);
	return loop;
};

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
 *
 * A model that returns prose where JSON was asked for, or a word that is not
 * one of the choices, has not failed the way a timeout or a dead connection
 * has: it is usually a one-off, and asking again usually works. A timeout is
 * not retried, since the next attempt would cost the same again, and neither
 * is anything the database or the stream raised.
 */
export const retryUnusable = <A, E, R>(ask: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.retry(ask, {
		while: (failure: E) => failure instanceof UnusableAnswer,
		schedule: RETRY_UNUSABLE,
	});

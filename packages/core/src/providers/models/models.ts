/**
 * The one client every part of the workspace asks a model through: turns,
 * compaction, model tests and provider settings.
 * It resolves the workspace's provider for a model, signs in where the
 * provider needs it, and either streams the response or collects a whole
 * answer.
 */
export * as Models from "./models.ts";

import { DisplayName, type DomainError, userText } from "@sugabots/errors";
import {
	APICallError,
	type AssistantModelMessage,
	type LanguageModelMiddleware,
	type ModelMessage,
	stepCountIs,
	streamText,
	type ToolModelMessage,
	type ToolResultPart,
	type ToolSet,
	wrapLanguageModel,
} from "ai";
import {
	type Cause,
	Context,
	Duration,
	Effect,
	ErrorReporter,
	Layer,
	Ref,
	Result,
	Schedule,
	Schema,
	type Scope,
} from "effect";
import { ModelRequests } from "../../accounting/model-requests.ts";
import { streamLedger } from "../../accounting/stream-ledger.ts";
import type { Database } from "../../database/database.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { causesOf } from "../causes.ts";
import type { ProviderOptions } from "../model-providers/dialects/dialect.ts";
import {
	anthropic,
	chatgpt,
	dialectFor,
	gemini,
	type ModelRegistry,
	modelsDev,
	ollama,
	openai,
	openaiCompatible,
	openrouter,
	type ProviderDialect,
} from "../model-providers/dialects/index.ts";
import { ANTHROPIC_MODELS } from "../model-providers/dialects/openrouter.ts";
import { ModelProviderStore } from "../model-providers/model-provider-store.ts";
import { withSignInAccess } from "../model-providers/sign-in/sign-in.ts";
import { Egress, type EgressHttpClients } from "../network/egress.ts";
import {
	classifyRequestFailure,
	isRequestFailure,
	ModelNotOffered,
	ProviderCredentialsMissing,
	ProviderOAuthRefreshFailed,
	type RecognizeFailure,
	type RequestContext,
	type RequestFailure,
	type RequestStage,
} from "./request-failures.ts";

import {
	claudeSupportsAdaptiveThinking,
	geminiThinkingFormat,
	openAIThinkingSupport,
} from "./sdk-model-catalogs.ts";

export interface Interface {
	/**
	 * Opens a streamed response. The Effect ends once the stream is open, and
	 * closing its scope aborts the request, along with any tool call still
	 * running inside it.
	 */
	stream(request: StreamRequest): Effect.Effect<Streamed, RequestFailure, Database | Scope.Scope>;
	/** Asks for one whole answer, in a single model request. */
	answer(
		request: AnswerRequest,
	): Effect.Effect<Answer, RequestFailure | AnswerTimedOut | UnusableAnswer, Database>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Models") {
	declare readonly [Tier]: "process";
}

/** The models of the workspace's providers, reached through egress, priced from models.dev. */
export const make = Effect.gen(function* () {
	const modelProviders = yield* ModelProviderStore.Service;
	const egress = yield* Egress.Service;
	const requests = yield* ModelRequests.make;
	return fromParts({
		modelProviders,
		httpClients: egress.providers,
		requests,
		registry: modelsDev,
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(ModelProviderStore.layer));

export * from "./request-failures.ts";

/**
 * The longest a rate-limited provider may ask us to wait before we ask it
 * again. A provider asking for longer is not asked again: the request fails,
 * and its message says when to try.
 */
export const MAX_RATE_LIMIT_WAIT = Duration.minutes(1);

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
	/**
	 * Whether later requests repeat the prompt up to and including this
	 * message, as a turn's history is repeated by the chat's next turn. A
	 * provider that caches only the prefixes a request marks is told to cache
	 * it; one that caches by itself needs no telling.
	 */
	cacheBreakpoint?: true;
}

/**
 * One model request, its response streamed as it arrives. The model may call
 * the tools it is offered; it is answered by whoever made the request, which
 * runs them and asks again.
 */
export interface StreamRequest extends Prompt {
	/** What the request is for, which the ledger records as whose usage it counts as. */
	purpose: ModelRequests.RequestPurpose;
	/** What earlier requests of the same turn said and were given back, after the prompt. */
	continuationMessages?: readonly ModelMessage[];
	/** What the model may call. None of them runs here: a call is returned, not made. */
	tools?: ToolSet;
	/**
	 * Whether this is the last request the response may take, so the model is
	 * told to answer rather than call more tools.
	 */
	lastRequest?: boolean;
	/** Which step of its turn the request is, which the ledger records it as; 0 when it is no turn's. */
	step?: number;
}

/** A whole answer, given up on if it runs past either limit. */
interface AnswerRequest extends Prompt {
	/** What the request is for, which the ledger records as whose usage it counts as and the logs name it by. */
	purpose: ModelRequests.RequestPurpose;
	maxCharacters: number;
	timeout: Duration.Input;
}

/** A streamed piece of reply text or visible thinking. */
export interface Delta {
	readonly kind: "text" | "thinking";
	readonly text: string;
}

export interface Streamed {
	/** The response's deltas in order. Read them with {@link forEachDelta}. */
	deltas: AsyncIterable<Delta>;
	/**
	 * How the response ended. Meaningful only once `deltas` has been read to its
	 * end; asked for after an abort, it fails. An Effect rather than a promise
	 * so nothing exists until the caller asks, which is what keeps an aborted
	 * response from leaving a rejection nobody handles.
	 */
	finished: Effect.Effect<Finished, RequestFailure>;
}

/**
 * What a finished response leaves for whoever carries it on. What the
 * request used and cost is in the `model_request` ledger, not here.
 */
export interface Finished {
	/** The prompt's size: its history, system text and tools. */
	contextTokens?: number;
	/** The tool calls the model made, in the order it made them, none of them made yet. */
	toolCalls: ToolCallRequest[];
	/** What the model said, its thinking and tool calls included, for the next request to continue from. */
	responseMessages: Array<AssistantModelMessage | ToolModelMessage>;
}

/** A tool call a response asked for. `invalid` says what was wrong with its input, if anything was. */
interface ToolCallRequest {
	toolCallId: string;
	toolName: string;
	input: unknown;
	invalid?: string;
}

export interface Answer {
	text: string;
	/** The prompt's size, as in {@link Finished}. */
	contextTokens?: number;
}

/**
 * logModelFailure logs what is known about a failed model request: `failure`
 * with its cause chain, every error the provider reported in the stream, and
 * whether `signal` had aborted. For an HTTP failure that includes the
 * provider's address, status, headers and body. The request body is left out,
 * since it holds the chat.
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

/**
 * causeChain describes `error` and each error it was caused by, with their
 * stacks and the fields providers and the SDK put on them: an HTTP address,
 * status, response, code or data.
 */
function causeChain(error: unknown): Array<Record<string, unknown>> {
	return causesOf(error).map((current) => {
		if (!(current instanceof Error)) return { value: current };
		const fields = current as Error & Record<string, unknown>;
		return {
			name: current.name,
			message: current.message,
			stack: current.stack,
			...(APICallError.isInstance(current)
				? { url: current.url, status: current.statusCode, headers: current.responseHeaders }
				: {}),
			...definedFields(fields, ["statusCode", "responseBody", "code", "data"]),
		};
	});
}

/** definedFields returns those of `names` that `record` has a value for. */
function definedFields(record: Record<string, unknown>, names: readonly string[]) {
	return Object.fromEntries(
		names.flatMap((name) => (record[name] === undefined ? [] : [[name, record[name]]])),
	);
}

/**
 * failingWith passes `stream` through and throws `fail(cause)` if reading it fails.
 */
async function* failingWith<T>(
	stream: AsyncIterable<T>,
	fail: (cause: unknown) => RequestFailure,
): AsyncGenerator<T> {
	try {
		yield* stream;
	} catch (cause) {
		throw fail(cause);
	}
}

interface Options {
	modelProviders: Pick<ModelProviderStore.Interface, "resolve" | "renewOAuthTokens">;
	httpClients: EgressHttpClients;
	/** Where every request the model makes is recorded. */
	requests: ModelRequests.Interface;
	/** What a request is priced from when its provider doesn't say what it cost. */
	registry: Pick<ModelRegistry, "cost" | "version">;
}

/** Models built from the parts given, which a test can stand in for. */
export function fromParts({ modelProviders, httpClients, requests, registry }: Options): Interface {
	return fromStream((input) =>
		Effect.gen(function* () {
			const signal = yield* Effect.abortSignal;
			const resolved = yield* modelProviders.resolve(input.workspaceId, input.model);
			if (!resolved) {
				return yield* new ModelNotOffered({ model: DisplayName.fromRecord(input.model) });
			}
			const context: RequestContext = {
				provider: resolved.providerName,
				model: resolved.modelName,
			};
			if (!resolved.access) return yield* new ProviderCredentialsMissing(context);
			const access = yield* withSignInAccess(
				modelProviders,
				httpClients,
				input.workspaceId,
				resolved.access,
			).pipe(Effect.mapError((cause) => new ProviderOAuthRefreshFailed({ ...context, cause })));
			const ledger = yield* streamLedger({
				requests,
				registry,
				workspaceId: input.workspaceId,
				purpose: input.purpose,
				model: input.model,
				access,
				step: input.step ?? 0,
			});
			const dialect = dialectFor(access);
			const baseUrl = access.baseUrl.replace(/\/$/, "");
			const requestRoot = dialect.requestRoot?.(baseUrl) ?? baseUrl;
			const systemOptions = dialect.systemOptions?.(input.system);
			const thinkingOptions = thinkingOptionsFor(dialect, input, resolved.capabilities);
			const providerOptions = {
				...systemOptions,
				...thinkingOptions,
				...(systemOptions?.openai && thinkingOptions?.openai
					? { openai: { ...systemOptions.openai, ...thinkingOptions.openai } }
					: {}),
			};
			// Anthropic allows a request four marks. This spends three: the system
			// text, the history's end and each step's newest message.
			const breakpoint = dialect.cacheBreakpoint?.(input.model);
			const markNewest = breakpoint ? newestMessageBreakpoint(breakpoint) : undefined;
			// The SDK does not throw a provider's error into the text stream: it
			// reports it here and ends the stream, and whatever is asked of the
			// result afterwards fails with "No output generated". Keeping the
			// first error is what lets the failure say why the provider refused.
			let providerFailure: unknown;
			// What the request was doing, so a failure can say. `failedAt` is the stage
			// when the first error arrived: the stream can keep going after a bad chunk.
			let stage: RequestStage = "asking";
			let failedAt: RequestStage | undefined;
			// Every error the stream reports, not just the first, so the log shows what led to the failure.
			const streamErrors: unknown[] = [];
			// The SDK's callbacks run outside Effect, so they log through this.
			const services = yield* Effect.context<never>();
			const runLog = Effect.runForkWith(services);
			const toolCalls: ToolCallRequest[] = [];
			const result = streamText({
				model: wrapLanguageModel({
					model: dialect.languageModel(
						{ ...access, baseUrl: requestRoot },
						input.model,
						httpClients.for({ baseUrl: requestRoot }),
						thinkingOptions,
					),
					middleware: openModelStream(services, context, dialect.recognizeFailure),
				}),
				...(systemOptions
					? {}
					: {
							system: breakpoint
								? withBreakpoint({ role: "system", content: input.system }, breakpoint)
								: input.system,
						}),
				...(systemOptions || thinkingOptions ? { providerOptions } : {}),
				messages: [
					...input.messages.map(({ cacheBreakpoint, ...message }) =>
						cacheBreakpoint && breakpoint ? markedMessage(message, breakpoint) : message,
					),
					...(input.continuationMessages ?? []),
				],
				tools: input.tools,
				abortSignal: signal,
				onChunk: ({ chunk }) => {
					if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") stage = "answering";
					if (chunk.type === "tool-input-start" || chunk.type === "tool-call") {
						stage = "calling-tool";
					}
					if (chunk.type === "tool-call" && !chunk.providerExecuted) {
						toolCalls.push({
							toolCallId: chunk.toolCallId,
							toolName: chunk.toolName,
							input: chunk.input,
							...(chunk.invalid ? { invalid: invalidInputText(chunk.error) } : {}),
						});
					}
				},
				onLanguageModelCallStart: () => ledger.started(),
				onLanguageModelCallEnd: ({ usage }) => ledger.ended(usage),
				onError: ({ error }) => {
					providerFailure ??= error;
					failedAt ??= stage;
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
				// A response stopped by the request limit on a round of tool calls ends
				// with nothing said, so the last request is told to answer. The note
				// rides on the newest tool result, which no provider has cached yet:
				// changing the tools or system text instead would cost the cache
				// every earlier request built. Every other request marks its newest
				// message for the next to read up to from the cache; the last has no
				// next request to read it.
				prepareStep: ({ messages }) => {
					// A request continuing a turn sends the previous request's tool results.
					stage = (input.continuationMessages?.length ?? 0) === 0 ? "asking" : "after-tools";
					if (input.lastRequest) return { messages: withLastStepNote(messages) };
					return markNewest ? { messages: markNewest(messages) } : undefined;
				},
				// One request: the tool calls it makes come back to the caller.
				stopWhen: stepCountIs(1),
				maxRetries: 0,
			});
			/** Logs what ended the request, and names it for whoever reads the response. */
			const classified = (cause: unknown) => {
				const failure = providerFailure ?? cause;
				runLog(logModelFailure(failure, streamErrors, signal));
				return classifyRequestFailure(failure, {
					...context,
					stage: failedAt ?? stage,
					recognize: dialect.recognizeFailure,
				});
			};
			return {
				deltas: failingWith(modelDeltas(result.fullStream), classified),
				finished: Effect.tryPromise({
					try: async () => {
						const [steps, responseMessages] = await Promise.all([
							result.steps,
							result.responseMessages,
						]);
						if (providerFailure !== undefined) throw providerFailure;
						return {
							contextTokens: steps[0]?.usage.inputTokens,
							toolCalls: [...toolCalls],
							// The SDK answers an invalid call itself; the caller answers every call.
							responseMessages: responseMessages.filter(({ role }) => role === "assistant"),
						};
					},
					catch: classified,
				}),
			};
		}),
	);
}

const GEMINI_DYNAMIC_THINKING_BUDGET = -1;

/** thinkingOptionsFor requests thinking when the provider has an adaptive or default mode and the workspace allows it. */
function thinkingOptionsFor(
	dialect: ProviderDialect,
	input: StreamRequest,
	capabilities: ModelProviderStore.ResolvedModel["capabilities"],
): ProviderOptions | undefined {
	if (input.purpose.name !== "bot-turn" || !capabilities.includes("thinking")) return undefined;
	const { model } = input;
	switch (dialect) {
		case anthropic:
			return claudeSupportsAdaptiveThinking(model)
				? { anthropic: { thinking: { type: "adaptive", display: "summarized" } } }
				: undefined;
		case gemini:
			return {
				google: {
					thinkingConfig: {
						includeThoughts: true,
						...(geminiThinkingFormat(model) === "budget"
							? { thinkingBudget: GEMINI_DYNAMIC_THINKING_BUDGET }
							: {}),
					},
				},
			};
		case openai:
			// Discovery covers models and aliases newer than the SDK catalog. A
			// catalogued model without thinking cannot accept Responses summaries.
			if (openAIThinkingSupport(model) === false) return undefined;
			return {
				openai: {
					reasoningSummary: "auto",
					store: false,
					include: ["reasoning.encrypted_content"],
				},
			};
		case chatgpt:
			return { openai: { reasoningSummary: "auto" } };
		case openrouter:
			if (
				model.startsWith(ANTHROPIC_MODELS) &&
				!claudeSupportsAdaptiveThinking(model.slice(ANTHROPIC_MODELS.length).replaceAll(".", "-"))
			) {
				return undefined;
			}
			return { openrouter: { reasoning: { enabled: true } } };
		case openaiCompatible:
		case ollama:
			// The compatible SDK can replay the provider's thinking with tool results.
			return { openai: {} };
		default:
			return undefined;
	}
}

async function* modelDeltas(
	stream: ReturnType<typeof streamText>["fullStream"],
): AsyncGenerator<Delta> {
	for await (const part of stream) {
		if (part.type === "text-delta") yield { kind: "text", text: part.text };
		if (part.type === "reasoning-delta") yield { kind: "thinking", text: part.text };
	}
}

/** How many times one model request is sent again after the provider asks us to wait. */
const RATE_LIMIT_RETRIES = 3;

/**
 * Sends a model request again when the provider answers 429 and says to wait no
 * longer than `MAX_RATE_LIMIT_WAIT`, after waiting that long. Only the call's
 * opening request is sent again, which the provider refused before streaming
 * anything, so nothing the model said or a tool did is repeated. Aborting the
 * call, as cancelling a turn does, ends the wait.
 */
function openModelStream(
	services: Context.Context<never>,
	provider: RequestContext,
	recognize: RecognizeFailure | undefined,
): LanguageModelMiddleware {
	const run = Effect.runPromiseWith(services);
	/** How long the provider asked to be left, when it refused for asking too often and we will wait that long. */
	const shortWait = (refusal: unknown) => {
		const failure = classifyRequestFailure(refusal, { ...provider, stage: "asking", recognize });
		return failure._tag === "ProviderRateLimited" &&
			failure.retryAfter !== undefined &&
			Duration.isLessThanOrEqualTo(failure.retryAfter, MAX_RATE_LIMIT_WAIT)
			? failure.retryAfter
			: undefined;
	};
	return {
		wrapStream: async ({ doStream, params, model }) => {
			const openaiOptions = params.providerOptions?.openai;
			let sendRequest = doStream;
			const send = (
				retriesLeft: number,
			): Effect.Effect<Awaited<ReturnType<typeof doStream>>, Cause.UnknownError> =>
				Effect.tryPromise(() => sendRequest()).pipe(
					Effect.catch((refused) => {
						if (
							sendRequest === doStream &&
							openaiOptions?.reasoningSummary &&
							summaryWasRefused(refused.cause)
						) {
							const { reasoningSummary: _, ...withoutSummary } = openaiOptions;
							const providerOptions = { ...params.providerOptions, openai: withoutSummary };
							sendRequest = () => model.doStream({ ...params, providerOptions });
							return send(retriesLeft);
						}
						const wait = shortWait(refused.cause);
						if (wait === undefined || retriesLeft === 0) return Effect.fail(refused);
						return Effect.logWarning(
							`${provider.provider} asked us to wait ${Duration.format(wait)} before asking again`,
						).pipe(Effect.andThen(Effect.sleep(wait)), Effect.andThen(send(retriesLeft - 1)));
					}),
				);
			const sent = await run(Effect.result(send(RATE_LIMIT_RETRIES)), {
				signal: params.abortSignal,
			});
			// The SDK gets the provider's own error, which the stream's failure is classified and logged from.
			if (Result.isFailure(sent)) throw sent.failure.cause;
			return sent.success;
		},
	};
}

function summaryWasRefused(cause: unknown): boolean {
	if (!APICallError.isInstance(cause) || cause.statusCode !== 400) return false;
	const data: unknown = cause.data;
	if (typeof data !== "object" || data === null || !("error" in data)) return false;
	const { error } = data;
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "unsupported_value" &&
		"param" in error &&
		error.param === "reasoning.summary"
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
					const streamed = yield* stream(request);
					const collected = yield* Ref.make("");
					yield* forEachDelta(streamed.deltas, (delta) =>
						delta.kind === "thinking"
							? Effect.void
							: Ref.updateAndGet(collected, (soFar) => soFar + delta.text).pipe(
									Effect.filterOrFail(
										(soFar) => soFar.length <= request.maxCharacters,
										() =>
											new UnusableAnswer({
												reason: `The ${request.purpose.name} answer ran past ${request.maxCharacters} characters`,
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
					orElse: () => Effect.fail(new AnswerTimedOut({ purpose: request.purpose.name })),
				}),
			),
	};
}

const LAST_STEP_NOTE =
	"(This is your last step: you cannot call tools any more. Answer now from what you have found, and say what you could not check.)";

/** What the model is told of a tool call whose input didn't fit the tool, from what the SDK found wrong. */
function invalidInputText(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `The input didn't match the tool's input schema, so it wasn't run: ${reason}`;
}

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

/**
 * Marks each step's newest message with `breakpoint`, taking it off the
 * message the step before marked. The SDK sends each step the messages the
 * step before was sent, so a mark left behind would count against the four
 * Anthropic allows a request.
 */
function newestMessageBreakpoint(breakpoint: ProviderOptions) {
	let marked: { index: number; unmarked: ModelMessage } | undefined;
	return (messages: ModelMessage[]): ModelMessage[] => {
		const restored = marked ? messages.with(marked.index, marked.unmarked) : messages;
		const index = restored.length - 1;
		const newest = restored[index];
		if (!newest) return restored;
		marked = { index, unmarked: newest };
		return restored.with(index, markedMessage(newest, breakpoint));
	};
}

/**
 * `message` marked with `breakpoint`. A tool message is marked on its last
 * result only, since OpenRouter sends each result as its own message and
 * would copy a mark on the message onto every one, passing Anthropic's four
 * after parallel tool calls. One with no results is left unmarked.
 */
function markedMessage(message: ModelMessage, breakpoint: ProviderOptions): ModelMessage {
	if (message.role !== "tool") return withBreakpoint(message, breakpoint);
	const resultAt = message.content.findLastIndex((part) => part.type === "tool-result");
	const result = message.content[resultAt];
	if (result?.type !== "tool-result") return message;
	return {
		...message,
		content: message.content.with(resultAt, withBreakpoint(result, breakpoint)),
	};
}

/**
 * `marked`, a message or one of its parts, with `breakpoint`'s options added to
 * whatever options it has for the same provider. A message that may be a tool
 * message is marked through {@link markedMessage} instead.
 */
function withBreakpoint<Marked extends ModelMessage | ToolResultPart>(
	marked: Marked,
	breakpoint: ProviderOptions,
): Marked {
	const providerOptions = { ...marked.providerOptions };
	for (const [provider, options] of Object.entries(breakpoint)) {
		providerOptions[provider] = { ...providerOptions[provider], ...options };
	}
	return { ...marked, providerOptions };
}

/**
 * Reads the model's text one delta at a time and runs `onDelta` for each.
 *
 * Interrupting this does not wait for the iterator to wind down: the SDK's
 * generator may be parked on a network read that only aborting the request
 * will end, which happens when the stream's scope closes.
 */
export const forEachDelta = <E, R>(
	deltas: AsyncIterable<Delta>,
	onDelta: (delta: Delta) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E | RequestFailure, R> => {
	const iterator = deltas[Symbol.asyncIterator]();
	// `make` ends its text with a classified failure, so anything else is a bug.
	const next = Effect.callback<IteratorResult<Delta>, RequestFailure>((resume) => {
		iterator.next().then(
			(result) => resume(Effect.succeed(result)),
			(cause: unknown) => resume(isRequestFailure(cause) ? Effect.fail(cause) : Effect.die(cause)),
		);
	});
	const loop: Effect.Effect<void, E | RequestFailure, R> = Effect.flatMap(next, (result) =>
		result.done ? Effect.void : Effect.andThen(onDelta(result.value), loop),
	);
	return loop;
};

/** The model answered, but not in a shape we can use. */
export class UnusableAnswer
	extends Schema.TaggedError<UnusableAnswer>()("UnusableAnswer", {
		/** What was wrong with the answer. */
		reason: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return this.reason;
	}
	get userMessage() {
		return userText`The model answered in a form we couldn't use.`;
	}
}

/** The model did not finish answering within the time allowed. */
export class AnswerTimedOut
	extends Schema.TaggedError<AnswerTimedOut>()("AnswerTimedOut", {
		/** What the answer was for, such as a compaction. */
		purpose: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The ${this.purpose} answer timed out`;
	}
	get userMessage() {
		return userText`The model didn't answer in time.`;
	}
}

/**
 * Three attempts, a moment apart.
 *
 * Short, because each attempt is a model request somebody is waiting on, and
 * because a prompt the model cannot follow will not start working on the tenth
 * try — that is a prompt to fix, not a failure to absorb. The small gap is
 * jittered so a wave of requests hitting the same bad patch does not re-ask in
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

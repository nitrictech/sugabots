import { usageFromAiSdk } from "@sugabots/accounting";
import type { LanguageModelUsage } from "ai";
import { Clock, DateTime, Effect, Exit, type Tracer } from "effect";
import type { ModelRegistry } from "../providers/model-providers/dialects/index.ts";
import type { ModelProviderRepository } from "../providers/model-providers/model-provider-repository.ts";
import type { ModelRequests } from "./model-requests.ts";
import { requestCost } from "./request-cost.ts";

/**
 * Records every request one `streamText` call makes, one row each, and traces
 * each as a `Models.request` span.
 *
 * Hand `started` and `ended` to the SDK's `onLanguageModelCallStart` and
 * `onLanguageModelCallEnd`, which it awaits around each request; `failed` and
 * `aborted` close a request that never reached its end, from `onError` and
 * `onAbort`. The SDK makes its requests one after another, so at most one is
 * open at a time.
 */
export interface StreamLedger {
	started(): Promise<void>;
	ended(usage: LanguageModelUsage): Promise<void>;
	failed(): Promise<void>;
	aborted(): Promise<void>;
}

export interface StreamLedgerOptions {
	requests: ModelRequests.Interface;
	registry: Pick<ModelRegistry, "cost" | "version">;
	workspaceId: string;
	activity: ModelRequests.Activity;
	model: string;
	connection: Pick<
		ModelProviderRepository.ProviderEndpoint,
		"providerId" | "preset" | "baseUrl" | "apiFormat"
	>;
}

interface OpenRequest {
	span: Tracer.Span;
	/** Undefined when the start could not be recorded, so there is no row to finish. */
	id: string | undefined;
}

/**
 * A ledger for one stream. Its writes run with the caller's services, so
 * their clock is the caller's and their spans sit under the caller's. A
 * request that can't be recorded is logged rather than raised: a gap in the
 * numbers is no reason to stop a conversation.
 */
export const streamLedger = (options: StreamLedgerOptions): Effect.Effect<StreamLedger> =>
	Effect.gen(function* () {
		const run = Effect.runPromiseWith(yield* Effect.context<never>());
		let nextStep = 0;
		let open: OpenRequest | undefined;

		const start = Effect.gen(function* () {
			const step = nextStep++;
			const span = yield* Effect.makeSpan("Models.request", {
				attributes: {
					"gen_ai.request.model": options.model,
					"gen_ai.provider.name": options.connection.preset ?? "custom",
					"sugabots.model_request.purpose": options.activity.purpose,
					"sugabots.model_request.step": step,
				},
			});
			const id = yield* options.requests
				.start({
					workspaceId: options.workspaceId,
					activity: options.activity,
					step,
					providerId: options.connection.providerId,
					preset: options.connection.preset,
					model: options.model,
					startedAt: yield* DateTime.nowAsDate,
				})
				.pipe(
					Effect.catchCause((cause) =>
						Effect.as(Effect.logWarning("Could not record a model request", cause), undefined),
					),
					Effect.withParentSpan(span),
				);
			open = { span, id };
		});

		const close = (outcome: ModelRequests.Ending["outcome"], sdkUsage?: LanguageModelUsage) =>
			Effect.gen(function* () {
				const request = open;
				if (!request) return;
				open = undefined;
				const usage = sdkUsage && usageFromAiSdk(sdkUsage);
				const cost =
					sdkUsage && requestCost(options.connection, options.model, sdkUsage, options.registry);
				annotate(request.span, outcome, usage, cost);
				if (request.id !== undefined) {
					yield* options.requests
						.finish(request.id, { outcome, usage, cost, endedAt: yield* DateTime.nowAsDate })
						.pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning("Could not record how a model request ended", cause),
							),
							Effect.withParentSpan(request.span),
						);
				}
				request.span.end(
					yield* Clock.currentTimeNanos,
					outcome === "completed" ? Exit.void : Exit.fail(`Model request ${outcome}`),
				);
			});

		return {
			started: () => run(start),
			ended: (usage) => run(close("completed", usage)),
			failed: () => run(close("failed")),
			aborted: () => run(close("aborted")),
		};
	});

/** What a request's span says about how it went, in OpenTelemetry's GenAI terms where they have one. */
function annotate(
	span: Tracer.Span,
	outcome: ModelRequests.Ending["outcome"],
	usage: ModelRequests.Ending["usage"],
	cost: ModelRequests.Ending["cost"],
) {
	span.attribute("sugabots.model_request.outcome", outcome);
	if (usage?.inputTokens !== undefined)
		span.attribute("gen_ai.usage.input_tokens", usage.inputTokens);
	if (usage?.outputTokens !== undefined) {
		span.attribute("gen_ai.usage.output_tokens", usage.outputTokens);
	}
	if (cost) {
		span.attribute("sugabots.model_request.cost_usd", cost.usd);
		span.attribute("sugabots.model_request.cost_source", cost.source);
	}
}

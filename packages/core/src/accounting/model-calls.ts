import {
	type AttemptIntent,
	type AttemptObservationWriter,
	type AttributionSnapshot,
	collectAttempt,
	estimateCost,
	normalizeUsage,
	type UsageEvidence,
} from "@sugabots/accounting";
import { evidenceFromAiSdkUsage } from "@sugabots/accounting/ai-sdk";
import { snapshotFromModelsDev } from "@sugabots/accounting/models-dev";
import type { LanguageModelUsage } from "ai";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import type { Database } from "../database/database.ts";
import type { ModelRegistry } from "../providers/model-providers/dialects/index.ts";
import type { ProviderConnection } from "../providers/model-providers/store.ts";
import type { ModelAttemptStore } from "./store.ts";

/**
 * What a model request was made for, which is whose spend it is in the ledger.
 * System work names the thread it served and no agent: it is never charged to
 * an agent or pod that did not make it.
 */
export type ModelActivity =
	| {
			kind: "agent-turn";
			threadId: string;
			agentId: string;
			agentName: string;
			podId: string;
			podName: string;
	  }
	| { kind: "thread-summary"; threadId: string }
	| { kind: "facilitation"; threadId: string }
	| { kind: "model-probe" }
	| { kind: "model-trial" };

/** What the SDK reports once one request has been answered. */
export interface ModelCallEnd {
	modelId: string;
	responseId: string;
	usage: LanguageModelUsage;
}

/**
 * Records every request one `streamText` call makes, one attempt each.
 *
 * Hand `started` and `ended` to the SDK's `onLanguageModelCallStart` and
 * `onLanguageModelCallEnd`, which it awaits around each request, so the intent
 * is written before the request goes out. `failed` and `cancelled` close a
 * request that never reached its end, from `onError` and `onAbort`. The SDK
 * makes its requests one after another, so at most one is open at a time.
 */
export interface ModelCallLedger {
	started(): Promise<void>;
	ended(call: ModelCallEnd): Promise<void>;
	failed(cause: unknown): Promise<void>;
	cancelled(): Promise<void>;
}

export interface ModelCallLedgerOptions {
	store: ModelAttemptStore;
	workspaceId: string;
	activity: ModelActivity;
	connection: Pick<ProviderConnection, "providerId" | "preset" | "baseUrl" | "apiFormat">;
	model: string;
	/** Where a request's price is looked up. A model it has no price for stays unpriced. */
	prices: Pick<ModelRegistry, "price">;
}

interface OpenCall {
	intent: AttemptIntent;
	writer: AttemptObservationWriter<Database>;
	/** Settled by how the request ended; the attempt's outcome follows it. */
	outcome: Deferred.Deferred<void, unknown>;
	attempt: Fiber.Fiber<void, unknown>;
}

/**
 * A ledger for one `streamText` call. Writes run with the caller's services but
 * on their own fibres, and a ledger that cannot be written is logged rather
 * than raised: an unrecorded request is a gap in the numbers, not a reason to
 * stop the conversation.
 */
export const modelCallLedger = (
	options: ModelCallLedgerOptions,
): Effect.Effect<ModelCallLedger, never, Database> =>
	Effect.gen(function* () {
		const context = yield* Effect.context<Database>();
		const run = Effect.runPromiseWith(context);
		const executionId = crypto.randomUUID();
		const attribution = attributionOf(options.workspaceId, options.activity);
		const provider = {
			connectionId: options.connection.providerId,
			provider: options.connection.preset ?? "custom",
			requestedModel: options.model,
		};
		let open: OpenCall | undefined;

		const close = (settle: (outcome: Deferred.Deferred<void, unknown>) => Effect.Effect<boolean>) =>
			Effect.suspend(() => {
				const call = open;
				open = undefined;
				return call
					? settle(call.outcome).pipe(Effect.andThen(Fiber.await(call.attempt)))
					: Effect.void;
			}).pipe(Effect.asVoid);

		const start = Effect.gen(function* () {
			// A request the SDK never reported the end of, because the next began.
			yield* close(Deferred.interrupt);
			const intent: AttemptIntent = {
				attemptId: crypto.randomUUID(),
				executionId,
				startedAt: new Date().toISOString(),
				attribution,
				provider,
			};
			const dispatched = yield* Deferred.make<AttemptObservationWriter<Database>>();
			const outcome = yield* Deferred.make<void, unknown>();
			const attempt = yield* collectAttempt({
				store: options.store,
				intent,
				dispatchPolicy: "continue",
				onPersistenceFailure: (failure) =>
					Effect.logWarning("Could not record a model request").pipe(
						Effect.annotateLogs({
							attemptId: failure.attemptId,
							phase: failure.phase,
							cause: String(failure.cause),
						}),
					),
				operation: (writer) =>
					Deferred.succeed(dispatched, writer).pipe(Effect.andThen(Deferred.await(outcome))),
			}).pipe(Effect.forkDetach);
			const writer = yield* Effect.raceFirst(
				Deferred.await(dispatched).pipe(Effect.map(Option.some)),
				Fiber.await(attempt).pipe(Effect.map(() => Option.none())),
			);
			if (Option.isNone(writer)) {
				// The attempt ended before its request could be let out: the ledger
				// refused it. The request goes ahead unrecorded.
				const exit = yield* Fiber.await(attempt);
				if (Exit.isFailure(exit)) {
					yield* Effect.logWarning("Could not record a model request").pipe(
						Effect.annotateLogs({ attemptId: intent.attemptId, cause: Cause.pretty(exit.cause) }),
					);
				}
				return;
			}
			open = { intent, writer: writer.value, outcome, attempt };
		});

		const end = (call: ModelCallEnd) =>
			Effect.gen(function* () {
				const current = open;
				if (!current) return;
				const evidence = yield* evidenceFromAiSdkUsage(options.connection.apiFormat, call.usage);
				yield* recordResponse(current.writer, call, evidence);
				yield* close((outcome) => Deferred.succeed(outcome, undefined));
				yield* estimate(current.intent, call, evidence);
			});

		/** Prices the request against models.dev's rate for the model that answered. */
		const estimate = (intent: AttemptIntent, call: ModelCallEnd, evidence: UsageEvidence) =>
			Effect.gen(function* () {
				const price = options.prices.price(call.modelId, options.connection);
				if (!price) return;
				const answered = { ...intent.provider, returnedModel: call.modelId };
				// The rate as read when the request was made; the catalog carries no
				// history of its own.
				const snapshot = yield* snapshotFromModelsDev({
					snapshotId: `models.dev:${price.catalogGeneratedAt}:${answered.provider}:${call.modelId}`,
					provider: answered.provider,
					model: call.modelId,
					cost: price.cost,
					catalogGeneratedAt: price.catalogGeneratedAt,
					retrievedAt: intent.startedAt,
					effectiveFrom: intent.startedAt,
				});
				const cost = yield* estimateCost(
					yield* normalizeUsage(evidence),
					answered,
					snapshot,
					intent.startedAt,
					new Date().toISOString(),
				);
				yield* options.store.recordEstimate(intent.attemptId, snapshot, cost);
			}).pipe(
				Effect.catch((failure) =>
					Effect.logWarning("Could not price a model request").pipe(
						Effect.annotateLogs({ attemptId: intent.attemptId, cause: String(failure) }),
					),
				),
			);

		return {
			started: () => run(start),
			ended: (call) => run(end(call)),
			failed: (cause) => run(close((outcome) => Deferred.fail(outcome, cause))),
			cancelled: () => run(close(Deferred.interrupt)),
		};
	});

/** What the provider said about the request: which model answered, and what it used. */
const recordResponse = (
	writer: AttemptObservationWriter<Database>,
	call: ModelCallEnd,
	evidence: UsageEvidence,
) => {
	const observedAt = new Date().toISOString();
	return writer
		.recordResponseMetadata({
			metadataKey: "response",
			observedAt,
			returnedModel: call.modelId,
			providerRequestId: call.responseId,
		})
		.pipe(
			Effect.andThen(writer.recordUsage({ usageKey: "response", observedAt, evidence })),
			Effect.catch((invalid) =>
				Effect.logWarning("Could not record a model request's usage").pipe(
					Effect.annotateLogs({ cause: invalid.message }),
				),
			),
		);
};

function attributionOf(workspaceId: string, activity: ModelActivity): AttributionSnapshot {
	const { kind, ...subject } = activity;
	return { workspaceId, activityPurpose: kind, ...subject };
}

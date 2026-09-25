import { Cause, Clock, Data, Duration, Effect, Exit, Option, Result } from "effect";
import type { AccountingStore, DispatchedObservation } from "./lifecycle.ts";
import {
	type AttemptId,
	type AttemptIntent,
	type AttemptObservation,
	type ExecutionOutcome,
	ObservationId,
	type ObservationPayload,
	type Timestamp,
	type UsageEvidence,
} from "./schemas.ts";

export type DispatchPolicy = "block" | "continue";

/** An attempt's intent before dispatch; `collectAttempt` stamps its start time from `Clock`. */
export type AttemptIntentDraft = Omit<AttemptIntent, "startedAt">;

export type AccountingPersistenceFailure =
	| {
			readonly phase: "intent";
			readonly attemptId: AttemptId;
			readonly intent: AttemptIntent;
			readonly cause: unknown;
	  }
	| {
			readonly phase: "dispatch" | "observation";
			readonly attemptId: AttemptId;
			readonly observation: AttemptObservation;
			readonly cause: unknown;
	  };

/**
 * Records evidence while the provider request runs. `key` names the observation within the
 * attempt; recording the same key and evidence again is a harmless replay. To correct recorded
 * evidence, record it under a new key with `supersedesKey` set to the key it replaces.
 */
export interface AttemptObservationWriter<R = never> {
	recordUsage(input: {
		readonly key: string;
		readonly evidence: UsageEvidence;
		readonly supersedesKey?: string;
	}): Effect.Effect<void, InvalidAccountingObservationError, R>;
	recordResponseMetadata(input: {
		readonly key: string;
		readonly returnedModel: string;
		readonly providerRequestId?: string;
		readonly supersedesKey?: string;
	}): Effect.Effect<void, InvalidAccountingObservationError, R>;
}

export interface CollectAttemptOptions<
	A,
	E,
	R,
	StoreError,
	StoreRequirements,
	FailureRequirements,
> {
	readonly store: AccountingStore<StoreError, StoreRequirements>;
	readonly intent: AttemptIntentDraft;
	/** What to do when the intent cannot be recorded: refuse to dispatch, or dispatch untracked. */
	readonly dispatchPolicy: DispatchPolicy;
	/** Receives every accounting write that failed or conflicted; accounting never retries the request. */
	readonly onPersistenceFailure: (
		failure: AccountingPersistenceFailure,
	) => Effect.Effect<void, never, FailureRequirements>;
	readonly classifyFailure?: (cause: unknown) => Exclude<ExecutionOutcome, "succeeded">;
	readonly operation: (
		writer: AttemptObservationWriter<StoreRequirements | FailureRequirements>,
	) => Effect.Effect<A, E, R>;
	/** Bounds each store write and failure report. Defaults to five seconds. */
	readonly persistenceTimeout?: Duration.Input;
}

export class AccountingDispatchAlreadyClaimedError extends Data.TaggedError(
	"AccountingDispatchAlreadyClaimedError",
)<{ readonly attemptId: AttemptId }> {}

export class AccountingDispatchBlockedError extends Data.TaggedError(
	"AccountingDispatchBlockedError",
)<{ readonly attemptId: AttemptId; readonly cause: unknown }> {}

export class AccountingIntegrityError extends Data.TaggedError("AccountingIntegrityError")<{
	readonly message: string;
}> {}

export class InvalidAccountingOptionsError extends Data.TaggedError(
	"InvalidAccountingOptionsError",
)<{ readonly message: string }> {}

export class InvalidAccountingObservationError extends Data.TaggedError(
	"InvalidAccountingObservationError",
)<{ readonly message: string }> {}

const DEFAULT_PERSISTENCE_TIMEOUT = Duration.seconds(5);
const OBSERVATION_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * Runs one provider request and records its lifecycle: intent, an atomic dispatch claim, evidence
 * the operation records, and a terminal outcome. The operation's result, failure, or interruption
 * is returned unchanged; accounting write failures go to `onPersistenceFailure`.
 */
export const collectAttempt = Effect.fn("accounting.collectAttempt")(function* <
	A,
	E,
	R,
	StoreError,
	StoreRequirements,
	FailureRequirements,
>(
	options: CollectAttemptOptions<A, E, R, StoreError, StoreRequirements, FailureRequirements>,
): Effect.fn.Return<
	A,
	| E
	| AccountingDispatchAlreadyClaimedError
	| AccountingDispatchBlockedError
	| AccountingIntegrityError
	| InvalidAccountingObservationError
	| InvalidAccountingOptionsError,
	R | StoreRequirements | FailureRequirements
> {
	const timeout = Duration.fromInput(options.persistenceTimeout ?? DEFAULT_PERSISTENCE_TIMEOUT);
	if (Option.isNone(timeout) || !Duration.isPositive(timeout.value)) {
		return yield* new InvalidAccountingOptionsError({
			message: "Persistence timeout must be a positive duration",
		});
	}
	const intent: AttemptIntent = { ...options.intent, startedAt: yield* currentTimestamp };
	yield* Effect.annotateCurrentSpan({
		"accounting.attempt.id": intent.attemptId,
		"accounting.execution.id": intent.executionId,
		"accounting.provider": intent.provider.provider,
		"accounting.model.requested": intent.provider.requestedModel,
		"accounting.dispatch_policy": options.dispatchPolicy,
	});
	const recorder = attemptRecorder(
		options.store,
		intent,
		options.onPersistenceFailure,
		timeout.value,
	);

	const intentWrite = yield* recorder.within(options.store.putIntent(intent)).pipe(Effect.result);
	if (Result.isSuccess(intentWrite) && intentWrite.success === "conflict") {
		return yield* new AccountingIntegrityError({
			message: "Attempt ID already contains different intent",
		});
	}
	if (Result.isFailure(intentWrite)) {
		yield* recorder.report({
			phase: "intent",
			attemptId: intent.attemptId,
			intent,
			cause: intentWrite.failure,
		});
		if (options.dispatchPolicy === "block") {
			return yield* new AccountingDispatchBlockedError({
				attemptId: intent.attemptId,
				cause: intentWrite.failure,
			});
		}
	} else {
		// A dispatch claim needs the recorded intent, so an untracked dispatch skips it.
		yield* claimDispatch(recorder, intent);
	}

	let attemptEnded = false;
	const writer = observationWriter(recorder, intent, () => attemptEnded);
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const result = yield* Effect.exit(restore(Effect.suspend(() => options.operation(writer))));
			attemptEnded = true;
			const endedAt = yield* currentTimestamp;
			const outcome = Exit.isSuccess(result)
				? "succeeded"
				: Cause.hasInterruptsOnly(result.cause)
					? "cancelled"
					: classifyFailure(options.classifyFailure, Cause.squash(result.cause));
			yield* recorder.putObservation(
				{
					observationId: observationIdFor(intent, "terminal"),
					attemptId: intent.attemptId,
					observedAt: endedAt,
					payload: { type: "terminal", endedAt, outcome },
				},
				"report-interrupt",
			);
			return yield* result;
		}),
	);
});

/** The dispatch observation `collectAttempt` claims; store contract checks use the same shape. */
export function dispatchedObservation(
	attemptId: AttemptId,
	dispatchedAt: Timestamp,
): DispatchedObservation {
	return {
		observationId: ObservationId.make(`${attemptId}:dispatched`),
		attemptId,
		observedAt: dispatchedAt,
		payload: { type: "dispatched", dispatchedAt },
	};
}

const claimDispatch = Effect.fnUntraced(function* <
	StoreError,
	StoreRequirements,
	FailureRequirements,
>(
	recorder: AttemptRecorder<StoreError, StoreRequirements, FailureRequirements>,
	intent: AttemptIntent,
) {
	const observation = dispatchedObservation(intent.attemptId, yield* currentTimestamp);
	const claim = yield* recorder
		.within(recorder.store.claimDispatch(observation))
		.pipe(Effect.result);
	if (Result.isFailure(claim)) {
		yield* recorder.report({
			phase: "dispatch",
			attemptId: intent.attemptId,
			observation,
			cause: claim.failure,
		});
		return yield* new AccountingDispatchBlockedError({
			attemptId: intent.attemptId,
			cause: claim.failure,
		});
	}
	if (claim.success === "already-dispatched" || claim.success === "terminal") {
		return yield* new AccountingDispatchAlreadyClaimedError({ attemptId: intent.attemptId });
	}
	if (claim.success === "conflict") {
		return yield* new AccountingIntegrityError({
			message: "Dispatch claim conflicts with stored evidence",
		});
	}
});

function observationWriter<StoreError, StoreRequirements, FailureRequirements>(
	recorder: AttemptRecorder<StoreError, StoreRequirements, FailureRequirements>,
	intent: AttemptIntent,
	hasAttemptEnded: () => boolean,
): AttemptObservationWriter<StoreRequirements | FailureRequirements> {
	const record = Effect.fnUntraced(function* (
		key: string,
		supersedesKey: string | undefined,
		payload: Extract<ObservationPayload, { type: "usage" | "response-metadata" }>,
	) {
		if (hasAttemptEnded()) {
			return yield* new InvalidAccountingObservationError({
				message: "The attempt has ended; record observations inside the operation",
			});
		}
		const keys = supersedesKey === undefined ? [key] : [key, supersedesKey];
		if (!keys.every((candidate) => OBSERVATION_KEY.test(candidate))) {
			return yield* new InvalidAccountingObservationError({
				message: `Observation keys may contain only letters, digits, ".", "_", and "-"`,
			});
		}
		yield* recorder.putObservation(
			{
				observationId: observationIdFor(intent, payload.type, key),
				attemptId: intent.attemptId,
				observedAt: yield* currentTimestamp,
				...(supersedesKey === undefined
					? {}
					: { supersedesObservationId: observationIdFor(intent, payload.type, supersedesKey) }),
				payload,
			},
			"propagate-interrupt",
		);
	});
	return {
		recordUsage: ({ key, evidence, supersedesKey }) =>
			record(key, supersedesKey, { type: "usage", evidence }),
		recordResponseMetadata: ({ key, returnedModel, providerRequestId, supersedesKey }) =>
			returnedModel.length === 0
				? new InvalidAccountingObservationError({ message: "Returned model is required" })
				: record(key, supersedesKey, {
						type: "response-metadata",
						returnedModel,
						...(providerRequestId === undefined ? {} : { providerRequestId }),
					}),
	};
}

function observationIdFor(
	intent: AttemptIntent,
	type: ObservationPayload["type"],
	key?: string,
): ObservationId {
	return ObservationId.make([intent.attemptId, type, key].filter(Boolean).join(":"));
}

interface AttemptRecorder<StoreError, StoreRequirements, FailureRequirements> {
	readonly store: AccountingStore<StoreError, StoreRequirements>;
	/** Bounds a store write by the persistence timeout. */
	within<A, E, R>(write: Effect.Effect<A, E, R>): Effect.Effect<A, E | Cause.TimeoutError, R>;
	/** Reports a failure best-effort: a slow, failing, or interrupting reporter is ignored. */
	report(failure: AccountingPersistenceFailure): Effect.Effect<void, never, FailureRequirements>;
	/**
	 * Writes an observation and reports any failure. While the operation runs, an interruption must
	 * still stop the fiber; after it has finished, nothing may replace the operation's result.
	 */
	putObservation(
		observation: AttemptObservation,
		interruption: "propagate-interrupt" | "report-interrupt",
	): Effect.Effect<void, never, StoreRequirements | FailureRequirements>;
}

function attemptRecorder<StoreError, StoreRequirements, FailureRequirements>(
	store: AccountingStore<StoreError, StoreRequirements>,
	intent: AttemptIntent,
	onPersistenceFailure: (
		failure: AccountingPersistenceFailure,
	) => Effect.Effect<void, never, FailureRequirements>,
	timeout: Duration.Duration,
): AttemptRecorder<StoreError, StoreRequirements, FailureRequirements> {
	const within = <A, E, R>(write: Effect.Effect<A, E, R>) =>
		Effect.timeout(
			Effect.suspend(() => write),
			timeout,
		);
	const report = (failure: AccountingPersistenceFailure) =>
		Effect.suspend(() => onPersistenceFailure(failure)).pipe(
			Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.void }),
			Effect.exit,
			Effect.asVoid,
		);
	const reportObservation = (observation: AttemptObservation, cause: unknown) =>
		report({ phase: "observation", attemptId: intent.attemptId, observation, cause });
	return {
		store,
		within,
		report,
		putObservation: (observation, interruption) =>
			within(store.putObservation(observation)).pipe(
				Effect.flatMap((result) =>
					result === "conflict"
						? reportObservation(
								observation,
								new AccountingIntegrityError({
									message: "Observation ID already contains different evidence",
								}),
							)
						: Effect.void,
				),
				Effect.catchCause((cause) =>
					interruption === "propagate-interrupt" && Cause.hasInterruptsOnly(cause)
						? Effect.failCause(cause as Cause.Cause<never>)
						: reportObservation(observation, cause),
				),
			),
	};
}

function classifyFailure(
	classify: ((cause: unknown) => Exclude<ExecutionOutcome, "succeeded">) | undefined,
	cause: unknown,
): Exclude<ExecutionOutcome, "succeeded"> {
	// A throwing classifier must not cost the attempt its terminal record.
	try {
		return classify?.(cause) ?? "failed";
	} catch {
		return "failed";
	}
}

const currentTimestamp = Clock.currentTimeMillis.pipe(
	Effect.map((milliseconds) => new Date(milliseconds).toISOString() as Timestamp),
);

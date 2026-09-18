import { Cause, Clock, Data, Effect, Exit, Result } from "effect";
import {
	type AccountingStore,
	createAttemptLedgerSync,
	InvalidAccountingLedgerError,
} from "./lifecycle.ts";
import type {
	AttemptIntent,
	AttemptObservation,
	ExecutionOutcome,
	UsageEvidence,
} from "./types.ts";

export type DispatchPolicy = "block" | "continue";

export interface AccountingPersistenceFailure {
	readonly phase: "intent" | "dispatch" | "observation";
	readonly attemptId: string;
	readonly intent?: AttemptIntent;
	readonly observation?: AttemptObservation;
	readonly cause: unknown;
}

export interface AttemptObservationWriter<R = never> {
	recordUsage(input: {
		readonly usageKey: string;
		readonly observedAt: string;
		readonly evidence: UsageEvidence;
		readonly supersedesObservationId?: string;
	}): Effect.Effect<void, InvalidAccountingObservationError, R>;
	recordResponseMetadata(input: {
		readonly metadataKey: string;
		readonly observedAt: string;
		readonly returnedModel: string;
		readonly providerRequestId?: string;
		readonly supersedesObservationId?: string;
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
	readonly intent: AttemptIntent;
	readonly dispatchPolicy: DispatchPolicy;
	readonly onPersistenceFailure: (
		failure: AccountingPersistenceFailure,
	) => Effect.Effect<void, never, FailureRequirements>;
	readonly classifyFailure?: (cause: unknown) => Exclude<ExecutionOutcome, "succeeded" | "unknown">;
	readonly operation: (
		writer: AttemptObservationWriter<StoreRequirements | FailureRequirements>,
	) => Effect.Effect<A, E, R>;
	readonly persistenceTimeoutMs?: number;
}

export class AccountingDispatchAlreadyClaimedError extends Data.TaggedError(
	"AccountingDispatchAlreadyClaimedError",
)<{ readonly attemptId: string }> {}

export class AccountingDispatchBlockedError extends Data.TaggedError(
	"AccountingDispatchBlockedError",
)<{ readonly attemptId: string; readonly cause: unknown }> {}

export class AccountingIntegrityError extends Data.TaggedError("AccountingIntegrityError")<{
	readonly message: string;
}> {}

export class InvalidAccountingOptionsError extends Data.TaggedError(
	"InvalidAccountingOptionsError",
)<{ readonly message: string }> {}

export class InvalidAccountingObservationError extends Data.TaggedError(
	"InvalidAccountingObservationError",
)<{ readonly message: string }> {}

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
	| InvalidAccountingLedgerError
	| InvalidAccountingObservationError
	| InvalidAccountingOptionsError,
	R | StoreRequirements | FailureRequirements
> {
	const timeoutMs = options.persistenceTimeoutMs ?? 5_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
		return yield* new InvalidAccountingOptionsError({
			message: "Persistence timeout must be a positive safe integer",
		});
	}
	yield* Effect.try({
		try: () => createAttemptLedgerSync(options.intent),
		catch: (cause) => new InvalidAccountingLedgerError({ cause }),
	});
	yield* Effect.annotateCurrentSpan({
		"accounting.attempt.id": options.intent.attemptId,
		"accounting.execution.id": options.intent.executionId,
		"accounting.provider": options.intent.provider.provider,
		"accounting.model.requested": options.intent.provider.requestedModel,
		"accounting.dispatch_policy": options.dispatchPolicy,
	});

	const intentWrite = yield* persistWithin(
		Effect.suspend(() => options.store.putIntent(options.intent)),
		timeoutMs,
	).pipe(Effect.result);
	if (Result.isFailure(intentWrite)) {
		yield* reportPersistenceFailure(options, timeoutMs, {
			phase: "intent",
			attemptId: options.intent.attemptId,
			intent: options.intent,
			cause: intentWrite.failure,
		});
		if (options.dispatchPolicy === "block") {
			return yield* new AccountingDispatchBlockedError({
				attemptId: options.intent.attemptId,
				cause: intentWrite.failure,
			});
		}
	} else if (intentWrite.success === "conflict") {
		return yield* new AccountingIntegrityError({
			message: "Attempt ID already contains different intent",
		});
	}

	const dispatchedAt = yield* currentTimestamp;
	const dispatchObservation = {
		observationId: `${options.intent.attemptId}:dispatched`,
		attemptId: options.intent.attemptId,
		observedAt: dispatchedAt,
		payload: { type: "dispatched" as const, dispatchedAt },
	};
	yield* validateObservation(options.intent, dispatchObservation);
	const claim = yield* persistWithin(
		Effect.suspend(() => options.store.claimDispatch(dispatchObservation)),
		timeoutMs,
	).pipe(Effect.result);
	if (Result.isFailure(claim)) {
		yield* reportPersistenceFailure(options, timeoutMs, {
			phase: "dispatch",
			attemptId: options.intent.attemptId,
			observation: dispatchObservation,
			cause: claim.failure,
		});
		return yield* new AccountingDispatchBlockedError({
			attemptId: options.intent.attemptId,
			cause: claim.failure,
		});
	} else if (claim.success === "already-dispatched" || claim.success === "terminal") {
		return yield* new AccountingDispatchAlreadyClaimedError({
			attemptId: options.intent.attemptId,
		});
	} else if (claim.success === "conflict") {
		return yield* new AccountingIntegrityError({
			message: "Dispatch claim conflicts with stored evidence",
		});
	}

	const writer = observationWriter(options, timeoutMs);
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const result = yield* Effect.exit(restore(Effect.suspend(() => options.operation(writer))));
			const endedAt = yield* currentTimestamp;
			const outcome = Exit.isSuccess(result)
				? "succeeded"
				: Cause.hasInterruptsOnly(result.cause)
					? "cancelled"
					: classifyFailure(options.classifyFailure, Cause.squash(result.cause));
			const terminalObservation: AttemptObservation = {
				observationId: `${options.intent.attemptId}:terminal`,
				attemptId: options.intent.attemptId,
				observedAt: endedAt,
				payload: { type: "terminal", endedAt, outcome },
			};
			yield* validateObservation(options.intent, terminalObservation);
			yield* persistObservation(options, timeoutMs, terminalObservation, false);
			return Exit.isSuccess(result) ? result.value : yield* Effect.failCause(result.cause);
		}),
	);
});

function observationWriter<StoreError, StoreRequirements, FailureRequirements>(
	options: CollectAttemptOptions<
		unknown,
		unknown,
		unknown,
		StoreError,
		StoreRequirements,
		FailureRequirements
	>,
	timeoutMs: number,
): AttemptObservationWriter<StoreRequirements | FailureRequirements> {
	return {
		recordUsage: (input) => {
			if (!/^[A-Za-z0-9._-]+$/.test(input.usageKey)) {
				return new InvalidAccountingObservationError({ message: "Invalid usage key" });
			}
			const observation: AttemptObservation = {
				observationId: `${options.intent.attemptId}:usage:${input.usageKey}`,
				attemptId: options.intent.attemptId,
				observedAt: input.observedAt,
				supersedesObservationId: input.supersedesObservationId,
				payload: { type: "usage", evidence: input.evidence },
			};
			return validateObservation(options.intent, observation).pipe(
				Effect.andThen(persistObservation(options, timeoutMs, observation)),
			);
		},
		recordResponseMetadata: (input) => {
			if (!/^[A-Za-z0-9._-]+$/.test(input.metadataKey)) {
				return new InvalidAccountingObservationError({ message: "Invalid metadata key" });
			}
			const observation: AttemptObservation = {
				observationId: `${options.intent.attemptId}:response-metadata:${input.metadataKey}`,
				attemptId: options.intent.attemptId,
				observedAt: input.observedAt,
				supersedesObservationId: input.supersedesObservationId,
				payload: {
					type: "response-metadata",
					returnedModel: input.returnedModel,
					providerRequestId: input.providerRequestId,
				},
			};
			return validateObservation(options.intent, observation).pipe(
				Effect.andThen(persistObservation(options, timeoutMs, observation)),
			);
		},
	};
}

function persistObservation<StoreError, StoreRequirements, FailureRequirements>(
	options: CollectAttemptOptions<
		unknown,
		unknown,
		unknown,
		StoreError,
		StoreRequirements,
		FailureRequirements
	>,
	timeoutMs: number,
	observation: AttemptObservation,
	preserveInterrupt = true,
): Effect.Effect<void, never, StoreRequirements | FailureRequirements> {
	return persistWithin(
		Effect.suspend(() => options.store.putObservation(observation)),
		timeoutMs,
	).pipe(
		Effect.flatMap((result) =>
			result === "conflict"
				? reportPersistenceFailure(
						options,
						timeoutMs,
						{
							phase: "observation",
							attemptId: options.intent.attemptId,
							observation,
							cause: new AccountingIntegrityError({
								message: "Observation ID already contains different evidence",
							}),
						},
						!preserveInterrupt,
					)
				: Effect.void,
		),
		Effect.catchCause((cause) =>
			preserveInterrupt && Cause.hasInterruptsOnly(cause)
				? Effect.failCause(cause as Cause.Cause<never>)
				: reportPersistenceFailure(
						options,
						timeoutMs,
						{
							phase: "observation",
							attemptId: options.intent.attemptId,
							observation,
							cause,
						},
						!preserveInterrupt,
					),
		),
	);
}

function validateObservation(
	intent: AttemptIntent,
	observation: AttemptObservation,
): Effect.Effect<void, InvalidAccountingObservationError> {
	return Effect.suspend(() => {
		const startedAt = Date.parse(intent.startedAt);
		const observedAt = Date.parse(observation.observedAt);
		const validPayload =
			observation.payload.type !== "response-metadata" ||
			observation.payload.returnedModel.length > 0;
		return Number.isFinite(startedAt) &&
			Number.isFinite(observedAt) &&
			observedAt >= startedAt &&
			validPayload
			? Effect.void
			: new InvalidAccountingObservationError({
					message: "Observation identity, timestamp, or response metadata is invalid",
				});
	});
}

function classifyFailure(
	classify: CollectAttemptOptions<
		unknown,
		unknown,
		unknown,
		unknown,
		unknown,
		unknown
	>["classifyFailure"],
	cause: unknown,
): Exclude<ExecutionOutcome, "succeeded" | "unknown"> {
	try {
		return classify?.(cause) ?? "failed";
	} catch {
		return "failed";
	}
}

function reportPersistenceFailure<StoreError, StoreRequirements, FailureRequirements>(
	options: CollectAttemptOptions<
		unknown,
		unknown,
		unknown,
		StoreError,
		StoreRequirements,
		FailureRequirements
	>,
	timeoutMs: number,
	failure: AccountingPersistenceFailure,
	containInterrupt = false,
): Effect.Effect<void, never, FailureRequirements> {
	const report = Effect.suspend(() => options.onPersistenceFailure(failure)).pipe(
		Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.void }),
		Effect.catchDefect(() => Effect.void),
	);
	return containInterrupt ? Effect.asVoid(Effect.exit(report)) : report;
}

function persistWithin<A, E, R>(
	effect: Effect.Effect<A, E, R>,
	timeoutMs: number,
): Effect.Effect<A, E | Cause.TimeoutError, R> {
	return Effect.timeout(effect, timeoutMs);
}

const currentTimestamp = Clock.currentTimeMillis.pipe(
	Effect.map((milliseconds) => new Date(milliseconds).toISOString()),
);

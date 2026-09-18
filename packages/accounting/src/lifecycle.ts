import { Data, Effect } from "effect";
import { normalizeUsageSync } from "./normalization.ts";
import type {
	AttemptIntent,
	AttemptLedger,
	AttemptObservation,
	AttemptState,
	LedgerIssue,
	MeasurementCompleteness,
	ProviderIdentity,
} from "./types.ts";

export type ApplyObservationResult =
	| { status: "applied"; ledger: AttemptLedger }
	| { status: "duplicate"; ledger: AttemptLedger }
	| { status: "conflict" | "rejected"; ledger: AttemptLedger; issue: LedgerIssue };

export interface AccountingStore<E = never, R = never> {
	putIntent(intent: AttemptIntent): Effect.Effect<"created" | "duplicate" | "conflict", E, R>;
	claimDispatch(
		observation: AttemptObservation & { payload: { type: "dispatched"; dispatchedAt: string } },
	): Effect.Effect<"claimed" | "already-dispatched" | "terminal" | "conflict", E, R>;
	putObservation(
		observation: AttemptObservation,
	): Effect.Effect<"created" | "duplicate" | "conflict", E, R>;
}

export class InvalidAccountingLedgerError extends Data.TaggedError("InvalidAccountingLedgerError")<{
	readonly cause: unknown;
}> {}

export const createAttemptLedger = Effect.fn("accounting.createAttemptLedger")(function* (
	intent: AttemptIntent,
) {
	return yield* Effect.try({
		try: () => createAttemptLedgerSync(intent),
		catch: (cause) => new InvalidAccountingLedgerError({ cause }),
	});
});

export function createAttemptLedgerSync(intent: AttemptIntent): AttemptLedger {
	validateIntent(intent);
	return {
		intent,
		observations: [],
		state: "intended",
		measurementCompleteness: "unmeasured",
		issues: [],
	};
}

export const applyObservation = Effect.fn("accounting.applyObservation")(function* (
	ledger: AttemptLedger,
	observation: AttemptObservation,
) {
	return yield* Effect.succeed(applyObservationSync(ledger, observation));
});

export function applyObservationSync(
	ledger: AttemptLedger,
	observation: AttemptObservation,
): ApplyObservationResult {
	if (
		!observation.observationId ||
		!Number.isFinite(Date.parse(observation.observedAt)) ||
		(observation.payload.type === "dispatched" &&
			(!Number.isFinite(Date.parse(observation.payload.dispatchedAt)) ||
				Date.parse(observation.payload.dispatchedAt) < Date.parse(ledger.intent.startedAt))) ||
		(observation.payload.type === "response-metadata" && !observation.payload.returnedModel) ||
		(observation.payload.type === "terminal" &&
			(!Number.isFinite(Date.parse(observation.payload.endedAt)) ||
				Date.parse(observation.payload.endedAt) < Date.parse(ledger.intent.startedAt)))
	) {
		return rejected(
			ledger,
			observation,
			"invalid-record",
			"Observation identity or timestamp is invalid",
		);
	}
	if (observation.attemptId !== ledger.intent.attemptId) {
		return rejected(
			ledger,
			observation,
			"correction-attempt-mismatch",
			"Observation belongs to another attempt",
		);
	}
	const sameId = ledger.observations.find(
		(candidate) => candidate.observationId === observation.observationId,
	);
	if (sameId) {
		if (stableJson(sameId) === stableJson(observation)) return { status: "duplicate", ledger };
		return rejected(
			ledger,
			observation,
			"conflicting-id",
			"Observation ID was already used for different evidence",
			"conflict",
		);
	}

	const active = activeObservations(ledger.observations);
	if (observation.supersedesObservationId) {
		const target = active.find(
			(candidate) => candidate.observationId === observation.supersedesObservationId,
		);
		if (!target) {
			return rejected(
				ledger,
				observation,
				"missing-correction-target",
				"Correction target does not exist or was already superseded",
			);
		}
		if (target.payload.type !== observation.payload.type) {
			return rejected(
				ledger,
				observation,
				"superseded-observation",
				"A correction must have the same payload type as its target",
			);
		}
	} else if (
		observation.payload.type === "usage" &&
		active.some((candidate) => candidate.payload.type === "usage")
	) {
		return rejected(
			ledger,
			observation,
			"conflicting-usage",
			"New usage evidence must explicitly supersede the active usage observation",
			"conflict",
		);
	} else if (
		observation.payload.type === "response-metadata" &&
		active.some((candidate) => candidate.payload.type === "response-metadata")
	) {
		return rejected(
			ledger,
			observation,
			"conflicting-usage",
			"New response metadata must explicitly supersede the active observation",
			"conflict",
		);
	} else if (observation.payload.type === "terminal" && active.some(isTerminal)) {
		return rejected(
			ledger,
			observation,
			"conflicting-terminal-state",
			"A terminal outcome can only change through an explicit correction",
		);
	}

	const observations = [...ledger.observations, observation];
	return {
		status: "applied",
		ledger: deriveLedger(ledger.intent, observations, ledger.issues),
	};
}

export const providerIdentityForLedger = Effect.fn("accounting.providerIdentityForLedger")(
	function* (ledger: AttemptLedger) {
		return yield* Effect.succeed(providerIdentityForLedgerSync(ledger));
	},
);

export function providerIdentityForLedgerSync(ledger: AttemptLedger): ProviderIdentity {
	const superseded = new Set(
		ledger.observations.flatMap((observation) =>
			observation.supersedesObservationId ? [observation.supersedesObservationId] : [],
		),
	);
	const metadata = ledger.observations.findLast(
		(observation) =>
			observation.payload.type === "response-metadata" &&
			!superseded.has(observation.observationId),
	);
	return metadata?.payload.type === "response-metadata"
		? {
				...ledger.intent.provider,
				returnedModel: metadata.payload.returnedModel,
				providerRequestId: metadata.payload.providerRequestId,
			}
		: ledger.intent.provider;
}

function validateIntent(intent: AttemptIntent): void {
	const required = [
		intent.attemptId,
		intent.executionId,
		intent.attribution.workspaceId,
		intent.provider.connectionId,
		intent.provider.provider,
		intent.provider.requestedModel,
	];
	if (required.some((value) => value.length === 0)) {
		throw new Error(
			"Attempt, execution, workspace, connection, provider, and model IDs are required",
		);
	}
	if (!Number.isFinite(Date.parse(intent.startedAt)))
		throw new Error("Attempt start time is invalid");
	if (intent.retryOfAttemptId === intent.attemptId)
		throw new Error("An attempt cannot retry itself");
}

export const reduceAttempt = Effect.fn("accounting.reduceAttempt")(function* (
	intent: AttemptIntent,
	observations: readonly AttemptObservation[],
) {
	return yield* Effect.try({
		try: () => reduceAttemptSync(intent, observations),
		catch: (cause) => new InvalidAccountingLedgerError({ cause }),
	});
});

export function reduceAttemptSync(
	intent: AttemptIntent,
	observations: readonly AttemptObservation[],
): AttemptLedger {
	const ordered = [...observations].sort(
		(left, right) =>
			left.observedAt.localeCompare(right.observedAt) ||
			left.observationId.localeCompare(right.observationId),
	);
	let ledger = ordered
		.filter((observation) => observation.supersedesObservationId === undefined)
		.reduce(
			(current, observation) => applyObservationSync(current, observation).ledger,
			createAttemptLedgerSync(intent),
		);
	let pending = ordered.filter((observation) => observation.supersedesObservationId !== undefined);
	while (pending.length > 0) {
		const ready = pending.filter((observation) =>
			ledger.observations.some(
				(candidate) => candidate.observationId === observation.supersedesObservationId,
			),
		);
		if (ready.length === 0) break;
		for (const observation of ready) ledger = applyObservationSync(ledger, observation).ledger;
		const readyIds = new Set(ready.map((observation) => observation.observationId));
		pending = pending.filter((observation) => !readyIds.has(observation.observationId));
	}
	for (const observation of pending) ledger = applyObservationSync(ledger, observation).ledger;
	return ledger;
}

function deriveLedger(
	intent: AttemptIntent,
	observations: readonly AttemptObservation[],
	issues: readonly LedgerIssue[],
): AttemptLedger {
	const active = activeObservations(observations);
	const terminal = active.findLast(isTerminal);
	const state: AttemptState = terminal
		? terminal.payload.outcome
		: active.some((observation) => observation.payload.type === "dispatched")
			? "dispatched"
			: "intended";
	const completeness = active
		.filter(isUsage)
		.map((observation) => normalizeUsageSync(observation.payload.evidence).completeness);
	return {
		intent,
		observations,
		state,
		measurementCompleteness: combineCompleteness(completeness),
		issues,
	};
}

function activeObservations(
	observations: readonly AttemptObservation[],
): readonly AttemptObservation[] {
	const superseded = new Set(
		observations.flatMap((observation) =>
			observation.supersedesObservationId ? [observation.supersedesObservationId] : [],
		),
	);
	return observations.filter((observation) => !superseded.has(observation.observationId));
}

function combineCompleteness(values: readonly MeasurementCompleteness[]): MeasurementCompleteness {
	if (values.length === 0 || values.every((value) => value === "unmeasured")) return "unmeasured";
	return values.every((value) => value === "complete") ? "complete" : "partial";
}

function isTerminal(observation: AttemptObservation): observation is AttemptObservation & {
	payload: Extract<AttemptObservation["payload"], { type: "terminal" }>;
} {
	return observation.payload.type === "terminal";
}

function isUsage(observation: AttemptObservation): observation is AttemptObservation & {
	payload: Extract<AttemptObservation["payload"], { type: "usage" }>;
} {
	return observation.payload.type === "usage";
}

function rejected(
	ledger: AttemptLedger,
	observation: AttemptObservation,
	code: LedgerIssue["code"],
	message: string,
	status: "conflict" | "rejected" = "rejected",
): ApplyObservationResult {
	const issue = { code, observationId: observation.observationId, message };
	return {
		status,
		ledger: { ...ledger, issues: [...ledger.issues, issue] },
		issue,
	};
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

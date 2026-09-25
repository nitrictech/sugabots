import type { Effect } from "effect";
import { normalizeUsage } from "./normalization.ts";
import {
	type AttemptIntent,
	type AttemptObservation,
	epochMilliseconds,
	type ObservationPayload,
} from "./schemas.ts";
import type {
	AttemptState,
	LedgerIssue,
	LedgerIssueCode,
	NormalizedUsage,
	ProviderIdentity,
} from "./types.ts";

/**
 * Persistence for attempts. Every write must be idempotent: replaying an identical record reports
 * `duplicate`, and reusing an ID for a different record reports `conflict` without overwriting.
 */
export interface AccountingStore<E = never, R = never> {
	putIntent(intent: AttemptIntent): Effect.Effect<"created" | "duplicate" | "conflict", E, R>;
	/** Atomically records dispatch, so at most one caller may send the provider request. */
	claimDispatch(
		observation: DispatchedObservation,
	): Effect.Effect<"claimed" | "already-dispatched" | "terminal" | "conflict", E, R>;
	putObservation(
		observation: AttemptObservation,
	): Effect.Effect<"created" | "duplicate" | "conflict", E, R>;
}

export type DispatchedObservation = AttemptObservation & {
	readonly payload: Extract<ObservationPayload, { type: "dispatched" }>;
};

declare const attemptLedgerBrand: unique symbol;

/**
 * An attempt's state derived from its intent and observations. Only `reduceAttempt` and
 * `applyObservation` produce one, so its derived fields always agree with its observations.
 */
export interface AttemptLedger {
	readonly [attemptLedgerBrand]: true;
	readonly intent: AttemptIntent;
	readonly observations: readonly AttemptObservation[];
	readonly state: AttemptState;
	readonly provider: ProviderIdentity;
	/** The active usage observation, normalized; absent until usage is recorded. */
	readonly usage?: NormalizedUsage;
	/** Observations that were rejected or conflicted with recorded evidence. */
	readonly issues: readonly LedgerIssue[];
}

export type ApplyObservationResult =
	| { readonly status: "applied" | "duplicate"; readonly ledger: AttemptLedger }
	| {
			readonly status: "conflict" | "rejected";
			readonly ledger: AttemptLedger;
			readonly issue: LedgerIssue;
	  };

/** Rebuilds a ledger from stored observations, independent of the order they were read in. */
export function reduceAttempt(
	intent: AttemptIntent,
	observations: readonly AttemptObservation[],
): AttemptLedger {
	const ordered = [...observations].sort(
		(left, right) =>
			epochMilliseconds(left.observedAt) - epochMilliseconds(right.observedAt) ||
			left.observationId.localeCompare(right.observationId),
	);
	let ledger = ordered
		.filter((observation) => observation.supersedesObservationId === undefined)
		.reduce(
			(current, observation) => applyObservation(current, observation).ledger,
			deriveLedger(intent, [], []),
		);
	// A correction can only apply once its target is present, and a target may itself be a
	// correction, so apply them in waves until none become ready.
	let pending = ordered.filter((observation) => observation.supersedesObservationId !== undefined);
	while (pending.length > 0) {
		const ready = pending.filter((observation) =>
			ledger.observations.some(
				(candidate) => candidate.observationId === observation.supersedesObservationId,
			),
		);
		if (ready.length === 0) break;
		for (const observation of ready) ledger = applyObservation(ledger, observation).ledger;
		pending = pending.filter((observation) => !ready.includes(observation));
	}
	// Whatever remains has no target; applying it records the issue.
	for (const observation of pending) ledger = applyObservation(ledger, observation).ledger;
	return ledger;
}

export function applyObservation(
	ledger: AttemptLedger,
	observation: AttemptObservation,
): ApplyObservationResult {
	const problem = observationProblem(ledger.intent, observation);
	if (problem) return withIssue(ledger, observation, problem.code, problem.message, "rejected");

	const sameId = ledger.observations.find(
		(candidate) => candidate.observationId === observation.observationId,
	);
	if (sameId) {
		if (stableJson(sameId) === stableJson(observation)) return { status: "duplicate", ledger };
		return withIssue(
			ledger,
			observation,
			"conflicting-id",
			"Observation ID was already used for different evidence",
			"conflict",
		);
	}

	const active = activeObservations(ledger.observations);
	const conflict = observation.supersedesObservationId
		? correctionProblem(active, observation, observation.supersedesObservationId)
		: activeEvidenceConflict(active, observation);
	if (conflict) {
		return withIssue(ledger, observation, conflict.code, conflict.message, conflict.status);
	}

	return {
		status: "applied",
		ledger: deriveLedger(ledger.intent, [...ledger.observations, observation], ledger.issues),
	};
}

/** Why an observation cannot belong to this attempt, or `undefined` if it can. */
export function observationProblem(
	intent: AttemptIntent,
	observation: AttemptObservation,
): { readonly code: LedgerIssueCode; readonly message: string } | undefined {
	if (observation.attemptId !== intent.attemptId) {
		return { code: "attempt-mismatch", message: "Observation belongs to another attempt" };
	}
	const startedAt = epochMilliseconds(intent.startedAt);
	const timestamps = [observation.observedAt, ...payloadTimestamps(observation.payload)];
	if (timestamps.some((timestamp) => epochMilliseconds(timestamp) < startedAt)) {
		return { code: "observed-before-start", message: "Observation precedes the attempt start" };
	}
	return undefined;
}

function payloadTimestamps(payload: ObservationPayload) {
	if (payload.type === "dispatched") return [payload.dispatchedAt];
	if (payload.type === "terminal") return [payload.endedAt];
	return [];
}

interface EvidenceConflict {
	readonly code: LedgerIssueCode;
	readonly message: string;
	readonly status: "conflict" | "rejected";
}

function correctionProblem(
	active: readonly AttemptObservation[],
	correction: AttemptObservation,
	targetId: AttemptObservation["observationId"],
): EvidenceConflict | undefined {
	const target = active.find((candidate) => candidate.observationId === targetId);
	if (!target) {
		return {
			code: "missing-correction-target",
			message: "Correction target does not exist or was already superseded",
			status: "rejected",
		};
	}
	if (target.payload.type !== correction.payload.type) {
		return {
			code: "correction-type-mismatch",
			message: "A correction must have the same payload type as its target",
			status: "rejected",
		};
	}
	return undefined;
}

/** Usage, response metadata, and terminal outcomes may each have only one active observation. */
const SINGLE_ACTIVE_EVIDENCE: Partial<Record<ObservationPayload["type"], EvidenceConflict>> = {
	usage: {
		code: "conflicting-usage",
		message: "New usage evidence must explicitly supersede the active usage observation",
		status: "conflict",
	},
	"response-metadata": {
		code: "conflicting-response-metadata",
		message: "New response metadata must explicitly supersede the active observation",
		status: "conflict",
	},
	terminal: {
		code: "conflicting-terminal-state",
		message: "A terminal outcome can only change through an explicit correction",
		status: "rejected",
	},
};

function activeEvidenceConflict(
	active: readonly AttemptObservation[],
	observation: AttemptObservation,
): EvidenceConflict | undefined {
	const type = observation.payload.type;
	const hasActive = active.some((candidate) => candidate.payload.type === type);
	return hasActive ? SINGLE_ACTIVE_EVIDENCE[type] : undefined;
}

function deriveLedger(
	intent: AttemptIntent,
	observations: readonly AttemptObservation[],
	issues: readonly LedgerIssue[],
): AttemptLedger {
	const active = activeObservations(observations);
	const latest = <T extends ObservationPayload["type"]>(type: T) =>
		active.findLast((observation) => observation.payload.type === type)?.payload as
			| Extract<ObservationPayload, { type: T }>
			| undefined;
	const terminal = latest("terminal");
	const dispatched = latest("dispatched");
	const usage = latest("usage");
	const metadata = latest("response-metadata");
	return {
		intent,
		observations,
		state: terminal?.outcome ?? (dispatched ? "dispatched" : "intended"),
		provider: metadata
			? {
					...intent.provider,
					returnedModel: metadata.returnedModel,
					providerRequestId: metadata.providerRequestId,
				}
			: intent.provider,
		usage: usage && normalizeUsage(usage.evidence),
		issues,
	} as AttemptLedger;
}

function activeObservations(
	observations: readonly AttemptObservation[],
): readonly AttemptObservation[] {
	const superseded = new Set(
		observations.map((observation) => observation.supersedesObservationId),
	);
	return observations.filter((observation) => !superseded.has(observation.observationId));
}

function withIssue(
	ledger: AttemptLedger,
	observation: AttemptObservation,
	code: LedgerIssueCode,
	message: string,
	status: "conflict" | "rejected",
): ApplyObservationResult {
	const issue = { code, observationId: observation.observationId, message };
	return {
		status,
		ledger: { ...ledger, issues: [...ledger.issues, issue] },
		issue,
	};
}

/** JSON with sorted keys and without `undefined` fields, so equal records serialize equally. */
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

import { USAGE_COUNTER_FIELDS, type UsageCounters, type UsageEvidence } from "./schemas.ts";
import type { MeasurementCompleteness, NormalizedUsage, UsageIssue } from "./types.ts";

/** Checks counters for validity and consistency and reports how completely usage was measured. */
export function normalizeUsage(evidence: UsageEvidence): NormalizedUsage {
	const { counters } = evidence;
	const invalidCounters = invalidCounterIssues(counters);
	const issues = invalidCounters.length > 0 ? invalidCounters : [...consistencyIssues(counters)];
	if (evidence.containsProviderSubrequests) {
		issues.push({
			code: "unsupported-provider-evidence",
			message: "Provider subrequest iterations require separate model-scoped observations",
		});
	}
	return { counters, completeness: measurementCompleteness(counters, issues), issues };
}

function invalidCounterIssues(counters: UsageCounters): UsageIssue[] {
	return USAGE_COUNTER_FIELDS.flatMap((field) => {
		const value = counters[field];
		if (value === undefined || (Number.isSafeInteger(value) && value >= 0)) return [];
		return [
			{
				code: "invalid-counter" as const,
				field,
				message: `${field} must be a non-negative safe integer`,
			},
		];
	});
}

function consistencyIssues(counters: UsageCounters): UsageIssue[] {
	return [inputComponentsIssue(counters), reasoningIssue(counters)].filter(
		(issue) => issue !== undefined,
	);
}

function inputComponentsIssue(counters: UsageCounters): UsageIssue | undefined {
	const components = [
		counters.uncachedInputTokens,
		counters.cacheReadInputTokens,
		counters.cacheWriteInputTokens,
	];
	const total = counters.inputTokens;
	if (total === undefined || components.every((component) => component === undefined)) {
		return undefined;
	}
	const componentTotal = components.reduce<number>((sum, component) => sum + (component ?? 0), 0);
	if (componentTotal > total) {
		return {
			code: "input-components-exceed-total",
			message: `Input components (${componentTotal}) exceed input total (${total})`,
		};
	}
	const allComponentsMeasured = components.every((component) => component !== undefined);
	if (allComponentsMeasured && componentTotal !== total) {
		return {
			code: "input-components-incomplete",
			message: `Input components (${componentTotal}) do not equal input total (${total})`,
		};
	}
	return undefined;
}

function reasoningIssue(counters: UsageCounters): UsageIssue | undefined {
	const { reasoningTokens, outputTokens } = counters;
	if (reasoningTokens === undefined || outputTokens === undefined) return undefined;
	if (reasoningTokens <= outputTokens) return undefined;
	return {
		code: "reasoning-exceeds-output",
		message: `Reasoning tokens (${reasoningTokens}) exceed output total (${outputTokens})`,
	};
}

function measurementCompleteness(
	counters: UsageCounters,
	issues: readonly UsageIssue[],
): MeasurementCompleteness {
	if (USAGE_COUNTER_FIELDS.every((field) => counters[field] === undefined)) return "unmeasured";
	if (issues.length > 0) return "partial";
	const totalsMeasured = counters.inputTokens !== undefined && counters.outputTokens !== undefined;
	return totalsMeasured ? "complete" : "partial";
}

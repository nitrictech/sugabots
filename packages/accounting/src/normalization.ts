import { Effect } from "effect";
import type {
	MeasurementCompleteness,
	NormalizedUsage,
	UsageCounters,
	UsageEvidence,
	UsageIssue,
} from "./types.ts";

export const normalizeUsage = Effect.fn("accounting.normalizeUsage")(function* (
	evidence: UsageEvidence,
) {
	yield* Effect.annotateCurrentSpan({
		"accounting.evidence.source": evidence.source.name,
		"accounting.normalization.version": evidence.normalizationVersion,
	});
	return normalizeUsageSync(evidence);
});

export function normalizeUsageSync(evidence: UsageEvidence): NormalizedUsage {
	const counters = evidence.counters;
	const issues = invalidCounterIssues(counters);
	if (hasProviderSubrequests(evidence)) {
		issues.push({
			code: "unsupported-provider-evidence",
			message: "Provider subrequest iterations require separate model-scoped observations",
		});
	}
	const allCountersValid = issues.length === 0;

	if (allCountersValid) {
		const componentTotal =
			(counters.uncachedInputTokens ?? 0) +
			(counters.cacheReadInputTokens ?? 0) +
			(counters.cacheWriteInputTokens ?? 0);
		const hasInputComponent =
			counters.uncachedInputTokens !== undefined ||
			counters.cacheReadInputTokens !== undefined ||
			counters.cacheWriteInputTokens !== undefined;

		if (counters.inputTokens !== undefined && hasInputComponent) {
			if (componentTotal > counters.inputTokens) {
				issues.push({
					code: "input-components-exceed-total",
					message: `Input components (${componentTotal}) exceed input total (${counters.inputTokens})`,
				});
			} else if (
				counters.uncachedInputTokens !== undefined &&
				counters.cacheReadInputTokens !== undefined &&
				counters.cacheWriteInputTokens !== undefined &&
				componentTotal !== counters.inputTokens
			) {
				issues.push({
					code: "input-components-incomplete",
					message: `Input components (${componentTotal}) do not equal input total (${counters.inputTokens})`,
				});
			}
		}

		if (
			counters.reasoningTokens !== undefined &&
			counters.outputTokens !== undefined &&
			counters.reasoningTokens > counters.outputTokens
		) {
			issues.push({
				code: "reasoning-exceeds-output",
				message: `Reasoning tokens (${counters.reasoningTokens}) exceed output total (${counters.outputTokens})`,
			});
		}
	}

	return {
		input: {
			total: counters.inputTokens,
			uncached: counters.uncachedInputTokens,
			cacheRead: counters.cacheReadInputTokens,
			cacheWrite: counters.cacheWriteInputTokens,
		},
		output: {
			total: counters.outputTokens,
			reasoning: counters.reasoningTokens,
		},
		completeness: measurementCompleteness(counters, issues),
		issues,
	};
}

function hasProviderSubrequests(evidence: UsageEvidence): boolean {
	return Array.isArray(evidence.raw?.iterations) && evidence.raw.iterations.length > 0;
}

function invalidCounterIssues(counters: UsageCounters): UsageIssue[] {
	return Object.entries(counters).flatMap(([field, value]) =>
		value !== undefined && (!Number.isSafeInteger(value) || value < 0)
			? [
					{
						code: "invalid-counter" as const,
						field: field as keyof UsageCounters,
						message: `${field} must be a non-negative safe integer`,
					},
				]
			: [],
	);
}

function measurementCompleteness(
	counters: UsageCounters,
	issues: readonly UsageIssue[],
): MeasurementCompleteness {
	const measuredCount = Object.values(counters).filter((value) => value !== undefined).length;
	if (measuredCount === 0) return "unmeasured";
	if (issues.length > 0) return "partial";
	return Object.values(counters).every((value) => value !== undefined) ? "complete" : "partial";
}

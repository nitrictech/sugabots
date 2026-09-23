import type { ThreadUsage } from "@sugabots/contracts";
import { InsetCard, InsetCardHeading } from "@/ui/inset-card.tsx";

export function UsageMeasurements({ usage }: { usage: ThreadUsage }) {
	return (
		<div className="flex flex-col gap-[11px]">
			<div className="grid grid-cols-2 gap-[11px]">
				<Metric
					label="Provider cost"
					value={formatCost(usage.reportedCost)}
					detail={formatModelCalls(usage.modelCalls)}
				/>
				<Metric
					label="Tokens"
					value={formatTokens(usage.totalTokens)}
					detail={tokenBreakdown(usage)}
				/>
			</div>
			<ContextMeasurement context={usage.latestContext} />
		</div>
	);
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
	return (
		<InsetCard className="px-3.5 py-3">
			<InsetCardHeading>{label}</InsetCardHeading>
			<div className="pt-1 font-semibold text-heading text-2xl tabular-nums">{value}</div>
			<div className="pt-0.5 text-muted-foreground text-xs tabular-nums">{detail}</div>
		</InsetCard>
	);
}

function ContextMeasurement({ context }: { context: ThreadUsage["latestContext"] }) {
	if (!context) {
		return (
			<InsetCard className="px-4 py-3.5">
				<ContextHeading />
				<p className="m-0 text-muted-foreground text-md">Not measured yet</p>
			</InsetCard>
		);
	}

	const capacity = context.capacityTokens;
	const percentage = capacity ? Math.round((context.usedTokens / capacity) * 100) : null;
	return (
		<InsetCard className="px-4 py-3.5">
			<ContextHeading />
			<div className="flex items-baseline gap-2 tabular-nums">
				<span className="font-semibold text-heading text-2xl">
					{percentage === null ? formatTokens(context.usedTokens) : `${percentage}%`}
				</span>
				<span className="text-muted-foreground text-xs">
					{capacity
						? `${formatTokens(context.usedTokens)} / ${formatTokens(capacity)}`
						: "capacity unavailable"}
				</span>
			</div>
			{percentage !== null && (
				<div
					role="progressbar"
					aria-label="Latest turn context used"
					aria-valuemin={0}
					aria-valuemax={capacity ?? undefined}
					aria-valuenow={context.usedTokens}
					className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-border"
				>
					<span
						className="block h-full rounded-full bg-agent-fill"
						style={{ width: `${Math.min(percentage, 100)}%` }}
					/>
				</div>
			)}
		</InsetCard>
	);
}

function ContextHeading() {
	return <InsetCardHeading className="pb-2">Latest context</InsetCardHeading>;
}

function formatCost(cost: number | null): string {
	if (cost === null) {
		return "—";
	}
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 4,
	}).format(cost);
}

function formatTokens(tokens: number | null): string {
	if (tokens === null) {
		return "—";
	}
	if (tokens >= 1_000_000) {
		return `${formatCompactNumber(tokens / 1_000_000)}m`;
	}
	if (tokens >= 1_000) {
		return `${formatCompactNumber(tokens / 1_000)}k`;
	}
	return new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 1,
	}).format(tokens);
}

function formatCompactNumber(value: number): string {
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function formatModelCalls(modelCalls: number | null): string {
	if (modelCalls === null) {
		return "calls unavailable";
	}
	return `${modelCalls} model ${modelCalls === 1 ? "call" : "calls"}`;
}

function tokenBreakdown(usage: ThreadUsage): string {
	if (usage.inputTokens === null || usage.outputTokens === null) {
		return "breakdown unavailable";
	}
	return `${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out`;
}

export function usageSummary(usage: ThreadUsage): string {
	if (usage.totalTokens !== null) {
		return `${formatTokens(usage.totalTokens)} tokens`;
	}
	return formatModelCalls(usage.modelCalls);
}

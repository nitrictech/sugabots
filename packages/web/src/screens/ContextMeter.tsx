import type { ThreadContext } from "@sugabots/contracts";
import { cn } from "cn";

/**
 * How much of the bot's short-term memory (its context window) the chat
 * fills, as a percentage measured on the latest reply, with a tick where older
 * messages are folded into the summary. A compaction since that reply leaves
 * the figure out of date until the next one, so the bar fades.
 */
export function ContextMeter({ context }: { context: ThreadContext }) {
	const { usedTokens, measuredAt, windowTokens, compactionLineTokens, compactedAt } = context;
	const compactedSinceMeasured = compactedAt !== null && compactedAt > measuredAt;
	const usedPercent = Math.round(Math.min(usedTokens / windowTokens, 1) * 100);
	const linePercent = Math.round((compactionLineTokens / windowTokens) * 100);
	return (
		<div className="flex flex-col gap-2.5 px-3.5 py-3">
			<span className="font-medium text-[14px] text-foreground">{usedPercent}% full</span>
			{/* The native meter can't be styled across browsers, so it is read out and the bar drawn. */}
			<meter
				className="sr-only"
				aria-label="Short-term memory used"
				min={0}
				max={100}
				value={usedPercent}
			/>
			<div
				aria-hidden
				className={cn(
					"relative h-1.5 rounded-full bg-chip",
					compactedSinceMeasured && "opacity-40",
				)}
			>
				<div
					className="absolute inset-y-0 left-0 rounded-full bg-meter transition-[width]"
					style={{ width: `${usedPercent}%` }}
				/>
				<div
					className="absolute -top-[3px] h-3 w-0.5 rounded-[1px] bg-muted-foreground"
					style={{ left: `${linePercent}%` }}
				/>
			</div>
		</div>
	);
}

import type { ThreadContext } from "@sugabots/contracts";
import { cn } from "cn";

/** How much of the bot's short-term memory the chat fills, as a whole percentage. */
export function usedPercentOf(context: ThreadContext): number {
	return Math.round(Math.min(context.usedTokens / context.windowTokens, 1) * 100);
}

/**
 * How much of the bot's short-term memory (its context window) the chat
 * fills, as a thin bar measured on the latest reply, with a tick where older
 * messages are folded into the summary. A compaction since that reply leaves
 * the figure out of date until the next one, so the bar fades.
 */
export function ContextMeter({ context }: { context: ThreadContext }) {
	const { measuredAt, windowTokens, compactionLineTokens, compactedAt } = context;
	const compactedSinceMeasured = compactedAt !== null && compactedAt > measuredAt;
	const usedPercent = usedPercentOf(context);
	const linePercent = Math.round((compactionLineTokens / windowTokens) * 100);
	return (
		<>
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
					"relative h-[3px] rounded-full bg-chip-strong",
					compactedSinceMeasured && "opacity-40",
				)}
			>
				<div
					className="absolute inset-y-0 left-0 rounded-full bg-meter transition-[width]"
					style={{ width: `${usedPercent}%` }}
				/>
				<div
					className="absolute -top-[3px] h-[9px] w-px bg-muted-foreground"
					style={{ left: `${linePercent}%` }}
				/>
			</div>
		</>
	);
}

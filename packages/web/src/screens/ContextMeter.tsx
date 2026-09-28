import type { ThreadContext } from "@sugabots/contracts";
import { cn } from "cn";
import { formatListTime } from "@/lib/list-time.ts";

/**
 * How much of the bot's short-term memory (its context window) the chat
 * fills, as a percentage measured on the latest reply, with the line where it
 * is compacted marked on the bar. A compaction since that reply leaves the
 * figure out of date until the next one, so the bar fades and says so.
 */
export function ContextMeter({
	context,
	now = new Date(),
}: {
	context: ThreadContext;
	/** What "Yesterday" and the like are measured from. */
	now?: Date;
}) {
	const { usedTokens, measuredAt, windowTokens, compactionLineTokens, compactedAt } = context;
	const compactedSinceMeasured = compactedAt !== null && compactedAt > measuredAt;
	const pastLine = !compactedSinceMeasured && usedTokens >= compactionLineTokens;
	const usedPercent = Math.round(Math.min(usedTokens / windowTokens, 1) * 100);
	const linePercent = Math.round((compactionLineTokens / windowTokens) * 100);
	return (
		<div className="flex flex-col gap-2 px-3.5 py-3">
			<span className="text-[14px] text-foreground">{usedPercent}% full</span>
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
				className={cn("relative h-2 rounded-full bg-chip", compactedSinceMeasured && "opacity-40")}
			>
				<div
					className={cn(
						"absolute inset-y-0 left-0 rounded-full transition-[width]",
						pastLine ? "bg-warning" : "bg-primary",
					)}
					style={{ width: `${usedPercent}%` }}
				/>
				<div
					aria-hidden
					className="absolute -inset-y-0.5 w-0.5 rounded-full bg-soft-foreground"
					style={{ left: `${linePercent}%` }}
				/>
			</div>
			<p className="m-0 text-muted-foreground text-xs">
				{compactedSinceMeasured
					? `Compacted ${lastCompacted(new Date(compactedAt), now)}; this updates after the next reply.`
					: [
							pastLine
								? `Past ${linePercent}%: older messages are being summarised.`
								: `Compacts at ${linePercent}%.`,
							compactedAt && `Last compacted ${lastCompacted(new Date(compactedAt), now)}.`,
						]
							.filter(Boolean)
							.join(" ")}
			</p>
		</div>
	);
}

/** "at 6:12" today, "yesterday", then "on Mon" or "on 15 Sep". */
function lastCompacted(at: Date, now: Date): string {
	if (at.toDateString() === now.toDateString()) return `at ${formatListTime(at, now)}`;
	const when = formatListTime(at, now);
	return when === "Yesterday" ? "yesterday" : `on ${when}`;
}

import type { ChatContext } from "@sugabots/contracts";
import { cn } from "cn";
import { Meter } from "@/ui/meter.tsx";

/** How much of the bot's short-term memory the chat fills, as a whole percentage. */
export function computeUsedPercent(context: ChatContext): number {
	return Math.round(Math.min(context.usedTokens / context.windowTokens, 1) * 100);
}

/**
 * How much of the bot's short-term memory (its context window) the chat
 * fills, as a thin bar measured on the latest reply, with a tick where older
 * messages are folded into the summary. A compaction since that reply leaves
 * the figure out of date until the next one, so the bar fades.
 */
export function ContextMeter({ context }: { context: ChatContext }) {
	const { measuredAt, windowTokens, compactionLineTokens, compactedAt } = context;
	const compactedSinceMeasured = compactedAt !== null && compactedAt > measuredAt;
	const usedPercent = computeUsedPercent(context);
	const linePercent = Math.round((compactionLineTokens / windowTokens) * 100);
	return (
		<Meter
			aria-label="Short-term memory used"
			value={usedPercent}
			className={cn(compactedSinceMeasured && "opacity-40")}
		>
			<span
				aria-hidden
				className="absolute -top-0.5 h-2 w-px bg-muted-foreground"
				style={{ left: `${linePercent}%` }}
			/>
		</Meter>
	);
}

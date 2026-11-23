import type { RunTriggerKind } from "@sugabots/contracts";
import { Clock, GitBranch, type LucideProps, RefreshCw, Webhook } from "lucide-react";
import { formatClockTime, formatFullTimestamp } from "@/lib/list-time.ts";
import { automationText, type WorkState } from "@/lib/work-state.ts";
import { Tooltip } from "@/ui/tooltip.tsx";
import { TypingDots } from "@/ui/typing-dots.tsx";

/**
 * A quiet row for an automation's run among a chat's messages. It lines up
 * with the messages, its mark where their faces are, and the whole of it
 * opens the run.
 */
export function RunRow({
	automationName,
	triggerKind,
	state,
	at,
	onOpen,
}: {
	automationName: string;
	triggerKind: RunTriggerKind;
	state: WorkState;
	/** When the run started. */
	at: string;
	onOpen: () => void;
}) {
	const text = automationText(automationName, state);
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`Open Automation run: ${text}`}
			className="focus-ring group/run flex w-full min-w-0 items-center gap-3.5 px-5 py-1.5 text-left"
		>
			<span aria-hidden className="grid w-9 shrink-0 place-items-center text-muted-foreground">
				{state === "failed" ? (
					<span className="grid size-3.75 place-items-center rounded-full bg-destructive font-bold text-3xs text-destructive-foreground leading-none">
						!
					</span>
				) : (
					<AutomationTriggerIcon kind={triggerKind} size={15} strokeWidth={2.2} />
				)}
			</span>
			<span className="min-w-0 truncate font-medium text-xs text-muted-foreground transition-colors group-hover/run:text-soft-foreground">
				{text}
			</span>
			{state === "running" ? (
				<TypingDots className="shrink-0 text-muted-foreground" />
			) : (
				<Tooltip label={formatFullTimestamp(at)} side="top">
					<time dateTime={at} className="shrink-0 text-subtle-foreground text-xs">
						{formatClockTime(new Date(at))}
					</time>
				</Tooltip>
			)}
		</button>
	);
}

/**
 * What started an automation's run, as a mark: a clock for a routine, a hook
 * for its webhook, a branch for its GitHub trigger.
 */
export function AutomationTriggerIcon({ kind, ...props }: { kind: RunTriggerKind } & LucideProps) {
	if (kind === "routine") return <Clock {...props} />;
	if (kind === "webhook") return <Webhook {...props} />;
	if (kind === "github") return <GitBranch {...props} />;
	return <RefreshCw {...props} />;
}

import type {
	AgentParticipant,
	ChatMessageItem,
	Pod,
	ThreadDetails,
	ThreadParticipant,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useRoutineControls } from "@/lib/chats.ts";
import { podSettingsLink } from "@/lib/links.ts";
import { formatClockTime } from "@/lib/list-time.ts";
import { nextRunWords } from "@/lib/routine-schedule.ts";
import { useRoutines } from "@/lib/routines.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Button } from "@/ui/button.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { formatDay } from "./ThreadConversation.tsx";

/*
 * A routine's own thread reads as its runs, one after another: a line naming
 * each run's day, the bot's result under it with how the run went, anything
 * said about it after, and at the foot when it runs next.
 */

type RunItem = Extract<ChatMessageItem, { kind: "routine" }>;

/** How a run went, or that its routine is paused, as the dot beside it says it. */
export type RunOutcome = "passed" | "failed" | "running" | "cancelled" | "paused";

const OUTCOME_LABEL: Record<RunOutcome, string> = {
	passed: "Passed",
	failed: "Failed",
	running: "Running",
	cancelled: "Cancelled",
	paused: "Paused",
};

const OUTCOME_DOT: Record<RunOutcome, string> = {
	passed: "bg-success",
	failed: "bg-destructive-text",
	running: "bg-subtle-foreground",
	cancelled: "bg-disabled-foreground",
	paused: "bg-disabled-foreground",
};

/** A run's state, as the dot beside it says it. */
export function outcomeOf(state: RunItem["state"]): Exclude<RunOutcome, "paused"> {
	if (state === "completed") return "passed";
	if (state === "failed") return "failed";
	if (state === "cancelled") return "cancelled";
	return "running";
}

/**
 * How a run went, or that its routine is paused, as a dot and a word. With
 * `onOpen`, it opens the run, with the work behind its result.
 */
export function RunStatus({ outcome, onOpen }: { outcome: RunOutcome; onOpen?: () => void }) {
	const content = (
		<>
			<span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", OUTCOME_DOT[outcome])} />
			{OUTCOME_LABEL[outcome]}
		</>
	);
	const className = "inline-flex items-center gap-1.5 text-muted-foreground text-xs";
	if (!onOpen) return <span className={className}>{content}</span>;
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`${OUTCOME_LABEL[outcome]}. Open the run`}
			className={cn(className, "focus-ring rounded-sm hover:text-foreground")}
		>
			{content}
		</button>
	);
}

/** The line across the thread where a run starts, naming its day. */
export function RunDivider({ at }: { at: string }) {
	const day = formatDay(new Date(at));
	const words =
		day === "Today" ? "Run today" : day === "Yesterday" ? "Run yesterday" : `Run on ${day}`;
	return <Divider>{words}</Divider>;
}

/** The line at the foot of a routine's thread saying when it runs next. Nothing while it loads. */
export function NextRunDivider({ routine }: { routine: NonNullable<ThreadDetails["routine"]> }) {
	const full = useRoutines(routine.agentId).data?.find((one) => one.id === routine.id);
	const words = routine.state === "paused" ? "Paused" : full && nextRunWords(full);
	if (!words) return null;
	return <Divider>{words}</Divider>;
}

function Divider({ children }: { children: string }) {
	return (
		<div className="flex items-center gap-3 px-5 pt-4 pb-1.5">
			<span aria-hidden className="h-px flex-1 bg-border" />
			<span className="whitespace-nowrap text-subtle-foreground text-xs">{children}</span>
			<span aria-hidden className="h-px flex-1 bg-border" />
		</div>
	);
}

/**
 * A run that posted no result, drawn as its bot's message: what the bot last
 * said in it, or, when it said nothing, how it went and, when it failed, why.
 * A run that passed and said something needs no word on how it went. The
 * latest failure, while the routine is still failing, offers to run it again
 * or to see to the connection it needs. One still running says so with dots.
 */
export function RunMessage({
	item,
	agent,
	pod,
	routine,
	conversationId,
	latest,
	mentionable,
	onOpenThread,
}: {
	item: RunItem;
	agent: AgentParticipant;
	pod: Pod;
	routine: NonNullable<ThreadDetails["routine"]>;
	conversationId: string;
	/** The newest failure while the routine is still failing, which may be retried. */
	latest: boolean;
	/** Who the report may mention, drawn as chips. */
	mentionable: ThreadParticipant[];
	onOpenThread: (threadId: string) => void;
}) {
	const controls = useRoutineControls(conversationId, routine);
	const outcome = outcomeOf(item.state);
	const open = () => onOpenThread(item.threadId);
	const report = outcome === "passed" ? item.report : null;
	return (
		<article
			aria-label={`${item.routineName}: ${OUTCOME_LABEL[outcome]}`}
			className="flex gap-3.5 px-5 pt-3.5 pb-0.5"
		>
			<span aria-hidden className="mt-0.5 flex w-9 shrink-0 justify-center">
				<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={36} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col items-start">
				<div className="flex items-center gap-2 pb-px">
					<span className="font-semibold text-[15px] text-foreground">{agent.name}</span>
					<span className="rounded-[4px] bg-chip px-[5px] py-px font-semibold text-[10.5px] text-muted-foreground leading-[1.4]">
						Bot
					</span>
					<span className="text-subtle-foreground text-xs">
						{formatClockTime(new Date(item.createdAt))}
					</span>
					{!report && <RunStatus outcome={outcome} onOpen={open} />}
				</div>
				{report ? (
					<div className="min-w-0 self-stretch break-words text-[15px] text-body-foreground leading-[1.5]">
						<MessageMarkdown text={report} mentionable={mentionable} />
					</div>
				) : outcome === "running" ? (
					<span aria-hidden className="typing-dots typing-dots-small mt-2 text-muted-foreground">
						<i />
						<i />
						<i />
					</span>
				) : (
					<p className="m-0 text-[15px] text-body-foreground leading-[1.5]">
						{item.error ??
							(outcome === "cancelled" ? "The run was stopped." : "It posted nothing.")}
					</p>
				)}
				{latest && outcome === "failed" && (
					<div className="mt-2 flex gap-2">
						<Button size="sm" disabled={controls.pending} onClick={() => void controls.runAgain()}>
							Retry
						</Button>
						<Button size="sm" variant="secondary" render={<Link {...podSettingsLink(pod)} />}>
							Fix connection
						</Button>
					</div>
				)}
			</div>
		</article>
	);
}

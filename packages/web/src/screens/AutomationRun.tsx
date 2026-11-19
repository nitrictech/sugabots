import type {
	BotParticipant,
	ChatMessageItem,
	ConversationDetails,
	Participant,
	Run,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { nextRunWords, useAutomations, useRecentRuns } from "@/lib/automations.ts";
import { useAutomationControls } from "@/lib/chats.ts";
import { formatClockTime } from "@/lib/list-time.ts";
import { useOwnerOfProject } from "@/lib/owner-of-project.ts";
import { ownerLinkOptions } from "@/lib/resource-owner.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { LabelledRule } from "@/ui/labelled-rule.tsx";
import { TypingDots } from "@/ui/typing-dots.tsx";
import { formatDay } from "./conversation-layout.ts";
import { MessageMarkdown } from "./MessageMarkdown.tsx";

/*
 * An automation's feed reads as its runs, one after another: a line naming
 * each run's day, the bot's result under it with how the run went, anything
 * said about it after, and at the foot when it runs next.
 */

type RunItem = Extract<ChatMessageItem, { kind: "run" }>;

/** How a run went, or that its automation is paused, as the dot beside it says it. */
export type RunOutcome =
	| "posted"
	| "nothingToReport"
	| "failed"
	| "running"
	| "cancelled"
	| "paused"
	| "pausedAfterFailures";

const OUTCOME_LABEL: Record<RunOutcome, string> = {
	posted: "Posted",
	nothingToReport: "Nothing to report",
	failed: "Failed",
	running: "Running",
	cancelled: "Cancelled",
	paused: "Paused",
	pausedAfterFailures: "Paused after failures",
};

const OUTCOME_DOT: Record<RunOutcome, string> = {
	posted: "bg-success",
	nothingToReport: "bg-disabled-foreground",
	failed: "bg-destructive-text",
	running: "bg-subtle-foreground",
	cancelled: "bg-disabled-foreground",
	paused: "bg-disabled-foreground",
	pausedAfterFailures: "bg-destructive-text",
};

/**
 * How a run in `state` went, as the dot beside it says it. One that completed
 * without having `posted` a result had nothing to report.
 */
export function outcomeOf(
	state: RunItem["state"],
	posted: boolean,
): Exclude<RunOutcome, "paused" | "pausedAfterFailures"> {
	if (state === "completed") return posted ? "posted" : "nothingToReport";
	if (state === "failed") return "failed";
	if (state === "cancelled") return "cancelled";
	return "running";
}

/** How a run went, or that its automation is paused, as a dot and a word. */
export function RunStatus({ outcome }: { outcome: RunOutcome }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
			<span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", OUTCOME_DOT[outcome])} />
			{OUTCOME_LABEL[outcome]}
		</span>
	);
}

/** The line across the feed where a run starts, naming its day. */
export function RunDivider({ at }: { at: string }) {
	const day = formatDay(new Date(at));
	const words =
		day === "Today" ? "Run today" : day === "Yesterday" ? "Run yesterday" : `Run on ${day}`;
	return <LabelledRule className="pt-4 pb-1.5">{words}</LabelledRule>;
}

/** The line at the foot of an automation's feed saying when it runs next. Nothing while it loads. */
export function NextRunDivider({
	automation,
}: {
	automation: NonNullable<ConversationDetails["automation"]>;
}) {
	const full = useAutomations(automation.projectId).data?.find((one) => one.id === automation.id);
	const words = automation.state === "paused" ? "Paused" : full && nextRunWords(full);
	if (!words) return null;
	return <LabelledRule className="pt-4 pb-1.5">{words}</LabelledRule>;
}

/**
 * A run that posted no result, drawn as its bot's message: what the bot last
 * said in it, or, when it said nothing, how it went and, when it failed, why.
 * A run that completed and said something needs no word on how it went, and
 * one that completed saying nothing had nothing to report. The latest
 * failure, while the automation is still failing, offers to run it again or to
 * see to the connection it needs. One still running says so with dots.
 */
export function RunMessage({
	item,
	bot,
	automation,
	conversationId,
	latest,
	mentionable,
}: {
	item: RunItem;
	bot: BotParticipant;
	automation: Pick<NonNullable<ConversationDetails["automation"]>, "id" | "projectId">;
	conversationId: string;
	/** The newest failure while the automation is still failing, which may be retried. */
	latest: boolean;
	/** Who the report may mention, drawn as chips. */
	mentionable: Participant[];
}) {
	const controls = useAutomationControls(conversationId, automation);
	const owner = useOwnerOfProject(automation.projectId);
	const outcome = outcomeOf(item.state, false);
	const report = item.state === "completed" ? item.report : null;
	return (
		<article
			aria-label={`${item.automationName}: ${OUTCOME_LABEL[outcome]}`}
			className="flex gap-3.5 px-5 pt-3.5 pb-0.5"
		>
			<span aria-hidden className="mt-0.5 flex w-9 shrink-0 justify-center">
				<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={36} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col items-start">
				<div className="flex items-center gap-2 pb-px">
					<span className="font-semibold text-sm text-foreground">{bot.name}</span>
					<span className="rounded bg-chip px-1.25 py-px font-semibold text-2xs text-muted-foreground leading-snug">
						Bot
					</span>
					<span className="text-subtle-foreground text-xs">
						{formatClockTime(new Date(item.createdAt))}
					</span>
					{!report && <RunStatus outcome={outcome} />}
				</div>
				{report ? (
					<div className="min-w-0 self-stretch break-words text-sm text-body-foreground leading-normal">
						<MessageMarkdown text={report} mentionable={mentionable} writer="bot" />
					</div>
				) : outcome === "nothingToReport" ? null : outcome === "running" ? (
					<TypingDots className="mt-2 text-muted-foreground" />
				) : (
					<p className="m-0 text-sm text-body-foreground leading-normal">
						{item.error ??
							(outcome === "cancelled" ? "The run was stopped." : "It posted nothing.")}
					</p>
				)}
				{latest && outcome === "failed" && (
					<div className="mt-2 flex gap-2">
						<Button size="sm" disabled={controls.pending} onClick={() => void controls.runAgain()}>
							Retry
						</Button>
						{owner && (
							<Link
								{...ownerLinkOptions(owner, { page: "connections" })}
								className={buttonStyles({ variant: "secondary", size: "sm" })}
							>
								Fix connection
							</Link>
						)}
					</div>
				)}
			</div>
		</article>
	);
}

/**
 * A failed run, at the top of its own conversation, drawn as it is in its automation's
 * feed: its bot's message saying why, offering to run it again while it is
 * the automation's latest run.
 */
export function FailedRunMessage({
	run,
	projectId,
	bot,
}: {
	run: Run;
	/** The project the automation belongs to, whose run it is. */
	projectId: string;
	bot: BotParticipant;
}) {
	const automation = { id: run.automationId, projectId };
	const latestRun = useRecentRuns({
		projectId,
		automationId: run.automationId,
	}).data?.items[0];
	return (
		<RunMessage
			item={{
				kind: "run",
				id: run.id,
				conversationId: run.conversationId,
				automationName: run.automationName,
				triggerKind: run.trigger.kind,
				state: run.state,
				error: run.error,
				report: null,
				createdAt: run.acceptedAt,
			}}
			bot={bot}
			automation={automation}
			conversationId={run.rootConversationId}
			latest={latestRun?.id === run.id}
			mentionable={[]}
		/>
	);
}

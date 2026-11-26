import {
	type BotParticipant,
	type ChatDetails,
	type ChatMessageItem,
	type Participant,
	textWithoutNarration,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useState } from "react";
import { nextRunWords, useAutomations } from "@/lib/automations.ts";
import { useAutomationControls } from "@/lib/chats.ts";
import { useMarkedConnectors } from "@/lib/connectors.ts";
import { failureMessage } from "@/lib/failure.ts";
import { formatClockTime, formatDay } from "@/lib/list-time.ts";
import { useOwnerOfProject } from "@/lib/owner-of-project.ts";
import { ownerLinkOptions, resourcePermissions } from "@/lib/resource-owner.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { LabelledRule } from "@/ui/labelled-rule.tsx";
import { TitleTag } from "@/ui/title-tag.tsx";
import { TypingDots } from "@/ui/typing-dots.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { WorkedFor } from "./ToolLine.tsx";

/*
 * An automation's feed reads as its runs, one after another: a line naming
 * each run's day, the bot's result under it with how the run went, anything
 * said about it after, and at the foot when it runs next.
 */

type RunItem = Extract<ChatMessageItem, { kind: "run" }>;

/** How a run went, or whether its automation is on or paused, as the dot beside it says it. */
export type RunOutcome =
	| "on"
	| "posted"
	| "nothingToReport"
	| "failed"
	| "running"
	| "cancelled"
	| "paused"
	| "pausedAfterFailures";

/** Each outcome in words, as `RunStatus` says it beside its dot. */
export const RUN_OUTCOME_LABELS: Record<RunOutcome, string> = {
	on: "On",
	posted: "Posted",
	nothingToReport: "Nothing to report",
	failed: "Failed",
	running: "Running",
	cancelled: "Cancelled",
	paused: "Paused",
	pausedAfterFailures: "Paused after failures",
};

const OUTCOME_DOT: Record<RunOutcome, string> = {
	on: "bg-success",
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
): Exclude<RunOutcome, "on" | "paused" | "pausedAfterFailures"> {
	if (state === "completed") return posted ? "posted" : "nothingToReport";
	if (state === "failed") return "failed";
	if (state === "cancelled") return "cancelled";
	return "running";
}

/** How a run went, or whether its automation is on or paused, as a dot and a word. */
export function RunStatus({ outcome }: { outcome: RunOutcome }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
			<span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", OUTCOME_DOT[outcome])} />
			{RUN_OUTCOME_LABELS[outcome]}
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
	automation: NonNullable<ChatDetails["automation"]>;
}) {
	const full = useAutomations(automation.projectId).data?.find((one) => one.id === automation.id);
	const words = automation.state === "paused" ? "Paused" : full && nextRunWords(full);
	if (!words) return null;
	return <LabelledRule className="pt-4 pb-1.5">{words}</LabelledRule>;
}

/**
 * A run that posted no result, drawn as its bot's message: the work its reply
 * did, as a chat's reply shows it, then what the reply said, or, when it said
 * nothing, how it went and, when it failed, why.
 * A run that completed and said something needs no word on how it went, and
 * one that completed saying nothing had nothing to report. The latest
 * failure, while the automation is still failing, offers to run it again or to
 * see to the connector it needs. One still running says so with dots.
 */
export function RunMessage({
	item,
	bot,
	automation,
	chatId,
	latest,
	highlighted = false,
	mentionable,
}: {
	item: RunItem;
	bot: BotParticipant;
	automation: Pick<NonNullable<ChatDetails["automation"]>, "id" | "projectId">;
	chatId: string;
	/** The newest failure while the automation is still failing, which may be retried. */
	latest: boolean;
	/** Pointed out for a moment, as a run jumped to is. */
	highlighted?: boolean;
	/** Who the report may mention, drawn as chips. */
	mentionable: Participant[];
}) {
	const controls = useAutomationControls(chatId, automation);
	const owner = useOwnerOfProject(automation.projectId);
	const markedConnectorsOf = useMarkedConnectors([bot.id], automation.projectId);
	const mayRun = owner !== undefined && resourcePermissions(owner).runAutomations;
	const [retryFailure, setRetryFailure] = useState<unknown>();
	const outcome = outcomeOf(item.state, false);
	async function retry() {
		setRetryFailure(undefined);
		try {
			await controls.runAgain();
		} catch (failure) {
			setRetryFailure(failure);
		}
	}
	// Only what the bot said after its last tool call, as a posted result would be.
	const report =
		(item.state === "completed" && item.reply && textWithoutNarration(item.reply.parts)) || null;
	return (
		<article
			aria-label={`${item.automationName}: ${RUN_OUTCOME_LABELS[outcome]}`}
			data-run-chat-id={item.chatId}
			className={cn(
				"flex gap-3.5 px-5 pt-3.5 pb-0.5 transition-colors duration-700",
				// Lifted on a soft card, as a bot's message pointed out is.
				highlighted && "rounded-xl bg-chip",
			)}
		>
			<span aria-hidden className="mt-0.5 flex w-9 shrink-0 justify-center">
				<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={36} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col items-start">
				<div className="flex items-center gap-2 pb-px">
					<span className="font-semibold text-sm text-foreground">{bot.name}</span>
					<TitleTag>Bot</TitleTag>
					<span className="text-subtle-foreground text-xs">
						{formatClockTime(new Date(item.createdAt))}
					</span>
					{!report && <RunStatus outcome={outcome} />}
				</div>
				{item.reply && (
					<WorkedFor
						message={item.reply}
						markedConnectors={markedConnectorsOf(bot.id)}
						fileNames={NO_FILE_NAMES}
						className="mt-1.5 mb-1.5"
					/>
				)}
				{report ? (
					<div className="min-w-0 self-stretch break-words text-sm text-body-foreground leading-normal">
						<MessageMarkdown text={report} mentionable={mentionable} writer="bot" />
					</div>
				) : outcome === "nothingToReport" ? null : outcome === "running" ? (
					<TypingDots className="mt-2 text-muted-foreground" />
				) : (
					<p className="m-0 text-sm text-body-foreground leading-normal">
						{item.error ??
							(outcome === "cancelled" ? "The run ended early." : "It posted nothing.")}
					</p>
				)}
				{latest && outcome === "failed" && retryFailure !== undefined && (
					<Alert className="mt-2">{failureMessage(retryFailure)}</Alert>
				)}
				{latest && outcome === "failed" && (
					<div className="mt-2 flex gap-2">
						{mayRun && (
							<Button size="sm" disabled={controls.pending} onClick={() => void retry()}>
								Retry
							</Button>
						)}
						{owner && (
							<Link
								{...ownerLinkOptions(owner, { page: "connectors" })}
								className={buttonStyles({ variant: "secondary", size: "sm" })}
							>
								Fix connector
							</Link>
						)}
					</div>
				)}
			</div>
		</article>
	);
}

/** The run's files aren't loaded with its feed, so a call reading one names it by its id. */
const NO_FILE_NAMES: ReadonlyMap<string, string> = new Map();

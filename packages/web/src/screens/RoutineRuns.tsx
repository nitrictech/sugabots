import type { RepositoryEvent, RoutineExecution } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Check, Minus } from "lucide-react";
import { failureMessage } from "@/lib/failure.ts";
import { activityThreadLink } from "@/lib/links.ts";
import { formatClockTime, formatListTime } from "@/lib/list-time.ts";
import { useRecentRuns } from "@/lib/routines.ts";
import { useSession } from "@/lib/session.ts";
import { useWorkspaceMembers } from "@/lib/workspace.ts";
import { Alert } from "@/ui/alert.tsx";
import { SettingsGroup } from "@/ui/settings-page.tsx";
import type { PlacedRoutine } from "./RoutineEditor.tsx";

/**
 * A routine's latest runs, newest first: how each went, when, what started
 * it, and how long it took. Each opens from Inbox, as a page of its own.
 */
export function RecentRuns({ placed }: { placed: PlacedRoutine }) {
	const { routine, agent } = placed;
	const runs = useRecentRuns({ agentId: agent.id, routineId: routine.id });
	const startedBy = useStartedBy(routine.workspaceId);
	if (runs.isPending) return null;

	return (
		<SettingsGroup label="Recent runs">
			{runs.isError ? (
				<Alert className="px-4 py-3">{failureMessage(runs.error)}</Alert>
			) : runs.data.items.length === 0 ? (
				<p className="m-0 px-4 py-3 text-[14px] text-muted-foreground">
					No runs yet. Run now to try it.
				</p>
			) : (
				<ul className="m-0 list-none p-0">
					{runs.data.items.map((run) => (
						<li key={run.id} className="border-border border-b last:border-b-0">
							<Link
								{...activityThreadLink(
									{ pod: placed.pod, conversationId: run.conversationId },
									run.threadId,
								)}
								className="focus-ring flex items-center gap-3 px-4 py-[11px] transition-colors hover:bg-panel"
							>
								<RunStatus state={run.state} />
								<span className="flex min-w-0 flex-1 flex-col gap-px">
									<span className="truncate text-[14px] text-foreground">
										{formatRunTime(new Date(run.acceptedAt), new Date())}
									</span>
									{run.state === "failed" && run.error ? (
										<span className="truncate text-destructive-text text-sm">{run.error}</span>
									) : (
										<span className="truncate text-muted-foreground text-sm">
											{runSource(run, startedBy)}
										</span>
									)}
								</span>
								<span className="shrink-0 text-muted-foreground text-sm tabular-nums">
									{runLength(run)}
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</SettingsGroup>
	);
}

/** Who started a run by hand, by user id: "you", or their name in the workspace. */
function useStartedBy(workspaceId: string): (userId: string) => string {
	const members = useWorkspaceMembers(workspaceId);
	const session = useSession();
	return (userId) => {
		if (userId === session.user?.id) return "you";
		return members.data?.find((member) => member.user.id === userId)?.user.name ?? "someone";
	};
}

/** What started a run: its schedule, its address being called, its repository, or a person. */
function runSource(run: RoutineExecution, startedBy: (userId: string) => string): string {
	switch (run.trigger.kind) {
		case "cron":
			return "Scheduled";
		case "webhook":
			return "Webhook";
		case "github":
			return `${REPOSITORY_EVENT_RUN_LABELS[run.trigger.event]} by ${run.trigger.sender}`;
		case "manual":
			return `Run by ${startedBy(run.trigger.requestedByUserId)}`;
	}
}

/** What happened at a repository, as the line of the run it started says it. */
const REPOSITORY_EVENT_RUN_LABELS: Record<RepositoryEvent, string> = {
	pull_request_opened: "Pull request opened",
	pull_request_review: "Pull request reviewed",
	pull_request_comment: "Pull request comment",
	issue_opened: "Issue opened",
	issue_comment: "Issue comment",
	checks_failed: "Checks failed",
	push: "Pushed",
};

/** When a run was started, with its day: "Today, 22:00", "Yesterday, 9:00", "Mon, 9:00". */
function formatRunTime(at: Date, now: Date): string {
	const day = formatListTime(at, now);
	const clock = formatClockTime(at);
	return day === clock ? `Today, ${clock}` : `${day}, ${clock}`;
}

/** How long a run took, or where it is if it has not ended. */
function runLength(run: RoutineExecution): string {
	if (run.state === "queued") return "Queued";
	if (run.state === "running") return "Running…";
	if (run.state === "cancelled") return "Cancelled";
	if (!run.startedAt || !run.finishedAt) return "";
	return formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime());
}

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** A run's length as people say it: "14s", "2m 5s", "1h 3m". */
function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
	const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
	if (minutes < MINUTES_PER_HOUR) return `${minutes}m ${seconds % SECONDS_PER_MINUTE}s`;
	return `${Math.floor(minutes / MINUTES_PER_HOUR)}h ${minutes % MINUTES_PER_HOUR}m`;
}

/** How a run went, as an 18px dot: a tick, a "!", a ring while it runs, or a dash when it was stopped. */
function RunStatus({ state }: { state: RoutineExecution["state"] }) {
	const label = {
		completed: "Completed",
		failed: "Failed",
		running: "Running",
		queued: "Queued",
		cancelled: "Cancelled",
	}[state];
	return (
		<span
			role="img"
			aria-label={label}
			className={cn(
				"grid size-[18px] shrink-0 place-items-center rounded-full font-bold text-[11px] text-white",
				state === "completed" && "bg-success",
				state === "failed" && "bg-destructive",
				(state === "running" || state === "queued") && "border-2 border-primary",
				state === "queued" && "opacity-50",
				state === "cancelled" && "bg-chip text-muted-foreground",
			)}
		>
			{state === "completed" && <Check aria-hidden size={11} strokeWidth={3.2} />}
			{state === "failed" && "!"}
			{state === "cancelled" && <Minus aria-hidden size={11} strokeWidth={3} />}
		</span>
	);
}

import { botColorVariables } from "@sugabots/avatars";
import type {
	Agent,
	Pod,
	Routine,
	RoutineExecutionState,
	ThreadDetails,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useRoutineControls } from "@/lib/chats.ts";
import { routineSettingsLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { scheduleLabel } from "@/lib/routine-schedule.ts";
import { useRecentRuns, useRoutines } from "@/lib/routines.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { ChatSidebar, SidebarSection } from "./ChatSidebar.tsx";
import { Tools } from "./DetailsSidebar.tsx";

/** How many of a routine's latest runs its Details list. */
const RUNS_SHOWN = 5;

/**
 * A routine beside its own thread: the bot that runs it, whether it is on,
 * the way to run it now or change it, when it runs, what it is told, where
 * its result goes, its latest runs, and the apps it can reach.
 */
export function RoutineDetails({
	agent,
	pod,
	conversationId,
	standing,
	onOpenThread,
	onClose,
}: {
	agent: Agent;
	pod: Pod;
	conversationId: string;
	/** How the routine stands, as its thread knows it. */
	standing: NonNullable<ThreadDetails["routine"]>;
	onOpenThread: (threadId: string) => void;
	onClose: () => void;
}) {
	const routine = useRoutines(agent.id).data?.find((one) => one.id === standing.id);
	const controls = useRoutineControls(conversationId, standing);
	const backToChat = useBackToHere("Chat");
	const mayManage = pod.permissions.manageRoutines;
	return (
		<ChatSidebar label="Details" onClose={onClose}>
			<div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-[18px] pt-5 pb-6">
				<div className="flex items-center gap-3.5" style={botColorVariables(agent.color)}>
					<AgentAvatar
						color={agent.color}
						face={agent.face}
						shape={agent.shape}
						size={48}
						className="shrink-0"
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<h3 className="m-0 truncate font-semibold text-[17px] text-foreground">
							{routine?.name ?? "Routine"}
						</h3>
						<p className="m-0 truncate text-md text-muted-foreground">Runs as {agent.name}</p>
					</div>
				</div>
				<div className="flex items-center gap-3 rounded-[10px] border border-border px-3.5 py-3">
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="font-medium text-[14px] text-foreground">
							{standing.pausedAfterFailures
								? "Paused after two failed runs"
								: standing.state === "paused"
									? "Routine is paused"
									: "Routine is on"}
						</span>
						<span className="text-[13px] text-muted-foreground">
							{standing.state === "paused" ? "Paused" : routine ? nextRunWords(routine) : ""}
						</span>
					</div>
					<Toggle
						label="Routine on"
						checked={standing.state === "enabled"}
						disabled={!mayManage || controls.pending}
						onChange={(on) => void controls.setPaused(!on)}
					/>
				</div>
				<div className="flex gap-2">
					<Button
						className="flex-1"
						disabled={!pod.permissions.runRoutines || controls.pending}
						onClick={() => void controls.runAgain()}
					>
						Run now
					</Button>
					{routine && mayManage && (
						<Link
							{...routineSettingsLink(routine)}
							state={backToChat}
							className={cn(buttonStyles({ variant: "outline" }), "flex-1")}
						>
							Edit routine
						</Link>
					)}
				</div>
				{routine && <RoutineFacts routine={routine} />}
				<RecentRuns routine={standing} onOpenThread={onOpenThread} />
				<Tools pod={pod} agent={agent} />
			</div>
		</ChatSidebar>
	);
}

/** When the routine runs next, in words: its soonest time on a schedule, or what starts it. */
function nextRunWords(routine: Routine): string {
	const [next] = routine.triggers
		.flatMap((trigger) =>
			trigger.kind === "cron" && trigger.nextScheduledAt ? [trigger.nextScheduledAt] : [],
		)
		.sort();
	if (next) return `Next run ${formatListTime(new Date(next), new Date())}`;
	if (routine.triggers.length > 0 && routine.triggers.every(({ kind }) => kind === "webhook")) {
		return "Runs when its address is called";
	}
	return scheduleLabel(routine);
}

/** When the routine runs, what it is told, and where its result goes. */
function RoutineFacts({ routine }: { routine: Routine }) {
	return (
		<>
			<SidebarSection title="Schedule">
				<p className="m-0 px-3.5 py-3 text-[14px] text-foreground">{scheduleLabel(routine)}</p>
			</SidebarSection>
			<SidebarSection title="Instructions">
				<p className="m-0 whitespace-pre-wrap px-3.5 py-3 text-[13.5px] text-foreground leading-[1.55]">
					{routine.instructions}
				</p>
			</SidebarSection>
			<SidebarSection title="Posts to">
				<p className="m-0 px-3.5 py-3 text-[14px] text-foreground">
					{routine.results === "post_to_chat" ? "This thread and the pod's chat" : "This thread"}
				</p>
			</SidebarSection>
		</>
	);
}

/** The routine's latest runs: how each went, when, and why one failed, each opening beside the thread. */
function RecentRuns({
	routine,
	onOpenThread,
}: {
	routine: { id: string; agentId: string };
	onOpenThread: (threadId: string) => void;
}) {
	const runs = useRecentRuns({ agentId: routine.agentId, routineId: routine.id });
	const shown = runs.data?.items.slice(0, RUNS_SHOWN) ?? [];
	if (shown.length === 0) return null;
	return (
		<SidebarSection title="Recent runs">
			<ul className="m-0 list-none p-0">
				{shown.map((run) => (
					<li key={run.id} className="border-border border-b last:border-b-0">
						<button
							type="button"
							onClick={() => onOpenThread(run.threadId)}
							className="focus-ring flex w-full items-center gap-2.5 px-3.5 py-[9px] text-left transition-colors hover:bg-panel"
						>
							<span
								aria-hidden
								className={cn(
									"size-[7px] shrink-0 rounded-full",
									run.state === "failed"
										? "bg-destructive-text"
										: run.state === "completed"
											? "bg-success-text"
											: "bg-subtle-foreground",
								)}
							/>
							<span className="w-[76px] shrink-0 text-[12.5px] text-muted-foreground">
								{formatListTime(new Date(run.acceptedAt), new Date())}
							</span>
							<span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">
								{run.state === "failed" ? (run.error ?? "Failed") : runStateWords(run.state)}
							</span>
						</button>
					</li>
				))}
			</ul>
		</SidebarSection>
	);
}

/** How a run that did not fail stands, in words. */
function runStateWords(state: Exclude<RoutineExecutionState, "failed">): string {
	switch (state) {
		case "completed":
			return "Done";
		case "running":
			return "Running";
		case "queued":
			return "Waiting to start";
		case "cancelled":
			return "Cancelled";
	}
}

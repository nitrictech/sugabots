import type { Agent, Pod, ThreadDetails } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Play } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useRoutineControls } from "@/lib/chats.ts";
import { routineSettingsLink } from "@/lib/links.ts";
import { nextRunAt, scheduleLabel } from "@/lib/routine-schedule.ts";
import { useRecentRuns, useRoutines } from "@/lib/routines.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { ChatSidebar, ShowMore, SidebarSection } from "./ChatSidebar.tsx";
import { outcomeOf, RunStatus } from "./RoutineRun.tsx";

/** Instructions longer than this are folded to three lines until asked for the rest. */
const INSTRUCTIONS_FOLDED_OVER = 160;

/**
 * A routine beside its own thread: whether it is on, with the switch that
 * pauses and resumes it; its bot, when it runs, when it runs next and how its
 * last run went; what it is told; and the ways to run it now or change it.
 */
export function RoutinePanel({
	agent,
	pod,
	conversationId,
	standing,
	onClose,
}: {
	agent: Agent;
	pod: Pod;
	conversationId: string;
	/** How the routine stands, as its thread knows it. */
	standing: NonNullable<ThreadDetails["routine"]>;
	onClose: () => void;
}) {
	const routine = useRoutines(agent.id).data?.find((one) => one.id === standing.id);
	const lastRun = useRecentRuns({ agentId: agent.id, routineId: standing.id }).data?.items[0];
	const controls = useRoutineControls(conversationId, standing);
	const backToRoutine = useBackToHere("Routine");
	const [instructionsOpen, setInstructionsOpen] = useState(false);
	const mayManage = pod.permissions.manageRoutines;
	const active = standing.state === "enabled";
	const schedule = routine && scheduleLabel(routine);
	const next = routine && active ? nextRunAt(routine) : undefined;
	const instructions = routine?.instructions;
	const folds = instructions !== undefined && instructions.length > INSTRUCTIONS_FOLDED_OVER;
	return (
		<ChatSidebar label="Routine" onClose={onClose} headerless className="xl:w-[300px]">
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
				<div className="flex flex-col gap-1 px-5 pt-4 pb-4">
					<div className="flex h-8 items-center gap-2">
						<StatusDot className={active ? "bg-success" : "bg-disabled-foreground"} />
						<span className="flex-1 font-semibold text-[13px] text-foreground">
							{active
								? "Active"
								: standing.pausedAfterFailures
									? "Paused after two failures"
									: "Paused"}
						</span>
						<Toggle
							label="Routine on"
							tooltip={active ? "Pause routine" : "Resume routine"}
							checked={active}
							disabled={!mayManage || controls.pending}
							onChange={(on) => void controls.setPaused(!on)}
						/>
					</div>
					<dl className="m-0 flex flex-col">
						<Fact label="Bot">{agent.name}</Fact>
						{schedule && <Fact label="Schedule">{schedule}</Fact>}
						{next && <Fact label="Next run">{next}</Fact>}
						<Fact label="Last run">
							{lastRun ? <RunStatus outcome={outcomeOf(lastRun.state)} /> : "Not run yet"}
						</Fact>
					</dl>
				</div>
				{instructions && (
					<SidebarSection title="Instructions">
						<p
							className={cn(
								"m-0 whitespace-pre-wrap text-[13px] text-soft-foreground leading-[1.55]",
								folds && !instructionsOpen && "line-clamp-3",
							)}
						>
							{instructions}
						</p>
						{folds && (
							<ShowMore
								open={instructionsOpen}
								onToggle={() => setInstructionsOpen(!instructionsOpen)}
							/>
						)}
					</SidebarSection>
				)}
				<section className="flex flex-col gap-2 border-border border-t px-5 py-4">
					{pod.permissions.runRoutines && (
						<Button
							variant="outline"
							disabled={controls.pending}
							onClick={() => void controls.runAgain()}
						>
							<Play aria-hidden size={12} strokeWidth={2} fill="currentColor" />
							Run now
						</Button>
					)}
					{mayManage && routine && (
						<Link
							{...routineSettingsLink(routine)}
							state={backToRoutine}
							className={buttonStyles({ variant: "outline" })}
						>
							<SettingsIcon size={14} />
							Routine settings
						</Link>
					)}
				</section>
			</div>
		</ChatSidebar>
	);
}

/** One fact about the routine: what it is, at the left, and its value, at the right. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex h-[34px] items-center gap-3 text-[13px]">
			<dt className="flex-1 text-muted-foreground">{label}</dt>
			<dd className="m-0 min-w-0 truncate text-foreground">{children}</dd>
		</div>
	);
}

function StatusDot({ className }: { className: string }) {
	return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", className)} />;
}
